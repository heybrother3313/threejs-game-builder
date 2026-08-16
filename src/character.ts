import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { State } from 'vibegame';
import { AnimatedCharacter } from 'vibegame/animation';
import { Renderer, getScene } from 'vibegame/rendering';
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
export const PLAYER_CHOICES: { label: string; src: string }[] = [
  { label: 'Frog (monster)', src: '/models/ultimate-monsters/Frog.glb' },
  { label: 'Cactoro (monster)', src: '/models/ultimate-monsters/Cactoro.glb' },
  { label: 'Dino (monster)', src: '/models/ultimate-monsters/Dino.glb' },
  { label: 'Alien (monster)', src: '/models/ultimate-monsters/Alien.glb' },
  { label: 'Bunny (monster)', src: '/models/ultimate-monsters/Bunny.glb' },
  { label: 'Ghost (monster)', src: '/models/ultimate-monsters/Ghost.glb' },
  { label: 'Woman Casual', src: '/models/animated-women-pack/Woman Casual.glb' },
  { label: 'Man', src: '/models/animated-men-pack/Man.glb' },
];

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
};

let mixer: THREE.AnimationMixer | null = null;
let actions: Record<string, THREE.AnimationAction> = {};
let current: THREE.AnimationAction | null = null;
let currentState = -1;
/** While true the death clip owns the rig and the state machine is ignored. */
let dead = false;

let player: THREE.Group | null = null;
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
  };
  for (const seg of ['Idle', 'Walk', 'Run', 'Jump', 'Jump_Idle', 'Jump_Land', 'Death']) {
    const clip = CANDIDATES[seg].map((c) => findClip(gltf.animations, c)).find(Boolean) ?? null;
    if (clip) {
      const a = mixer.clipAction(clip);
      if (seg === 'Jump' || seg === 'Jump_Land' || seg === 'Death') {
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

/** Play (or clear) the death animation; the rig ignores movement while dead. */
export function setPlayerDead(v: boolean) {
  dead = v;
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
  if (!player || !mixer) return;
  hideBlockyCharacter(state);

  player.position.set(
    WorldTransform.posX[playerEntity],
    WorldTransform.posY[playerEntity] + baseOffsetY,
    WorldTransform.posZ[playerEntity]
  );
  const y = Transform.rotY[playerEntity];
  const w = Transform.rotW[playerEntity];
  player.rotation.y = Math.atan2(2 * w * y, 1 - 2 * y * y);

  // Follow the engine's state machine (unless death has taken the rig).
  const ac = findAnimChar(state);
  const st = ac !== null ? AnimatedCharacter.animationState[ac] : 0;
  if (!dead && ac !== null && st !== currentState) {
    currentState = st;
    play(STATE_CLIP[st] ?? 'Idle');
  }

  mixer.update(clock.getDelta());
}
