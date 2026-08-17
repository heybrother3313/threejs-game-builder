import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { State } from 'vibegame';
import { AnimatedCharacter } from 'vibegame/animation';
import { Renderer, getScene } from 'vibegame/rendering';
import { Body, CharacterController } from 'vibegame/physics';
import { attachWeaponToHand, fitFor } from './weapons';
import { Transform, WorldTransform } from 'vibegame/transforms';

/**
 * The player's visual — Punk (Ultimate Modular Women Pack).
 *
 * Swapped off the pirate-kit characters because the modular People packs are a
 * different art style, and once the world is populated with them the player has
 * to match the crowd rather than the props.
 *
 * The engine's procedural blocky character keeps doing everything it already
 * does — physics, input, the animationState machine — we only take away its
 * body-part renderers and draw Anne at the player's transform instead. Her
 * clips are driven by the engine's own animationState, so jumps/falls/landings
 * stay in sync with the physics without re-deriving any of it.
 */

/**
 * Candidate player models — packs whose clip sets cover what the engine's
 * animation states ask for. The Monsters bundle is the best match: its clips
 * are literally named Idle / Walk / Run / Jump / Jump_Idle / Jump_Land, the
 * same states the engine drives, so nothing has to be approximated.
 */
/**
 * Playable characters, chosen by MEASUREMENT rather than by eye.
 *
 * A player character needs the full clip set the game drives — Idle, Walk,
 * Run, Jump, Jump_Idle, Jump_Land, Death, Punch, Weapon, HitReact — and a
 * right-hand rig to hang a weapon on.
 *
 * The pack ships SOME creatures twice, and the copies are not equal: the plain
 * name is a nine-clip export with Bite_Front and no hands, while the
 * hash-suffixed duplicate is the full fourteen-clip rig. Alien, Fish and Yeti
 * are only playable as their suffixed versions — which is why they looked
 * unusable at first glance and are listed with the ugly filenames here.
 */
export const PLAYER_CHOICES: { label: string; src: string; art: string }[] = [
  { label: 'Frog', src: '/models/ultimate-monsters/Frog.glb', art: 'frog' },
  { label: 'Dino', src: '/models/ultimate-monsters/Dino.glb', art: 'dino' },
  { label: 'Monkroose', src: '/models/ultimate-monsters/Monkroose.glb', art: 'monkroose' },
  { label: 'Alien', src: '/models/ultimate-monsters/Alien-RRliSQBP7r.glb', art: 'alien' },
  { label: 'Fish', src: '/models/ultimate-monsters/Fish-ypEYhCImAB.glb', art: 'fish' },
  { label: 'Yeti', src: '/models/ultimate-monsters/Yeti-ceRHrn8HHE.glb', art: 'yeti' },
];

/**
 * Portrait for a character, or null if none has been dropped in yet.
 *
 * Tries png then jpg and resolves to null when neither loads, so the picker
 * degrades to a rendered thumbnail of the model rather than a broken image —
 * a partial set of art is fine.
 */
export async function portraitFor(art: string): Promise<string | null> {
  for (const ext of ['png', 'jpg']) {
    const url = `/ui/characters/${art}.${ext}`;
    const ok = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (ok) return url;
  }
  return null;
}

/**
 * Orc, Blue Demon, Mushroom King and Bunny pass the clip test but are not
 * offered as players: they ship holding a weapon as part of the mesh, so
 * whatever you picked up would be a second one they could never put down.
 * They stay as enemies, where being permanently armed is the point.
 */

const PLAYER_KEY = 'sandbox-player-model';
export function playerModel() {
  return localStorage.getItem(PLAYER_KEY) ?? PLAYER_CHOICES[0].src;
}
export function setPlayerModel(src: string) {
  localStorage.setItem(PLAYER_KEY, src);
}
/**
 * Use a pack that animates jumps natively rather than retargeting one in.
 *
 * Borrowing a jump from a donor rig technically works — the skeletons share
 * bone names — but even rotation-only retargeting looks wrong, because the
 * two rigs differ in rest pose and limb proportion. The Animated packs ship
 * Idle/Walk/Run/Jump/RunningJump/Death on one rig, so the player uses those
 * and every pose is authored for the body wearing it.
 */
const CHARACTER_HEIGHT = 1.55;

/** clip name segments look like "CharacterArmature|...|Walk|..." — match the
 *  exact segment, not a substring, or "Jump_Idle" would match "Idle". */
function findClip(clips: THREE.AnimationClip[], segment: string) {
  return clips.find((c) => c.name.split('|').includes(segment)) ?? null;
}

// Engine animation states (AnimatedCharacter.animationState values).
const STATE_CLIP: Record<number, string> = {
  0: 'Idle',
  1: 'Walk',
  2: 'Jump',
  3: 'Jump_Idle',
  4: 'Jump_Land',
  /** Not an engine state — ours, for sprinting. */
  5: 'Run',
};

let mixer: THREE.AnimationMixer | null = null;
let actions: Record<string, THREE.AnimationAction> = {};
let current: THREE.AnimationAction | null = null;
let currentState = -1;
/** While true the death clip owns the rig and the state machine is ignored. */
let dead = false;
/** Seconds left in a melee swing; the state machine is ignored while it runs. */
let swingT = 0;
/**
 * True only while a MELEE SWING owns the rig (not a flinch).
 *
 * Your own attack outranks being hit. Standing close enough to trade blows
 * meant the enemy's hit landed mid-punch, HitReact took the rig, and the
 * swing visibly died halfway — which reads as the punch failing to fire, not
 * as a flinch. The blow still lands and the damage still applies; only the
 * flinch animation is skipped.
 */
let swinging = false;

let player: THREE.Group | null = null;
/** Eased draw height; see updateCharacterVisual. */
let smoothY: number | null = null;
/** How long the engine has reported the player airborne, and the last
 *  grounded state to hold onto while that's still in doubt. */
let airborneT = 0;
let groundedState = 0;
let baseOffsetY = 0;
const clock = new THREE.Clock();

export async function initCharacterVisual(state: State, playerEntity: number) {
  const scene = getScene(state);
  if (!scene) return;

  const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
    (resolve, reject) =>
      new GLTFLoader().load(playerModel(), resolve, undefined, reject)
  );

  player = gltf.scene;
  player.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.frustumCulled = false; // skinned bounds are bind-pose; don't let it cull mid-jump
      // Hair and cloth are single-sided planes; without this they disappear
      // whenever she turns away from the camera.
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (mat) {
          mat.side = THREE.DoubleSide;
          mat.shadowSide = THREE.FrontSide;
        }
      }
    }
  });

  // Fit to gameplay size, feet at origin.
  const box = new THREE.Box3().setFromObject(player);
  const size = box.getSize(new THREE.Vector3());
  const s = CHARACTER_HEIGHT / Math.max(size.y, 1e-3);
  player.scale.setScalar(s);
  const box2 = new THREE.Box3().setFromObject(player);
  baseOffsetY = -box2.min.y;
  scene.add(player);

  // Animation setup.
  mixer = new THREE.AnimationMixer(player);
  actions = {};
  // People-pack clip names differ a little from the pirate kit's.
  // The Animated packs prefix everything (Female_Idle, Male_Jump…), so try the
  // prefixed name first and fall back to the bare one for other packs.
  const CANDIDATES: Record<string, string[]> = {
    Idle: ['Idle', 'Female_Idle', 'Male_Idle', 'Idle_Neutral'],
    Walk: ['Walk', 'Female_Walk', 'Male_Walk'],
    Run: ['Run', 'Female_Run', 'Male_Run'],
    Jump: ['Jump', 'Female_RunningJump', 'Male_RunningJump', 'Female_Jump', 'Male_Jump'],
    Jump_Idle: ['Jump_Idle', 'Female_Jump', 'Male_Jump', 'Fall'],
    Jump_Land: ['Jump_Land', 'Female_Jump', 'Male_Jump', 'Land'],
    Death: ['Death', 'Female_Death', 'Male_Death'],
    Punch: ['Punch', 'Punch_Left', 'Female_Punch', 'Male_Punch', 'Attack', 'Sword_Slash'],
    Weapon: ['Weapon', 'Sword_Slash', 'Attack', 'Punch'],
    HitReact: ['HitReact', 'HitRecieve', 'Hit', 'Duck'],
  };
  for (const seg of [
    'Idle', 'Walk', 'Run', 'Jump', 'Jump_Idle', 'Jump_Land', 'Death', 'Punch', 'Weapon',
    'HitReact',
  ]) {
    const clip = CANDIDATES[seg].map((c) => findClip(gltf.animations, c)).find(Boolean) ?? null;
    if (clip) {
      const a = mixer.clipAction(clip);
      if (
        seg === 'Jump' || seg === 'Jump_Land' || seg === 'Death' ||
        seg === 'Punch' || seg === 'Weapon' || seg === 'HitReact'
      ) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      actions[seg] = a;
    }
  }
  console.info(
    `[character] ${playerModel().split('/').pop()} clips:`,
    Object.keys(actions).join(', ')
  );
  play('Idle');
  void playerEntity;
  hideBlockyCharacter(state);
}

/** Cached so the per-frame renderer sweep isn't an entity scan. */
let animChar: number | null = null;
/** The entity carrying the character controller, cached the same way. */
let ccEntity: number | null = null;
function playerCC(state: State): number | null {
  if (ccEntity !== null && state.exists(ccEntity)) return ccEntity;
  for (let e = 1; e < 4096; e++) {
    if (state.exists(e) && state.hasComponent(e, CharacterController)) {
      ccEntity = e;
      return e;
    }
  }
  return null;
}

function findAnimChar(state: State): number | null {
  if (animChar !== null && state.exists(animChar)) return animChar;
  for (let e = 1; e < 4096; e++) {
    if (state.exists(e) && state.hasComponent(e, AnimatedCharacter)) {
      animChar = e;
      return e;
    }
  }
  return null;
}

/**
 * Strip the procedural character's renderers.
 *
 * Must run every frame, not once at startup: the engine's initialization
 * system re-adds body-part renderers whenever it finds them missing, so a
 * single removal is silently undone and you get Anne AND the blocky stand-in
 * occupying the same space. Removing (never visible=0) keeps us clear of the
 * instanced-renderer hiding that coincided with grabbed items vanishing.
 */
function hideBlockyCharacter(state: State) {
  const e = findAnimChar(state);
  if (e === null) return;
  const parts = [
    e,
    AnimatedCharacter.headEntity[e],
    AnimatedCharacter.torsoEntity[e],
    AnimatedCharacter.leftArmEntity[e],
    AnimatedCharacter.rightArmEntity[e],
    AnimatedCharacter.leftLegEntity[e],
    AnimatedCharacter.rightLegEntity[e],
  ];
  for (const p of parts) {
    if (!p || !state.exists(p) || !state.hasComponent(p, Renderer)) continue;
    // Shrink to nothing rather than removing the component. Removing it strands
    // the entity's slot in the engine's instanced mesh, so the box keeps
    // drawing at its last position — that's the "old character standing there".
    Renderer.sizeX[p] = 0.0001;
    Renderer.sizeY[p] = 0.0001;
    Renderer.sizeZ[p] = 0.0001;
  }
}

function play(seg: string) {
  // The People packs ship no jump animations. Falling back to Idle would snap
  // her to a standing pose mid-leap; holding whatever is already playing (a
  // run or walk cycle) reads far better in the air.
  const next = actions[seg];
  if (!next || next === current) return;
  next.reset().fadeIn(0.14).play();
  current?.fadeOut(0.14);
  current = next;
}

let heldWeapon: THREE.Object3D | null = null;
let armed = false;

/**
 * Put a weapon in the character's hand, or take it away.
 *
 * Carrying a blade used to float it in front of the face on the same rig the
 * barrels use, and the swing played the bare-handed Punch clip — so an axe
 * and a fist looked identical though one hits for twice as much. The monster
 * rigs ship a "Weapon" clip precisely for this, and it only reads correctly
 * if something is actually in the hand.
 */
export async function setHeldWeapon(src: string | null) {
  if (heldWeapon) {
    heldWeapon.parent?.remove(heldWeapon);
    heldWeapon = null;
  }
  armed = false;
  if (!src || !player) return;
  // Shared with the enemies' attach, and it consults the fits saved on the
  // Weapon fit bench. This used to be a second copy of the attach logic that
  // never looked at them — so a weapon fitted by hand still hung wrong in the
  // player's grip while enemies held theirs correctly.
  const model = await attachWeaponToHand(
    player,
    src,
    0.75,
    'L',
    fitFor(playerModel(), src)
  );
  if (!model) return;
  heldWeapon = model;
  armed = true;
}

/** Throw a punch. Returns the clip length so combat can time its hit window. */
export function playerSwing(): number {
  const a = (armed && actions['Weapon']) || actions['Punch'];
  if (!a || dead) return 0;
  a.reset().fadeIn(0.06).play();
  current?.fadeOut(0.06);
  current = a;
  swingT = a.getClip().duration;
  swinging = true;
  currentState = -1; // force a re-read of the movement state when the swing ends
  return swingT;
}

/** Flinch when struck. Shares the swing timer: both briefly own the rig. */
export function playerHitReact() {
  const a = actions['HitReact'];
  if (!a || dead) return;
  if (swinging) return; // a swing in progress is not interrupted by chip damage
  a.reset().fadeIn(0.05).play();
  current?.fadeOut(0.05);
  current = a;
  swingT = Math.min(a.getClip().duration, 0.45);
  currentState = -1;
}

/** What the rig is doing right now — for diagnosing animation aborts. */
export function playerAnimDebug() {
  return {
    clip: current?.getClip().name.split('|').pop() ?? null,
    swingT: +swingT.toFixed(3),
    dead,
  };
}

/** Play (or clear) the death animation; the rig ignores movement while dead. */
export function setPlayerDead(v: boolean) {
  dead = v;
  swinging = false; // death outranks everything, including your own swing
  if (v) {
    const d = actions['Death'];
    if (d) {
      d.reset().fadeIn(0.12).play();
      current?.fadeOut(0.12);
      current = d;
    }
  } else {
    currentState = -1; // force a re-evaluation back into Idle/Walk
    play('Idle');
  }
}

/** Call from a draw-group system: glue the player model on and advance clips. */
export function updateCharacterVisual(state: State, playerEntity: number) {
  // Shrink the engine's stand-in FIRST, before the early return below.
  // Loading the character GLB takes a moment, and until it resolved this
  // function bailed out — so the procedural blocky figure was drawn for those
  // frames and flashed on every reload.
  hideBlockyCharacter(state);
  if (!player || !mixer) return;

  // Ease the drawn height. The collision grid is a staircase, so walking a
  // slope arrives as a series of small vertical pops; easing them out reads as
  // walking uphill. Only small deltas are smoothed — a real jump or fall must
  // stay instant, or the character lags behind its own physics.
  const targetY = WorldTransform.posY[playerEntity] + baseOffsetY;
  if (smoothY === null || Math.abs(targetY - smoothY) > 0.4) smoothY = targetY;
  else smoothY += (targetY - smoothY) * 0.35;
  player.position.set(
    WorldTransform.posX[playerEntity],
    smoothY,
    WorldTransform.posZ[playerEntity]
  );
  const y = Transform.rotY[playerEntity];
  const w = Transform.rotW[playerEntity];
  player.rotation.y = Math.atan2(2 * w * y, 1 - 2 * y * y);

  // Follow the engine's state machine (unless death has taken the rig).
  const ac = findAnimChar(state);
  const raw = ac !== null ? AnimatedCharacter.animationState[ac] : 0;
  // One delta per frame: it drives both the swing timer and the mixer.
  //
  // Clamped, because a long frame otherwise eats the animation. Killing an NPC
  // spawns its loot, and loading that model can stall a frame for a few
  // hundred milliseconds; an unclamped delta then advances the mixer past most
  // of the punch and zeroes the swing timer in one step, so the swing appears
  // to abort — which is exactly why the *final* punch was the one that broke.
  const dt = Math.min(clock.getDelta(), 0.05);
  swingT = Math.max(0, swingT - dt);
  if (swingT === 0) swinging = false;

  /*
   * Debounce going airborne.
   *
   * The ground's colliders are a grid of flat-topped boxes, so walking DOWN a
   * slope means a series of tiny free-falls off each plateau — physically
   * correct, and invisible, except that the engine reports every one as
   * airborne. The rig then flickered Jump_Idle/Jump_Land several times a
   * second while merely walking, which is the "skipping", and it made a punch
   * look like it had failed. A real jump stays airborne far longer than this
   * window, so it still animates; a one-frame stumble no longer does.
   */
  /*
   * GROUNDED IS AUTHORITATIVE.
   *
   * The engine derives its animation state partly from vertical velocity, and
   * walking down this terrain always has some: the ground's colliders are a
   * grid of flat-topped boxes, so a descent is a run of small drops off each
   * plateau. The controller stays grounded through all of it (snapDist holds
   * it down) but the state machine kept calling it a fall, flickering
   * Jump_Idle/Jump_Land several times a second — the "skipping", and what made
   * a punch look like it had died halfway.
   *
   * So: if the controller says grounded, the character is walking or standing,
   * whatever the state machine thinks. The debounce below still covers the
   * genuine one-frame ungroundings on the way down.
   */
  const cc = playerCC(state);
  const grounded = cc !== null && CharacterController.grounded[cc] === 1;
  const speed = Math.hypot(Body.velX[playerEntity], Body.velZ[playerEntity]);
  let raw2 = raw;
  if (grounded && (raw === 2 || raw === 3 || raw === 4)) raw2 = speed > 0.6 ? 1 : 0;
  // The engine only distinguishes idle from moving; pick Run over Walk from
  // actual ground speed so a sprint looks like one.
  if (grounded && raw2 === 1 && speed > 6.5) raw2 = 5;
  const airborne = raw2 === 2 || raw2 === 3 || raw2 === 4;
  airborneT = airborne ? airborneT + dt : 0;
  const st = airborne && airborneT < 0.14 ? groundedState : raw2;
  if (!airborne) groundedState = raw2;
  if (!dead && swingT <= 0 && ac !== null && st !== currentState) {
    currentState = st;
    play(STATE_CLIP[st] ?? 'Idle');
  }

  mixer.update(dt);
}
