/**
 * Casting.
 *
 * A cast is the throw's timing with the release taken off the hand. The Weapon
 * clip plays and gets cut at the same fraction a throw releases on, because it
 * reads as a cast for exactly the same reason it reads as a throw — arm up,
 * weight forward. The difference is what leaves: a throw sends the held object,
 * a cast keeps the rod gripped and sends a lure on a line.
 *
 * The lure is deliberately NOT a level entry. Anything that becomes an entry
 * becomes selectable, draggable and persisted, which is how the island ended up
 * full of ground tiles you could pick up. A lure is a visual with a lifetime of
 * seconds; it owns two meshes and nothing else.
 */

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { WATER_Y } from './atmosphere';
import { ISLAND, islandHeight } from './ground';
import { animationsFor, loadModel } from './level';

/** A lure is light and lands soon; real g reads as a thrown rock. */
const GRAVITY = 12;
/** Cast power runs between these. A tap still reaches water from a dock. */
const CAST_SPEED_MIN = 7;
const CAST_SPEED_MAX = 17;
const CAST_LIFT_MIN = 3.2;
const CAST_LIFT_MAX = 6;
/** How long the bar takes to fill. Long enough to aim for a middle reading. */
const CHARGE_SECONDS = 1.2;
/** Segments in the line. Enough to sag, few enough to rebuild per frame. */
const LINE_POINTS = 14;
/** How far the slack line droops, as a fraction of how far it spans. */
const SAG = 0.16;
/** The plug from the pack, and how long it hangs. */
const LURE_SRC = '/models/animated-fish-bundle/Lure-JknXyvHxtD.glb';
const LURE_SIZE = 0.22;
/** Stand-in until the model arrives, so the first cast is never empty. */
const LURE_RADIUS = 0.05;

/** Where the lure hangs off the tip when the line is not out. */
const STOW_DROP = 0.4;

/** How long the water stays quiet before something takes an interest. */
const BITE_MIN = 2.2;
const BITE_MAX = 6.5;
/** How long you have to strike once it does. Miss it and the fish is gone. */
const BITE_WINDOW = 1.0;

/**
 * What is down there, by how far out the lure landed.
 *
 * Measured with waterDistance, which is the same distance the water's colour
 * uses — so the darker blue you cast into really is where the better fish
 * are, and casting further is a decision rather than a habit. The bands are
 * scaled to what a cast from the shore can actually reach (roughly 0..15),
 * not to the colour ramp's own constants, which run to 40 and would call
 * every reachable cast "shallow".
 */
const CATCH_TABLE: { within: number; fish: string[] }[] = [
  {
    within: 3,
    fish: ['Clownfish', 'Goldfish', 'Cardinal Fish', 'Butterfly Fish', 'Zebra Clown Fish'],
  },
  { within: 8, fish: ['Parrot Fish', 'Blue Tang', 'Mandarin Fish', 'Cowfish', 'Red Snapper'] },
  { within: Infinity, fish: ['Tuna', 'Swordfish', 'Sunfish', 'Anglerfish', 'Goblin Shark'] },
];

/** What would bite at (x, z). */
function fishFor(x: number, z: number): string {
  const d = waterDistance(x, z);
  const band = CATCH_TABLE.find((b) => d < b.within) ?? CATCH_TABLE[CATCH_TABLE.length - 1];
  return band.fish[Math.floor(Math.random() * band.fish.length)];
}

function nextBiteDelay(): number {
  return BITE_MIN + Math.random() * (BITE_MAX - BITE_MIN);
}

/** How big a caught fish is drawn, longest side in metres. */
const FISH_SIZE = 0.95;
/** Every model in the bundle ships this; it is what a landed fish does. */
const OUT_OF_WATER = 'Out_Of_Water';

type Cast = {
  state: 'flying' | 'floating' | 'bite' | 'reeling';
  /** Seconds of quiet water left before something takes the lure. */
  biteIn: number;
  /** How long the current bite has been going, against BITE_WINDOW. */
  biteT: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Seconds since it settled — drives the bob, and later the bite. */
  restT: number;
  /** True if it came down on water rather than sand. */
  onWater: boolean;
  /** Where the reel started from, and how long it runs. */
  reelFrom: THREE.Vector3;
  reelT: number;
  reelDur: number;
};

let cast: Cast | null = null;
let lure: THREE.Group | null = null;
let line: THREE.Line | null = null;
let host: THREE.Scene | null = null;

const tipScratch = new THREE.Vector3();
const ctrlScratch = new THREE.Vector3();
const pointScratch = new THREE.Vector3();

/**
 * Is (x, z) over open water?
 *
 * A rectangle test, not a height comparison. The island is a slab rather than a
 * heightfield that dips below sea level — `islandHeight` returns 0 the moment
 * you step off it, which is ABOVE the waterline — so comparing ground height to
 * water level says "land" everywhere. The margin matches the one the fish use
 * to decide they've hit the shore.
 */
export function isOverWater(x: number, z: number): boolean {
  return Math.abs(x) > ISLAND.x + 0.8 || Math.abs(z) > ISLAND.z + 0.8;
}

/**
 * How far out to sea, in metres beyond the island's rectangle.
 *
 * Deliberately the same measure the water's colour uses, so the blue you read
 * as deep IS the deep one. Casting from the shore reaches roughly 0..12 of
 * these, which is the range the catch table has to be built against — the
 * colour ramp's own constants run to 40 and would put every reachable cast in
 * the shallows.
 */
export function waterDistance(x: number, z: number): number {
  const dx = Math.max(Math.abs(x) - (ISLAND.x + 2), 0);
  const dz = Math.max(Math.abs(z) - (ISLAND.z + 2), 0);
  return Math.hypot(dx, dz);
}

/** Where a thing dropped at (x, z) comes to rest: the sea, or the sand. */
function restHeight(x: number, z: number): number {
  return isOverWater(x, z) ? WATER_Y : islandHeight(x, z);
}

/**
 * Swap the stand-in sphere for the real plug once it has loaded.
 *
 * The lure has to exist the instant a cast goes out, and a model does not, so
 * a small sphere holds the spot and the plug replaces it on arrival. Done once
 * per session; after that the load is cached and the swap is immediate.
 */
async function dressLure(holder: THREE.Group) {
  try {
    const model = (await loadModel(LURE_SRC)).clone(true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(longest) || longest <= 1e-3) return;
    model.scale.setScalar(LURE_SIZE / longest);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    // Tie the line to the NOSE, not the middle. The plug lies along X with its
    // red head toward -X and the hooks trailing +X, so -X is the tie eye: park
    // that on the holder's origin, which is where the line ends.
    model.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(model);
    const c = b.getCenter(new THREE.Vector3());
    if (Number.isFinite(b.min.x) && Number.isFinite(c.y)) {
      model.position.set(-b.min.x, -c.y, -c.z);
    }
    holder.clear();
    holder.add(model);
    // And hang it nose-up: +X (nose to tail) rotated -90° about Z points down,
    // so the body and hooks trail below the line the way a plug hangs.
    holder.rotation.z = -Math.PI / 2;
  } catch {
    /* keep the sphere */
  }
}

function ensureVisuals(scene: THREE.Scene) {
  host = scene;
  if (!lure) {
    const holder = new THREE.Group();
    const stand = new THREE.Mesh(
      new THREE.SphereGeometry(LURE_RADIUS, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8342c, roughness: 0.5 })
    );
    stand.castShadow = true;
    holder.add(stand);
    lure = holder;
    scene.add(holder);
    void dressLure(holder);
  }
  if (!line) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3));
    line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.75 })
    );
    // A filament against bright water loses to depth testing more often than
    // it should; draw it late so it stays readable at distance.
    line.renderOrder = 10;
    scene.add(line);
  }
  lure.visible = true;
  line.visible = true;
}

/* ------------------------------------------------------------- power --- */

let charge = 0;
let charging = false;
let barEl: HTMLDivElement | null = null;
let barFill: HTMLDivElement | null = null;

/** Hold to wind up. The bar fills and stays full; it does not bounce back. */
export function beginCharge() {
  charging = true;
  charge = 0;
}

/** How hard the cast would go right now, 0..1. */
export function chargeAmount(): number {
  return charge;
}

export function isCharging(): boolean {
  return charging;
}

/** Let go of the wind-up and report the power it reached. */
export function endCharge(): number {
  const power = charge;
  charging = false;
  charge = 0;
  drawBar();
  return power;
}

/** Fill the bar while the button is down. Called every frame. */
function updateCharge(dt: number) {
  if (charging) charge = Math.min(1, charge + dt / CHARGE_SECONDS);
  drawBar();
}

function drawBar() {
  if (!barEl) {
    if (!charging) return;
    barEl = document.createElement('div');
    barEl.id = 'cast-power';
    barEl.style.cssText =
      'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:18;' +
      'display:none;width:220px;height:18px;background:var(--surface,#fff);' +
      'border:3px solid var(--border-strong,#111);border-radius:10px;' +
      'box-shadow:0 4px 0 var(--border-strong,#111);overflow:hidden;';
    barFill = document.createElement('div');
    barFill.style.cssText =
      'height:100%;width:0%;background:var(--color-coral,#fd9b9b);' +
      'transition:width 40ms linear;';
    barEl.appendChild(barFill);
    document.body.appendChild(barEl);
  }
  barEl.style.display = charging ? 'block' : 'none';
  if (barFill) {
    barFill.style.width = `${Math.round(charge * 100)}%`;
    // Reads as "wound up" without needing a number on it.
    barFill.style.background =
      charge > 0.85 ? 'var(--color-lime,#b7e26b)' : 'var(--color-coral,#fd9b9b)';
  }
}

/**
 * Let go of the lure. `from` is the rod tip; (fx, fz) the way the caster
 * faces; `power` is 0..1 from the wind-up.
 */
export function beginCast(
  scene: THREE.Scene,
  from: THREE.Vector3,
  fx: number,
  fz: number,
  power = 1
) {
  ensureVisuals(scene);
  const p = Math.max(0, Math.min(1, power));
  const speed = CAST_SPEED_MIN + (CAST_SPEED_MAX - CAST_SPEED_MIN) * p;
  const lift = CAST_LIFT_MIN + (CAST_LIFT_MAX - CAST_LIFT_MIN) * p;
  cast = {
    state: 'flying',
    pos: from.clone(),
    vel: new THREE.Vector3(fx * speed, lift, fz * speed),
    restT: 0,
    onWater: false,
    biteIn: nextBiteDelay(),
    biteT: 0,
    reelFrom: new THREE.Vector3(),
    reelT: 0,
    reelDur: 0,
  };
  lure!.position.copy(cast.pos);
}

/**
 * Wind the lure back to the rod over `seconds`.
 *
 * Paired with the swing played backwards, so the line comes in over exactly
 * the motion that put it out. Reeling a lure that is still in the air is
 * allowed — you changed your mind mid-cast, which is a thing people do.
 */
export function startReel(seconds: number) {
  if (!cast || cast.state === 'reeling') return;
  cast.state = 'reeling';
  cast.reelFrom.copy(cast.pos);
  cast.reelT = 0;
  cast.reelDur = Math.max(0.12, seconds);
}

export function isReeling(): boolean {
  return cast?.state === 'reeling';
}

/**
 * Strike. Returns what you hooked, or null if there was nothing on the line.
 *
 * Called on the same key that reels, so a late strike still winds the line in
 * — you are never punished with a stuck lure for being slow, only with an
 * empty hook.
 */
export function tryHook(): string | null {
  if (!cast || cast.state !== 'bite') return null;
  const fish = fishFor(cast.pos.x, cast.pos.z);
  showBite(false);
  hookedName = fish;
  void attachFish(fish);
  return fish;
}

/* -------------------------------------------------------------- fish --- */

/**
 * What is on the line, known the instant you strike.
 *
 * Kept apart from the model on purpose. The model is loaded asynchronously and
 * may not arrive before the reel finishes — the first of each species has a
 * file read in front of it — and a catch that depended on the mesh being ready
 * was silently thrown away when it wasn't. You caught it when you struck; the
 * fish turning up to be looked at is a separate, best-effort thing.
 */
let hookedName: string | null = null;
/**
 * `pivot` has the fish's MOUTH at its origin, so putting the pivot on the lure
 * hangs the fish off the hook rather than through the middle of its body. The
 * model sits inside it, shifted back by however far its mouth is from its own
 * origin.
 */
let hooked: {
  pivot: THREE.Group;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** One loop of the flop, so the landing can be counted in flops. */
  flopSeconds: number;
  /**
   * How far below the pivot the fish's lowest point ever gets while flopping.
   *
   * MEASURED, by sampling the clip and watching the bones — which follow the
   * animation, unlike a Box3, which reports the bind pose and so cannot see
   * the motion at all. Seat the pivot this far up and the bottom of the flop
   * just brushes the sand instead of hovering over it.
   */
  flopDip: number;
  /** How far the body reaches below the mouth when it hangs nose-up. */
  bodyLength: number;
} | null = null;

/**
 * How much of the flop to actually play, 0..1.
 *
 * The clip is authored for a fish thrashing in open space and swings the
 * skeleton through more than a body length of vertical travel. At full weight
 * on a 0.95m fish that is over a metre of air, which reads as hovering however
 * carefully the thing is seated — seating cannot fix a fish that spends most
 * of the cycle off the ground. Blending the action against the bind pose keeps
 * the motion and cuts the excursion.
 *
 * 0.2 was settled by looking at it, not by measuring it. Every instrument to
 * hand reported the excursion as unchanged by this weight, and every one of
 * them was wrong — bone sweeps included, since they sampled after the fish had
 * already been banked. Still tunable via __game.setFlopWeight(w).
 */
let flopWeight = 0.2;

export function setFlopWeight(w: number): number {
  flopWeight = Math.min(1, Math.max(0.05, w));
  if (hooked) hooked.action.setEffectiveWeight(flopWeight);
  return flopWeight;
}
let caughtReady: string | null = null;

/**
 * The fish's own life, which outlives the cast.
 *
 * Once the reel is in, the lure goes back to hanging on the rod and the fish
 * is on its own: it drops to the sand and flops there. Keeping the two apart
 * means the line is free the moment the fish is off it, instead of the rod
 * staying tied up until the animation finishes.
 */
let fishPhase: 'none' | 'dropping' | 'flopping' = 'none';
let fishT = 0;
const fishFrom = new THREE.Vector3();
const fishTo = new THREE.Vector3();
/** How long the drop to the sand takes. */
const DROP_SECONDS = 0.45;
/** How many times it flops before you pocket it. */
const FLOPS = 3;

/**
 * Put the fish on the line.
 *
 * Loaded rather than pooled because which fish it is depends on where the
 * lure landed, and there are fifteen of them. The load is cached by src, so
 * only the first of each kind waits; if it arrives mid-reel it simply appears
 * a little late, which beats holding the whole strike up on a file read.
 *
 * A failed load is not a lost catch — the fish still counts, it just does not
 * get to be seen.
 */
async function attachFish(name: string) {
  const src = `/models/animated-fish-bundle/${name}.glb`;
  try {
    const loaded = await loadModel(src);
    // The line may already be back — reeled, cancelled, or a different fish
    // struck since. Dropping a late arrival beats a fish appearing out of
    // nowhere over dry land.
    if (!host || !cast || hookedName !== name) return;
    // Every fish here is rigged, and a plain clone of a skinned mesh shares
    // or loses its skeleton — the copy renders at a wild size or not at all.
    // Same trap that made a placed Tentacle enormous.
    const model = cloneSkinned(loaded) as THREE.Group;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) m.castShadow = true;
      // Skinned bounds are the bind pose, so a fish thrashing outside them
      // gets culled and vanishes at exactly the moment it is worth watching.
      if (m.isSkinnedMesh) m.frustumCulled = false;
    });
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    // An unmeasurable model gives ±Infinity, not zero; scaling by that is NaN
    // and the fish disappears while its mixer happily runs.
    model.scale.setScalar(Number.isFinite(longest) && longest > 1e-3 ? FISH_SIZE / longest : 1);

    // Shift the model inside a pivot so its MOUTH sits at the pivot's origin.
    // These rigs face +Z — the same assumption the NPC pathing makes when it
    // aims a walker with atan2(dx, dz) — so the mouth is the front of the box.
    model.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(model);
    const centre = scaled.getCenter(new THREE.Vector3());
    if (Number.isFinite(centre.x) && Number.isFinite(scaled.max.z)) {
      model.position.set(-centre.x, -centre.y, -scaled.max.z);
    }
    const pivot = new THREE.Group();
    pivot.add(model);
    host.add(pivot);

    const mixer = new THREE.AnimationMixer(model);
    const clips = animationsFor(src);
    // Clip names come through namespaced ("Fish_Armature|Out_Of_Water").
    const clip = clips.find((c) => c.name.split('|').pop() === OUT_OF_WATER) ?? clips[0] ?? null;
    if (!clip) return;
    const action = mixer.clipAction(clip);
    // Damped against the bind pose: the clip is authored for open space and
    // throws the body further than a fish on sand ever would.
    action.setEffectiveWeight(flopWeight);
    action.play();
    mixer.update(0);
    hooked = {
      pivot,
      mixer,
      action,
      flopSeconds: clip.duration || 0.8,
      // Measured off the damped motion, so the seat matches what will be
      // played rather than what the clip would do at full weight.
      flopDip: measureFlopDip(pivot, mixer, action, clip),
      // Nose-up, the whole body hangs BELOW the mouth — which is why it used
      // to sink through the sand on the way down, while still pitched.
      bodyLength: Number.isFinite(scaled.max.z - scaled.min.z) ? scaled.max.z - scaled.min.z : 0.5,
    };
  } catch {
    /* model missing — the catch still counts */
  }
}

function clearFish() {
  if (hooked && host) host.remove(hooked.pivot);
  hooked = null;
  hookedName = null;
  fishPhase = 'none';
  fishT = 0;
}

/** On the hook: mouth at the lure, hanging nose-up the way a caught fish does. */
function seatFish() {
  if (!hooked || !lure) return;
  hooked.pivot.position.copy(lure.position);
  // Facing +Z rotated -90° about X points the nose at the sky.
  hooked.pivot.rotation.set(-Math.PI / 2, 0, 0);
}

const dipScratch = new THREE.Vector3();

/**
 * How far below its pivot the fish ever reaches over one flop.
 *
 * Runs the clip through in steps and, at each, asks the SKELETON where it is —
 * bones move with the animation, where a bounding box does not. That is the
 * whole reason this exists: every previous attempt measured a Box3, which
 * reports the bind pose, so it could not see the motion causing the problem.
 *
 * The lowest bone sits inside the body, so the belly hangs lower still; that
 * gap is taken from the bind pose, the one place where box and bones describe
 * the same shape. Sixteen poses on a six-bone rig, once per catch.
 */
function measureFlopDip(
  pivot: THREE.Group,
  mixer: THREE.AnimationMixer,
  action: THREE.AnimationAction,
  clip: THREE.AnimationClip
): number {
  const lowestBone = () => {
    let m = Infinity;
    pivot.traverse((o) => {
      if ((o as THREE.Bone).isBone) m = Math.min(m, o.getWorldPosition(dipScratch).y);
    });
    return m;
  };
  const lowestSkin = () => {
    let m = Infinity;
    pivot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      dipScratch.set(0, bb.min.y, 0);
      mesh.localToWorld(dipScratch);
      m = Math.min(m, dipScratch.y);
    });
    return m;
  };

  pivot.updateMatrixWorld(true);
  const bindBone = lowestBone();
  const bindSkin = lowestSkin();
  const belly = Number.isFinite(bindBone) && Number.isFinite(bindSkin) ? bindBone - bindSkin : 0;

  const was = action.time;
  let dip = 0;
  const STEPS = 16;
  for (let i = 0; i < STEPS; i++) {
    action.time = (i / STEPS) * clip.duration;
    mixer.update(0);
    pivot.updateMatrixWorld(true);
    const b = lowestBone();
    if (Number.isFinite(b)) dip = Math.min(dip, b - pivot.position.y);
  }
  action.time = was;
  mixer.update(0);
  return Math.max(0, -dip + belly);
}

/**
 * Never let the fish through the sand, at any angle it happens to be at.
 *
 * The pivot is the MOUTH, so what hangs below it depends entirely on pitch:
 * a whole body length when it is nose-up on the line, only the flop's reach
 * once it is flat. Clamping against a single number was what let it vanish
 * through the ground partway down.
 */
function keepAboveGround() {
  if (!hooked) return;
  const p = hooked.pivot;
  const pitch = Math.abs(p.rotation.x);
  const below = hooked.bodyLength * Math.sin(pitch) + hooked.flopDip * Math.cos(pitch);
  const floor = restHeight(p.position.x, p.position.z) + below;
  if (p.position.y < floor) p.position.y = floor;
}

/**
 * Off the hook: it falls to the sand, flops there, then it's yours.
 *
 * Runs whether or not a line is out, because by this point the fish has
 * nothing to do with the rod any more.
 */
function updateLandedFish(dt: number) {
  if (fishPhase === 'none' || !hooked) return;
  fishT += dt;
  if (fishPhase === 'dropping') {
    const t = Math.min(1, fishT / DROP_SECONDS);
    // Accelerate downward — it is falling, not being lowered.
    hooked.pivot.position.lerpVectors(fishFrom, fishTo, t * t);
    // Nose-up on the line rolls flat as it lands. Ahead of the descent, so it
    // is level before it gets near the sand rather than pivoting into it.
    hooked.pivot.rotation.x = -(Math.PI / 2) * (1 - Math.min(1, t * 1.6));
    keepAboveGround();
    if (t >= 1) {
      fishPhase = 'flopping';
      fishT = 0;
      hooked.pivot.position.copy(fishTo);
      hooked.pivot.rotation.set(0, 0, 0);
      keepAboveGround();
    }
    return;
  }
  keepAboveGround();
  // Flopping: three goes at the clip, which is long enough to read as a fish
  // out of water rather than a frame of one.
  if (fishT >= hooked.flopSeconds * FLOPS) {
    caughtReady = hookedName;
    clearFish();
  }
}

/** What the fish is doing, for when what it is doing is not what it looks like. */
export function fishingDebug() {
  return {
    castState: cast?.state ?? 'none',
    fishPhase,
    fishT: +fishT.toFixed(2),
    hookedName,
    hasModel: !!hooked,
    pivotY: hooked ? +hooked.pivot.position.y.toFixed(2) : null,
    pitch: hooked ? +hooked.pivot.rotation.x.toFixed(2) : null,
    target: +fishTo.y.toFixed(2),
    flopDip: hooked ? +hooked.flopDip.toFixed(3) : null,
    flopWeight,
    bodyLength: hooked ? +hooked.bodyLength.toFixed(3) : null,
  };
}

/**
 * The catch, handed over exactly once, when it has finished flopping.
 *
 * Polled rather than pushed so the inventory stays main.ts's business —
 * fishing knows what it caught, not what an inventory is.
 */
export function takeCatch(): string | null {
  const c = caughtReady;
  caughtReady = null;
  return c;
}

let biteEl: HTMLDivElement | null = null;

/** The one cue that a fish is on, since the lure's dip is small at distance. */
function showBite(on: boolean) {
  if (!biteEl) {
    if (!on) return;
    biteEl = document.createElement('div');
    biteEl.id = 'fish-bite';
    biteEl.style.cssText =
      'position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);z-index:18;' +
      'display:none;background:var(--color-sky,#8fd4ea);color:var(--text-primary,#111);' +
      'border:3px solid var(--border-strong,#111);border-radius:14px;' +
      'box-shadow:0 5px 0 var(--border-strong,#111);padding:10px 22px;' +
      'font-family:var(--font-display,sans-serif);font-weight:700;font-size:22px;' +
      'letter-spacing:.04em;text-transform:uppercase;';
    biteEl.innerHTML = 'Fish on! &nbsp;<b>F</b>';
    document.body.appendChild(biteEl);
  }
  biteEl.style.display = on ? 'block' : 'none';
}

/** Reel in: the lure and its line come off the water and out of the scene. */
export function reelIn() {
  cast = null;
  showBite(false);
  // Walking away mid-fight loses the fish with the cast — it goes back in the
  // water rather than into the bag, which is the cost of giving up the line.
  clearFish();
  if (lure) lure.visible = false;
  if (line) line.visible = false;
}

export function isCastOut(): boolean {
  return cast !== null;
}

/** Where the lure is sitting, for whatever decides if something bites. */
export function lureSpot(): { x: number; z: number; onWater: boolean; restT: number } | null {
  if (!cast || cast.state !== 'floating') return null;
  return { x: cast.pos.x, z: cast.pos.z, onWater: cast.onWater, restT: cast.restT };
}

/**
 * Fly the lure and hang the line off the rod tip.
 *
 * `tip` is null whenever the rod is not in view — mid-swap, or the character
 * lost it — and the line has nowhere to hang from, so it hides rather than
 * anchoring itself to the origin.
 */
export function updateFishing(dt: number, tip: THREE.Vector3 | null, scene: THREE.Scene | null) {
  updateCharge(dt);
  if (hooked) hooked.mixer.update(dt);
  updateLandedFish(dt);
  // No rod in the hand: there is nothing to hang a line from, so both meshes
  // go away rather than anchoring themselves to the origin.
  if (!tip) {
    if (lure) lure.visible = false;
    if (line) line.visible = false;
    return;
  }
  if (scene) ensureVisuals(scene);
  if (!lure || !line) return;

  // Line not out: the lure hangs off the tip so the rod reads as rigged
  // rather than as a bare stick. It is the same two meshes, which is why the
  // lure visibly LEAVES the tip when you cast.
  if (!cast) {
    lure.position.set(tip.x, tip.y - STOW_DROP, tip.z);
    drawLine(tip, lure.position);
    return;
  }

  if (cast.state === 'reeling') {
    cast.reelT += dt;
    const t = Math.min(1, cast.reelT / cast.reelDur);
    // Ease out: it leaves the water quickly and arrives gently.
    const e = 1 - (1 - t) * (1 - t);
    cast.pos.lerpVectors(cast.reelFrom, tip, e);
    lure.position.copy(cast.pos);
    drawLine(tip, cast.pos);
    seatFish();
    // The line is in. If something came with it, hand the fish over to its
    // own sequence and give the rod straight back — the lure returns to
    // hanging while the fish gets on with landing.
    if (t >= 1) {
      const name = hookedName;
      if (name && hooked) {
        fishFrom.copy(hooked.pivot.position);
        // Straight down from the rod tip: that is the sand in front of you.
        fishTo.set(tip.x, restHeight(tip.x, tip.z) + hooked.flopDip, tip.z);
        fishPhase = 'dropping';
        fishT = 0;
        cast = null;
        showBite(false);
      } else if (name) {
        // Nothing to look at, so nothing to wait for.
        caughtReady = name;
        clearFish();
        reelIn();
      } else {
        reelIn();
      }
    }
    return;
  }

  if (cast.state === 'flying') {
    cast.vel.y -= GRAVITY * dt;
    cast.pos.addScaledVector(cast.vel, dt);
    const rest = restHeight(cast.pos.x, cast.pos.z);
    if (cast.pos.y <= rest) {
      cast.pos.y = rest;
      cast.state = 'floating';
      cast.onWater = isOverWater(cast.pos.x, cast.pos.z);
      cast.vel.set(0, 0, 0);
    }
  } else if (cast.state === 'bite') {
    cast.biteT += dt;
    // The lure is being pulled under in tugs — the tell you are striking at.
    cast.pos.y = WATER_Y - 0.06 - Math.abs(Math.sin(cast.biteT * 18)) * 0.09;
    if (cast.biteT >= BITE_WINDOW) {
      // Missed it. The water goes quiet again and something else comes along.
      cast.state = 'floating';
      cast.biteT = 0;
      cast.biteIn = nextBiteDelay();
      showBite(false);
    }
  } else {
    cast.restT += dt;
    // Riding the swell. On sand it just sits there.
    if (cast.onWater) {
      cast.pos.y = WATER_Y + Math.sin(cast.restT * 2.2) * 0.03;
      // Only open water holds fish. A lure on the sand is a lure on the sand.
      cast.biteIn -= dt;
      if (cast.biteIn <= 0) {
        cast.state = 'bite';
        cast.biteT = 0;
        showBite(true);
      }
    }
  }
  lure.position.copy(cast.pos);
  drawLine(tip, cast.pos);
}

/** Hang the line between two points, with the slack a loose line carries. */
function drawLine(from: THREE.Vector3, to: THREE.Vector3) {
  if (!line) return;
  line.visible = true;
  tipScratch.copy(from);
  // A quadratic through a dropped control point is not a real catenary, but
  // at this length nothing else reads.
  const span = tipScratch.distanceTo(to);
  ctrlScratch.copy(tipScratch).add(to).multiplyScalar(0.5);
  ctrlScratch.y -= span * SAG;
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < LINE_POINTS; i++) {
    const t = i / (LINE_POINTS - 1);
    const inv = 1 - t;
    // Quadratic Bézier: tip → control → lure.
    pointScratch
      .copy(tipScratch)
      .multiplyScalar(inv * inv)
      .addScaledVector(ctrlScratch, 2 * inv * t)
      .addScaledVector(to, t * t);
    attr.setXYZ(i, pointScratch.x, pointScratch.y, pointScratch.z);
  }
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

/** Drop everything — travelling islands, or putting the rod away. */
export function clearFishing() {
  reelIn();
  if (host) {
    if (lure) host.remove(lure);
    if (line) host.remove(line);
  }
  lure = null;
  line = null;
}
