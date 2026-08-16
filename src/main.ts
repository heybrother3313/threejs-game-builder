import * as THREE from 'three';
import { defineQuery, withSystem, type State, type System } from 'vibegame';
import { AnimatedCharacter } from 'vibegame/animation';
import { InputState } from 'vibegame/input';
import { OrbitCamera } from 'vibegame/orbit-camera';
import {
  Body,
  BodyType,
  CharacterController,
  Collider,
  KinematicMove,
  SetLinearVelocity,
} from 'vibegame/physics';
import { Player } from 'vibegame/player';
import {
  AmbientLight,
  DirectionalLight,
  Renderer,
  getRenderingContext,
  getScene,
  threeCameras,
} from 'vibegame/rendering';
import { Transform, WorldTransform } from 'vibegame/transforms';
import {
  buildMode,
  initBuilder,
  selectItems,
  selectionInfo,
  toggleBuildMode,
} from './builder';
import { setPlayerPosProvider } from './assistant';
import { canRedo, canUndo, mark, redo, undo } from './history';
import {
  initCharacterVisual,
  playerHitReact,
  playerSwing,
  setPlayerDead,
  updateCharacterVisual,
} from './character';
import {
  configurePlayerHooks,
  damageNpc,
  isTalking,
  SWING_CONTACT,
  playerIsDead,
  playerMelee,
  npcKey,
  npcRuntime,
  playerHealth,
  updateNpcs,
} from './npc';
import { travelTo, worldName } from './worlds';
import { grantLoot, lootCounts, updateLootPickup } from './loot';
import { initAtmosphere, updateWater } from './atmosphere';
import { initIslandGround } from './ground';
import { aiConfig, runAssistant } from './assistant';
import {
  analyzeAssets,
  beginCarry,
  carryTo,
  endCarry,
  findPickable,
  instantiate,
  loadLevel,
  placed,
  setClip,
  updateLevel,
  type PlacedItem,
  spawnPoint,
  groundHeightAt,
  reseatOnGround,
} from './level';

/**
 * Crash-style chase camera, keyboard only.
 *
 * The engine's movement is camera-relative: processInput(moveY, moveX, yaw)
 * sends W straight away from the camera and A/D perpendicular to it. That makes
 * a hard-locked camera impossible to combine with strafing — strafe moves you
 * sideways, the lock swings the camera to follow, which redefines "sideways",
 * and you orbit forever. So we change what left/right MEAN: A/D steer a
 * heading instead of strafing. The camera is pinned to that heading, and W
 * always runs directly away from it. No mouse needed.
 */

/** Steering rate, rad/s. ~2.4 is a comfortable go-kart arc. */
const TURN_RATE = 2.4;

/** Raft patrol along X. `speed` is PEAK drift speed (units/s). */
const RAFT = { minX: -5, maxX: 6, speed: 2.2, y: 2.6, z: 3.5 };
const RAFT_MID = (RAFT.minX + RAFT.maxX) / 2;
const RAFT_AMP = (RAFT.maxX - RAFT.minX) / 2;
const RAFT_OMEGA = RAFT.speed / RAFT_AMP;

/** Carry/throw tuning. */
const CARRY = {
  reach: 2.6,
  facingDot: 0.25,
  offsetForward: 0.75,
  minForward: 0.25,
  blockedLift: 1.15,
  offsetUp: 0.55,
  throwSpeed: 11,
  throwLift: 4.5,
  dropSpeed: 1.2,
  /** Drift-correction rate for the carried yaw; feed-forward does the work. */
  yawSmoothing: 7,
};

const playerQuery = defineQuery([Player, InputState]);
const cameraQuery = defineQuery([OrbitCamera]);
const carriableQuery = defineQuery([Body, Renderer, Transform]);
const staticQuery = defineQuery([Collider, Transform, Body]);

/** World-space direction the player is driving, radians. */
let heading = 0;
let raftPhase = 0;
/** Last frame's raw A/D, kept because SteerSystem consumes the input. */
let steerInput = 0;
/** Smoothed yaw the carried item is drawn with, radians. */
let carryYaw = 0;
/** A motionless rider's offset on the deck, used to spot dropped carry steps. */
let deckOffset: { platform: number; dx: number; dz: number } | null = null;
/** Below this the rider is considered settled; above it, a carry was missed. */
const SLIP_TOLERANCE = 0.02;

type HeldSpec = {
  shape: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  color: number;
};
let heldEntity: number | null = null;
let heldSpec: HeldSpec | null = null;
/** A carried kit prop (GLB), as opposed to a primitive crate. */
let heldItem: PlacedItem | null = null;
let wantsGrab = false;
let wantsThrow = false;

/** A thrown punch waiting to connect. */
let pendingPunch: { t: number; fx: number; fz: number } | null = null;

/** Last drawn player position, for input handlers that run outside systems. */
const lastPlayerPos = new THREE.Vector3();

window.addEventListener('keydown', (e) => {
  if (e.repeat || buildMode) return;
  // Conversation gets first refusal on keys: E talks to a nearby NPC rather
  // than grabbing, and F answers "follow me" instead of throwing.
  if (npcKey(e.code, lastPlayerPos)) return;
  if (e.code === 'KeyE') wantsGrab = true;
  else if (e.code === 'KeyF') wantsThrow = true;
});

/** #rrggbb for a packed ui32 colour, so respawns keep the original look. */
const hexColor = (c: number) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

/** The engine's euler fields are DEGREES; every other angle here is radians. */
const toDegrees = (rad: number) => (rad * 180) / Math.PI;

/** Yaw of an entity's final drawn orientation. */
const yawOfWorld = (e: number) =>
  Math.atan2(
    2 * (WorldTransform.rotW[e] * WorldTransform.rotY[e] +
      WorldTransform.rotX[e] * WorldTransform.rotZ[e]),
    1 - 2 * (WorldTransform.rotY[e] * WorldTransform.rotY[e] +
      WorldTransform.rotX[e] * WorldTransform.rotX[e])
  );

/**
 * Undo dropped carry steps on a moving platform. The engine's platform carry
 * occasionally contributes nothing for a single step (~1% of steps); ground
 * contact is never lost. Correct only those discrete misses, at the START of
 * the step (before the physics snapshot), or the fix itself renders as a pop.
 * Do NOT correct continuously — writing Body.pos every step fights the
 * character controller at 50Hz and shakes violently.
 */
const PlatformSlipSystem: System = {
  group: 'fixed',
  first: true,
  update: (state: State) => {
    for (const player of playerQuery(state.world)) {
      const platform = CharacterController.platform[player];
      const idle = InputState.moveY[player] === 0 && steerInput === 0;
      const ridable =
        platform !== 0 &&
        state.exists(platform) &&
        Body.type[platform] === BodyType.KinematicVelocityBased;

      if (!ridable || !idle || CharacterController.grounded[player] !== 1) {
        deckOffset = null;
        continue;
      }
      const dx = Body.posX[player] - Body.posX[platform];
      const dz = Body.posZ[player] - Body.posZ[platform];
      if (deckOffset === null || deckOffset.platform !== platform) {
        deckOffset = { platform, dx, dz };
        continue;
      }
      const errX = dx - deckOffset.dx;
      const errZ = dz - deckOffset.dz;
      if (Math.abs(errX) > SLIP_TOLERANCE || Math.abs(errZ) > SLIP_TOLERANCE) {
        Body.posX[player] -= errX;
        Body.posZ[player] -= errZ;
      } else {
        deckOffset = { platform, dx, dz };
      }
    }
  },
};

/** Convert A/D into steering before the engine can read it as strafe. */
const SteerSystem: System = {
  group: 'fixed',
  first: true,
  update: (state: State) => {
    const dt = state.time.fixedDeltaTime;
    for (const player of playerQuery(state.world)) {
      if (buildMode) {
        InputState.moveX[player] = 0;
        InputState.moveY[player] = 0;
        steerInput = 0;
        continue;
      }
      if (isTalking() || playerIsDead()) {
        InputState.moveX[player] = 0;
        InputState.moveY[player] = 0;
        steerInput = 0;
        continue;
      }
      const turn = InputState.moveX[player];
      steerInput = turn;
      // Camera yaw and world heading run opposite ways: forward is
      // (-sin yaw, -cos yaw), so steering right means DECREASING yaw.
      if (turn !== 0) heading -= turn * TURN_RATE * dt;
      InputState.moveX[player] = 0;
    }
  },
};

/**
 * Steering must not read as walking. The animator treats any moveX as walking
 * and runs in `simulation`, while SteerSystem clears moveX in `fixed` — a
 * group that can run zero times in a frame. Clear it again here so turning is
 * a quiet pivot. In build mode, freeze all movement input.
 */
const SteerAnimationGuard: System = {
  group: 'simulation',
  first: true,
  update: (state: State) => {
    for (const player of playerQuery(state.world)) {
      InputState.moveX[player] = 0;
      if (buildMode || playerIsDead()) {
        InputState.moveY[player] = 0;
        InputState.jump[player] = 0;
      }
    }
  },
};

/**
 * Drift the raft by writing KinematicMove — a target position the engine
 * turns into real linear velocity for a velocity-based body. Position tweens
 * teleport the collider (velocity stays zero) and the platform-carry logic
 * never fires. Cosine patrol keeps acceleration finite at the turnarounds.
 */
const RaftSystem: System = {
  group: 'fixed',
  first: true,
  update: (state: State) => {
    const raft = state.getEntityByName('raft');
    if (raft === null) return;
    if (!state.hasComponent(raft, KinematicMove)) {
      state.addComponent(raft, KinematicMove);
    }
    raftPhase += RAFT_OMEGA * state.time.fixedDeltaTime;
    KinematicMove.x[raft] = RAFT_MID + RAFT_AMP * Math.cos(raftPhase);
    KinematicMove.y[raft] = RAFT.y;
    KinematicMove.z[raft] = RAFT.z;
  },
};

/**
 * Pin the camera to the heading; turn the character on the spot while
 * steering with no throttle (gated on steering so releasing S doesn't yank
 * the character back around). Skipped in build mode so the mouse can orbit.
 */
const ChaseCameraSystem: System = {
  group: 'simulation',
  last: true,
  update: (state: State) => {
    if (buildMode) return;
    for (const cam of cameraQuery(state.world)) {
      OrbitCamera.currentYaw[cam] = heading;
      OrbitCamera.targetYaw[cam] = heading;
    }
    if (steerInput === 0) return;
    const half = (heading + Math.PI) / 2;
    for (const player of playerQuery(state.world)) {
      if (InputState.moveY[player] !== 0) continue;
      Body.rotX[player] = 0;
      Body.rotY[player] = Math.sin(half);
      Body.rotZ[player] = 0;
      Body.rotW[player] = Math.cos(half);
    }
  },
};

/**
 * Where the held item can sit without poking through level geometry: sweep
 * from "out front" toward "raised overhead" until clear (AABB tests against
 * static colliders).
 */
function carryPose(
  state: State,
  player: number,
  fx: number,
  fz: number,
  spec: HeldSpec
) {
  const isSphere = spec.shape === 1;
  const halfX = (isSphere ? spec.sizeX : spec.sizeX) / 2;
  const halfY = (isSphere ? spec.sizeX : spec.sizeY) / 2;
  const halfZ = (isSphere ? spec.sizeX : spec.sizeZ) / 2;
  const px = WorldTransform.posX[player];
  const py = WorldTransform.posY[player];
  const pz = WorldTransform.posZ[player];

  const blocked = (cx: number, cy: number, cz: number) => {
    for (const solid of staticQuery(state.world)) {
      if (solid === player || Body.type[solid] !== BodyType.Fixed) continue;
      if (
        Math.abs(cx - Transform.posX[solid]) < halfX + Collider.sizeX[solid] / 2 &&
        Math.abs(cy - Transform.posY[solid]) < halfY + Collider.sizeY[solid] / 2 &&
        Math.abs(cz - Transform.posZ[solid]) < halfZ + Collider.sizeZ[solid] / 2
      ) {
        return true;
      }
    }
    return false;
  };

  const STEPS = 8;
  let pose = { x: px, y: py + CARRY.offsetUp, z: pz };
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const reach = CARRY.offsetForward + t * (CARRY.minForward - CARRY.offsetForward);
    const rise = CARRY.offsetUp + t * CARRY.blockedLift;
    pose = { x: px + fx * reach, y: py + rise, z: pz + fz * reach };
    if (!blocked(pose.x, pose.y, pose.z)) return pose;
  }
  return pose; // nothing clear — hold it overhead
}

/** Recipe attributes that rebuild a held item as a real physics object. */
function spawnAttrs(spec: HeldSpec, x: number, y: number, z: number) {
  const isSphere = spec.shape === 1;
  return {
    pos: `${x} ${y} ${z}`,
    shape: isSphere ? 'sphere' : 'box',
    size: isSphere ? `${spec.sizeX}` : `${spec.sizeX} ${spec.sizeY} ${spec.sizeZ}`,
    color: hexColor(spec.color),
  };
}

/** "E — Sail to…" pill, shown while standing by a portal. */
let travelEl: HTMLDivElement | null = null;
function showTravelPrompt(label: string | null) {
  if (!travelEl) {
    travelEl = document.createElement('div');
    travelEl.style.cssText =
      'position:fixed;left:50%;bottom:76px;transform:translateX(-50%);' +
      'font-family:var(--font-body);font-size:var(--text-label-sm);font-weight:600;' +
      // Portal-blue, matching the ring under the piece — NOT the control
      // bar's paper, or the prompt disappears into the toolbar below it.
      'color:var(--text-primary);background:#d6ebfb;' +
      'border:var(--border-w) solid var(--border-strong);border-radius:var(--radius-md);' +
      'box-shadow:0 var(--press-rest) 0 var(--border-strong);padding:7px 14px;z-index:11;';
    document.body.appendChild(travelEl);
  }
  travelEl.style.display = label ? '' : 'none';
  if (label) travelEl.textContent = label;
}

/** The portal the player is standing by, if any. Same reach rules as combat:
 *  flat distance plus a height gate, so a deck above you isn't "here". */
function nearbyExit(px: number, py: number, pz: number) {
  for (const item of placed) {
    if (!item.entry.exitTo) continue;
    const d = Math.hypot(item.entry.x - px, item.entry.z - pz);
    // Portals are big (ships); measure to the near edge, not the centre.
    const { size } = (() => {
      const b = new THREE.Box3().setFromObject(item.obj);
      return { size: b.getSize(new THREE.Vector3()) };
    })();
    const reach = Math.max(size.x, size.z) / 2 + 1.6;
    if (d < reach && Math.abs(item.obj.position.y - py) < 3) return item;
  }
  return null;
}

let travelingNow = false;

/**
 * Pick up (E), put down (E), throw (F). A held object stops being a physics
 * object: it's destroyed and replaced by a render-only stand-in riding the
 * hand position, then rebuilt as a fresh dynamic body on release.
 */
const CarrySystem: System = {
  group: 'simulation',
  update: (state: State) => {
    if (buildMode) {
      wantsGrab = wantsThrow = false;
      return;
    }
    const players = playerQuery(state.world);
    if (players.length === 0) {
      wantsGrab = wantsThrow = false;
      return;
    }
    const player = players[0];

    const charYaw = Math.atan2(
      2 * (Transform.rotW[player] * Transform.rotY[player] +
        Transform.rotX[player] * Transform.rotZ[player]),
      1 - 2 * (Transform.rotY[player] * Transform.rotY[player] +
        Transform.rotX[player] * Transform.rotX[player])
    );
    const fx = Math.sin(charYaw);
    const fz = Math.cos(charYaw);
    const handX = Transform.posX[player] + fx * CARRY.offsetForward;
    const handY = Transform.posY[player] + CARRY.offsetUp;
    const handZ = Transform.posZ[player] + fz * CARRY.offsetForward;

    const release = (speed: number, lift: number) => {
      if (heldEntity === null || heldSpec === null) return;
      state.destroyEntity(heldEntity);
      const spawned = state.createFromRecipe(
        'dynamic-part',
        spawnAttrs(heldSpec, handX + fx * 0.3, handY, handZ + fz * 0.3)
      );
      const half = charYaw / 2;
      Body.rotX[spawned] = 0;
      Body.rotY[spawned] = Math.sin(half);
      Body.rotZ[spawned] = 0;
      Body.rotW[spawned] = Math.cos(half);
      Body.eulerY[spawned] = toDegrees(charYaw);
      state.addComponent(spawned, SetLinearVelocity, {
        x: fx * speed,
        y: lift,
        z: fz * speed,
      });
      heldEntity = null;
      heldSpec = null;
    };

    // Kit props flagged `pickable` in the builder take priority over the
    // primitive crates: they're what the level author marked as interactive.
    const releaseItem = (speed: number, lift: number) => {
      if (!heldItem) return;
      endCarry(
        state,
        heldItem,
        speed > 0 || lift > 0
          ? { vx: fx * speed, vy: lift, vz: fz * speed }
          : null,
        0
      );
      heldItem = null;
    };

    if (wantsThrow && heldItem) {
      releaseItem(CARRY.throwSpeed, CARRY.throwLift);
      wantsGrab = wantsThrow = false;
      return;
    }
    // Empty-handed F is a punch. Same button, context decides — you either
    // throw what you're carrying or swing at what's in front of you.
    if (wantsThrow && heldItem === null && heldEntity === null) {
      // Swing now, connect partway through — matching how NPC blows land, and
      // how it reads on screen.
      playerSwing();
      pendingPunch = { t: SWING_CONTACT, fx, fz };
      wantsGrab = wantsThrow = false;
      return;
    }
    // The sea has no floor now (the aprons were secretly one). Walking off
    // the island drops you in; the tide puts you back on the spawn flag.
    if (Body.posY[player] < -6) {
      const v = spawnPoint();
      Body.posX[player] = v.x;
      Body.posY[player] = v.y;
      Body.posZ[player] = v.z;
      Body.velX[player] = Body.velY[player] = Body.velZ[player] = 0;
    }

    // Treasure scoops itself — no button, just walk over it.
    updateLootPickup(
      state, Transform.posX[player], Transform.posY[player], Transform.posZ[player]);

    // Standing by a portal, E means travel — it outranks pickup because the
    // portal is a deliberate destination and the barrel next to it isn't.
    const exit = travelingNow
      ? null
      : nearbyExit(Transform.posX[player], Transform.posY[player], Transform.posZ[player]);
    showTravelPrompt(
      exit
        ? `E — ${exit.entry.exitLabel ?? `Travel to ${worldName(exit.entry.exitTo!)}`}`
        : null
    );
    if (wantsGrab && exit) {
      wantsGrab = wantsThrow = false;
      if (heldItem) releaseItem(0, 0); // what you carry stays on its island
      travelingNow = true;
      const dest = exit.entry.exitTo!;
      void travelTo(state, dest).then((spawnV) => {
        travelingNow = false;
        if (!spawnV) return;
        for (const p of playerQuery(state.world)) {
          Body.posX[p] = spawnV.x;
          Body.posY[p] = spawnV.y;
          Body.posZ[p] = spawnV.z;
          Body.velX[p] = Body.velY[p] = Body.velZ[p] = 0;
        }
        configurePlayerHooks({ spawn: spawnV });
      });
      return;
    }

    if (wantsGrab && heldItem) {
      releaseItem(0, 0);
      wantsGrab = wantsThrow = false;
      return;
    }
    if (wantsGrab && heldEntity === null) {
      const prop = findPickable(
        Transform.posX[player],
        Transform.posZ[player],
        fx,
        fz,
        CARRY.reach,
        Transform.posY[player]
      );
      if (prop) {
        beginCarry(state, prop);
        heldItem = prop;
        wantsGrab = wantsThrow = false;
        return;
      }
    }

    if (wantsThrow && heldEntity !== null) {
      release(CARRY.throwSpeed, CARRY.throwLift);
    } else if (wantsGrab) {
      if (heldEntity !== null) {
        release(CARRY.dropSpeed, 0);
      } else {
        let best: number | null = null;
        let bestDist = CARRY.reach;
        for (const item of carriableQuery(state.world)) {
          if (item === player || Body.type[item] !== BodyType.Dynamic) continue;
          const dx = Transform.posX[item] - Transform.posX[player];
          const dy = Transform.posY[item] - Transform.posY[player];
          const dz = Transform.posZ[item] - Transform.posZ[player];
          if (Math.abs(dy) > 1.6) continue;
          const dist = Math.hypot(dx, dz);
          if (dist > bestDist || dist < 1e-3) continue;
          if ((dx / dist) * fx + (dz / dist) * fz < CARRY.facingDot) continue;
          best = item;
          bestDist = dist;
        }
        if (best !== null) {
          heldSpec = {
            shape: Renderer.shape[best],
            sizeX: Renderer.sizeX[best],
            sizeY: Renderer.sizeY[best],
            sizeZ: Renderer.sizeZ[best],
            color: Renderer.color[best],
          };
          state.destroyEntity(best);
          const visual = state.createEntity();
          state.addComponent(visual, Transform, {
            posX: handX,
            posY: handY,
            posZ: handZ,
            eulerY: toDegrees(charYaw),
            rotW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          });
          state.addComponent(visual, Renderer, {
            shape: heldSpec.shape,
            sizeX: heldSpec.sizeX,
            sizeY: heldSpec.sizeY,
            sizeZ: heldSpec.sizeZ,
            color: heldSpec.color,
            visible: 1,
          });
          heldEntity = visual;
          carryYaw = charYaw;
        }
      }
    }
    wantsGrab = wantsThrow = false;
  },
};

/**
 * Put the held item where the character is actually drawn this frame (draw
 * group — after every simulation write, before the renderer). The character's
 * rotation advances in discrete fixed steps; feed-forward from the steering
 * rate keeps the item's motion uniform, with a low-rate correction so it can't
 * drift and still follows engine-driven rotation while walking.
 */
const CarryPlacementSystem: System = {
  group: 'draw',
  first: true,
  update: (state: State) => {
    if (heldEntity === null || heldSpec === null || !state.exists(heldEntity)) return;
    const players = playerQuery(state.world);
    if (players.length === 0) return;
    const player = players[0];

    const dt = state.time.deltaTime;
    carryYaw -= steerInput * TURN_RATE * dt;
    const targetYaw = yawOfWorld(player);
    let delta = (targetYaw - carryYaw) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    carryYaw += delta * (1 - Math.exp(-CARRY.yawSmoothing * dt));

    const fx = Math.sin(carryYaw);
    const fz = Math.cos(carryYaw);
    const pose = carryPose(state, player, fx, fz, heldSpec);
    const half = carryYaw / 2;
    const qy = Math.sin(half);
    const qw = Math.cos(half);
    for (const c of [Transform, WorldTransform]) {
      c.posX[heldEntity] = pose.x;
      c.posY[heldEntity] = pose.y;
      c.posZ[heldEntity] = pose.z;
      c.rotX[heldEntity] = 0;
      c.rotY[heldEntity] = qy;
      c.rotZ[heldEntity] = 0;
      c.rotW[heldEntity] = qw;
    }
    Transform.eulerY[heldEntity] = toDegrees(carryYaw);
  },
};

/**
 * Lift the scene out of the murk.
 *
 * The stock lighting is a dim hemisphere plus one hard directional, so
 * textured models — Anne especially — render far darker than their source art
 * and read as silhouettes against pale sand. Raising the ambient term is what
 * actually fixes readability (the directional only lights one side), and a
 * touch of exposure keeps the kit's saturated colours from going muddy. A
 * fill light from the opposite side stops shadowed faces going black.
 */
function brightenScene(state: State) {
  const ambientQuery = defineQuery([AmbientLight]);
  for (const e of ambientQuery(state.world)) {
    AmbientLight.intensity[e] = 2.6;
    AmbientLight.skyColor[e] = 0xdcefff;
    AmbientLight.groundColor[e] = 0xd9c39a;
  }
  const dirQuery = defineQuery([DirectionalLight]);
  for (const e of dirQuery(state.world)) {
    DirectionalLight.intensity[e] = 2.1;
  }
  const ctx = getRenderingContext(state);
  if (ctx.renderer) ctx.renderer.toneMappingExposure = 1.15;
  const scene = getScene(state);
  if (scene) {
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-6, 7, -5);
    scene.add(fill);
  }
}

/** Anne, raft riders, NPC clips and thrown props, once per rendered frame. */
const playerPosScratch = new THREE.Vector3();
const VisualsSystem: System = {
  group: 'draw',
  update: (state: State) => {
    updateWater();
    const p0 = playerQuery(state.world)[0];
    const playerPos =
      p0 !== undefined
        ? playerPosScratch.set(
            WorldTransform.posX[p0],
            WorldTransform.posY[p0],
            WorldTransform.posZ[p0]
          )
        : undefined;
    const dt = Math.min(state.time.deltaTime, 0.05);
    updateLevel(state, dt, playerPos);
    if (playerPos) lastPlayerPos.copy(playerPos);
    if (pendingPunch && p0 !== undefined) {
      pendingPunch.t -= dt;
      if (pendingPunch.t <= 0) {
        playerMelee(
          state,
          Transform.posX[p0],
          Transform.posY[p0],
          Transform.posZ[p0],
          pendingPunch.fx,
          pendingPunch.fz
        );
        pendingPunch = null;
      }
    }
    updateNpcs(state, dt, playerPos, !buildMode);
    const players = playerQuery(state.world);
    if (players.length > 0) updateCharacterVisual(state, players[0]);

    // A carried kit prop rides the same hand point as primitive pickups.
    if (heldItem && players.length > 0) {
      const player = players[0];
      const yaw = yawOfWorld(player);
      carryTo(
        heldItem,
        WorldTransform.posX[player] + Math.sin(yaw) * CARRY.offsetForward,
        WorldTransform.posY[player] + CARRY.offsetUp,
        WorldTransform.posZ[player] + Math.cos(yaw) * CARRY.offsetForward,
        yaw
      );
    }
  },
};

withSystem(PlatformSlipSystem)
  .withSystem(SteerSystem)
  .withSystem(SteerAnimationGuard)
  .withSystem(RaftSystem)
  .withSystem(CarrySystem)
  .withSystem(CarryPlacementSystem)
  .withSystem(VisualsSystem)
  .withSystem(ChaseCameraSystem)
  .run()
  .then(async (runtime) => {
    const state = runtime.getState();

    // The raft keeps its kinematic box for physics; its visual is a GLB.
    // Shrink the placeholder to nothing rather than removing the component:
    // removing it strands the slot in the instanced mesh and the old brown
    // slab keeps drawing where it last was.
    const raftE = state.getEntityByName('raft');
    if (raftE !== null && state.hasComponent(raftE, Renderer)) {
      Renderer.sizeX[raftE] = 0.0001;
      Renderer.sizeY[raftE] = 0.0001;
      Renderer.sizeZ[raftE] = 0.0001;
    }

    brightenScene(state);
    initAtmosphere(state);
    initIslandGround(state);

    await loadLevel(state);

    const players = playerQuery(state.world);
    if (players.length > 0) {
      await initCharacterVisual(state, players[0]);
    }

    // NPCs shove and respawn the player through these; the character is a
    // Rapier controller, so position writes are the channel that works.
    // Start at the level's spawn flag (and go back there on death).
    const bootSpawn = spawnPoint();
    for (const p of playerQuery(state.world)) {
      Body.posX[p] = bootSpawn.x;
      Body.posY[p] = bootSpawn.y;
      Body.posZ[p] = bootSpawn.z;
    }
    configurePlayerHooks({
      spawn: bootSpawn,
      push: (dx, dz) => {
        for (const p of playerQuery(state.world)) {
          Body.posX[p] += dx;
          Body.posZ[p] += dz;
        }
      },
      death: (dying) => setPlayerDead(dying),
      hit: () => playerHitReact(),
      teleport: (x, y, z) => {
        for (const p of playerQuery(state.world)) {
          Body.posX[p] = x;
          Body.posY[p] = y;
          Body.posZ[p] = z;
          Body.velX[p] = 0;
          Body.velY[p] = 0;
          Body.velZ[p] = 0;
        }
      },
    });

    // Let the assistant place things relative to where you're standing.
    setPlayerPosProvider(() => ({
      x: lastPlayerPos.x,
      z: lastPlayerPos.z,
      facingX: -Math.sin(heading),
      facingZ: -Math.cos(heading),
    }));

    initBuilder(state, () => cameraQuery(state.world)[0]);

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__game = {
        runtime,
        state,
        scene: getScene(state),
        components: {
          OrbitCamera, Player, InputState, Transform, Body, Renderer,
          AnimatedCharacter, CharacterController, Collider,
        },
        queries: { playerQuery, cameraQuery },
        getHeading: () => heading,
        setHeading: (h: number) => {
          heading = h;
        },
        getHeld: () => heldEntity,
        press: (key: 'grab' | 'throw') => {
          if (key === 'grab') wantsGrab = true;
          else wantsThrow = true;
        },
        toggleBuildMode,
        analyzeAssets,
        placed,
        ground: { groundHeightAt, reseatOnGround: () => reseatOnGround(state) },
        instantiate: (entry: Parameters<typeof instantiate>[1]) => instantiate(state, entry),
        setClip,
        getCamera: () => threeCameras.get(cameraQuery(state.world)[0]),
        // The app's own NPC functions — importing npc.ts from a console eval
        // yields a SEPARATE module instance, so flags set there are invisible
        // to the running game.
        npc: { npcKey, npcRuntime, damageNpc, playerHealth, playerMelee, updateNpcs },
        worlds: { travelTo: (id: string) => travelTo(state, id) },
        ai: { run: (req: string) => runAssistant(state, aiConfig(), req) },
        loot: { grantLoot, lootCounts, updateLootPickup: (x: number, y: number, z: number) => updateLootPickup(state, x, y, z) },
        history: { mark, undo, redo, canUndo, canRedo },
        selectionInfo,
        selectItems,
      };
    }
  });
