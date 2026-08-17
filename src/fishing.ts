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

import { WATER_Y } from './atmosphere';
import { ISLAND, islandHeight } from './ground';

/** A lure is light and lands soon; real g reads as a thrown rock. */
const GRAVITY = 12;
const CAST_SPEED = 13;
const CAST_LIFT = 5;
/** Segments in the line. Enough to sag, few enough to rebuild per frame. */
const LINE_POINTS = 14;
/** How far the slack line droops, as a fraction of how far it spans. */
const SAG = 0.16;
const LURE_RADIUS = 0.07;

type Cast = {
  state: 'flying' | 'floating';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Seconds since it settled — drives the bob, and later the bite. */
  restT: number;
  /** True if it came down on water rather than sand. */
  onWater: boolean;
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

/** Let go of the lure. `from` is the rod tip; (fx, fz) the way the caster faces. */
export function beginCast(scene: THREE.Scene, from: THREE.Vector3, fx: number, fz: number) {
  ensureVisuals(scene);
  cast = {
    state: 'flying',
    pos: from.clone(),
    vel: new THREE.Vector3(fx * CAST_SPEED, CAST_LIFT, fz * CAST_SPEED),
    restT: 0,
    onWater: false,
  };
  lure!.position.copy(cast.pos);
}

/** Reel in: the lure and its line come off the water and out of the scene. */
export function reelIn() {
  cast = null;
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
export function updateFishing(dt: number, tip: THREE.Vector3 | null) {
  if (!cast || !lure || !line) return;

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
  } else {
    cast.restT += dt;
    // Riding the swell. On sand it just sits there.
    if (cast.onWater) {
      cast.pos.y = WATER_Y + Math.sin(cast.restT * 2.2) * 0.03;
    }
  }
  lure.position.copy(cast.pos);

  if (!tip) {
    line.visible = false;
    return;
  }
  line.visible = true;
  tipScratch.copy(tip);
  // Slack hangs between rod and lure. A quadratic through a dropped control
  // point is not a real catenary, but at this length nothing else reads.
  const span = tipScratch.distanceTo(cast.pos);
  ctrlScratch.copy(tipScratch).add(cast.pos).multiplyScalar(0.5);
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
      .addScaledVector(cast.pos, t * t);
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
