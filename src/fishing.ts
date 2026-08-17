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
const LURE_RADIUS = 0.07;

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
const FISH_SIZE = 0.5;
/** How long it hangs off the rod flopping before it goes in the bag. */
const LANDED_SECONDS = 1.3;
/** Every model in the bundle ships this; it is what a landed fish does. */
const OUT_OF_WATER = 'Out_Of_Water';

type Cast = {
  state: 'flying' | 'floating' | 'bite' | 'reeling' | 'landed';
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
let lure: THREE.Mesh | null = null;
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

function ensureVisuals(scene: THREE.Scene) {
  host = scene;
  if (!lure) {
    lure = new THREE.Mesh(
      new THREE.SphereGeometry(LURE_RADIUS, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8342c, roughness: 0.5 })
    );
    lure.castShadow = true;
    scene.add(lure);
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
let hooked: { obj: THREE.Object3D; mixer: THREE.AnimationMixer } | null = null;
let landedT = 0;
let caughtReady: string | null = null;

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
    host.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const clips = animationsFor(src);
    // Clip names come through namespaced ("Fish_Armature|Out_Of_Water").
    const clip = clips.find((c) => c.name.split('|').pop() === OUT_OF_WATER) ?? clips[0] ?? null;
    if (clip) mixer.clipAction(clip).play();
    hooked = { obj: model, mixer };
  } catch {
    /* model missing — the catch still counts */
  }
}

function clearFish() {
  if (hooked && host) host.remove(hooked.obj);
  hooked = null;
  hookedName = null;
  landedT = 0;
}

/** Hangs off the lure, nose up, the way something on a hook does. */
function seatFish() {
  if (!hooked || !lure) return;
  hooked.obj.position.set(lure.position.x, lure.position.y - FISH_SIZE * 0.5, lure.position.z);
  hooked.obj.rotation.z = Math.PI / 2;
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
    // An empty line is just done. A fish gets held up first — keyed on having
    // hooked one, not on its mesh having loaded.
    if (t >= 1) {
      if (hookedName) {
        cast.state = 'landed';
        landedT = 0;
      } else {
        reelIn();
      }
    }
    return;
  }

  // Landed: it hangs off the rod flopping, and only then goes in the bag.
  if (cast.state === 'landed') {
    landedT += dt;
    cast.pos.set(tip.x, tip.y - STOW_DROP, tip.z);
    lure.position.copy(cast.pos);
    drawLine(tip, cast.pos);
    seatFish();
    if (landedT >= LANDED_SECONDS) {
      caughtReady = hookedName;
      clearFish();
      reelIn();
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
