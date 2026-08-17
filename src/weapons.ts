import * as THREE from 'three';
import type { State } from 'vibegame';
import { PlacedItem, instantiate, placed, removeItem } from './level';

/**
 * Weapons.
 *
 * Two kinds, both keyed off the model you happen to be carrying rather than
 * an inventory system: blades change what a punch is worth, and bombs go off
 * where they land. Nothing here needs authoring — pick up a cutlass and F
 * hits harder, throw a bomb and it explodes. The level format doesn't change.
 */

export type Blade = { name: string; damage: number; reach: number };

/**
 * Find a hand on a rig.
 *
 * These packs have no bone called "hand" — the fingers hang straight off the
 * forearm — so the hand is whatever the finger bones share as a parent, with
 * the forearm as the fallback.
 *
 * Default side is LEFT, because the clip we play while armed is "Weapon" and
 * these rigs animate that with the left arm. "Punch" is the right-handed one.
 * Attaching to the hand that isn't swinging leaves the weapon hanging still
 * while the other arm does the work.
 */
export function findHandBone(root: THREE.Object3D, side: 'L' | 'R' = 'L'): THREE.Object3D | null {
  let finger: THREE.Object3D | null = null;
  let forearm: THREE.Object3D | null = null;
  const fingers = [`Middle1${side}`, `Index1${side}`];
  const arm = new RegExp(`^(LowerArm${side}|Hand${side}|Forearm${side})$`, 'i');
  root.traverse((o) => {
    if (!finger && fingers.includes(o.name)) finger = o;
    if (!forearm && arm.test(o.name)) forearm = o;
  });
  const f = finger as THREE.Object3D | null;
  return f?.parent ?? forearm ?? null;
}

/** A finger base on the given side, which marks where the fist is. */
function findFingerBone(root: THREE.Object3D, side: 'L' | 'R'): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  const names = [`Middle1${side}`, `Index1${side}`, `Thumb1${side}`];
  root.traverse((o) => {
    if (!found && names.includes(o.name)) found = o;
  });
  return found;
}

/**
 * Hang a weapon model in a rig's hand and return it.
 *
 * The scale correction matters: a hand bone deep in a rig carries the whole
 * chain's accumulated scale, so parenting a world-sized model to it produced a
 * forty-metre axe. Ask the bone what it is scaled by and divide it out, and
 * the length below is real metres.
 */
export async function attachWeaponToHand(
  root: THREE.Object3D,
  src: string,
  length = 0.75,
  side: 'L' | 'R' = 'L',
  fit: import('./rigfit').Fit | null = null
): Promise<THREE.Object3D | null> {
  const hand = fit?.bone
    ? (() => { let b: THREE.Object3D | null = null;
        root.traverse((o) => { if (!b && o.name === fit.bone) b = o; }); return b; })()
      ?? findHandBone(root, side)
    : findHandBone(root, side);
  if (!hand) return null;
  const gltf = await loadWeaponModel(src);
  if (!gltf) return null;
  const model = gltf.clone(true);
  hand.updateWorldMatrix(true, false);
  const boneScale = new THREE.Vector3();
  hand.getWorldScale(boneScale);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  const inv = 1 / Math.max(boneScale.x, 1e-6);
  model.scale.setScalar((length / Math.max(size.x, size.y, size.z, 1e-3)) * inv);
  // Sit it in the FIST, not at the bone's origin.
  //
  // On these rigs the fingers hang straight off the forearm, so the bone we
  // attach to starts at the elbow — placing the weapon at its origin gripped
  // the character's wrist. The finger bones are where the hand actually is, so
  // ask them: take a finger's position in this bone's local space and put the
  // weapon there, nudged a little further along the same direction to reach
  // the middle of the grip.
  let grip = new THREE.Vector3(0, 0.1 * inv, 0);
  let rot = new THREE.Euler(Math.PI / 2, 0, 0);
  if (fit) {
    // A human looked at this one and said where it goes. Trust that over any
    // amount of reasoning about bone origins.
    grip.set(fit.pos[0] * inv, fit.pos[1] * inv, fit.pos[2] * inv);
    rot = new THREE.Euler(fit.rot[0], fit.rot[1], fit.rot[2]);
    model.scale.setScalar((fit.scale / Math.max(size.x, size.y, size.z, 1e-3)) * inv);
  } else {
    const finger = findFingerBone(root, side);
    if (finger) {
      finger.updateWorldMatrix(true, false);
      const local = hand.worldToLocal(finger.getWorldPosition(new THREE.Vector3()));
      if (local.length() > 1e-4) grip = local.multiplyScalar(1.35);
    }
  }
  model.position.copy(grip);
  model.rotation.copy(rot);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.castShadow = true;
  });
  hand.add(model);
  return model;
}

const weaponCache = new Map<string, THREE.Group>();
async function loadWeaponModel(src: string): Promise<THREE.Group | null> {
  const cached = weaponCache.get(src);
  if (cached) return cached;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(src);
    weaponCache.set(src, gltf.scene);
    return gltf.scene;
  } catch {
    return null;
  }
}

/** Full path for a weapon named bare, e.g. "Axe". */
export function weaponSrc(name: string) {
  return name.includes('/') ? name : `/models/quaternius-pirate/${name}.glb`;
}

const BLADES: Record<string, Blade> = {
  Cutlass: { name: 'Cutlass', damage: 26, reach: 2.9 },
  Sword: { name: 'Sword', damage: 24, reach: 2.8 },
  Axe: { name: 'Axe', damage: 30, reach: 2.6 },
  Dagger: { name: 'Dagger', damage: 16, reach: 2.2 },
  'Tool Axe': { name: 'Axe', damage: 22, reach: 2.5 },
  Pickaxe: { name: 'Pickaxe', damage: 20, reach: 2.5 },
  Shovel: { name: 'Shovel', damage: 14, reach: 2.6 },
  'Large Bone': { name: 'Bone', damage: 18, reach: 2.5 },
};

/** Bare hands. The baseline every other number is judged against. */
export const FISTS: Blade = { name: 'Fists', damage: 14, reach: 2.3 };

function baseName(src: string) {
  return src.split('/').pop()?.replace(/\.glb$/i, '') ?? '';
}

/** The blade stats for whatever is being carried, or fists. */
export function bladeFor(item: PlacedItem | null): Blade {
  if (!item) return FISTS;
  return BLADES[baseName(item.entry.src)] ?? FISTS;
}

export function isBomb(item: PlacedItem) {
  return baseName(item.entry.src) === 'Bomb';
}

export const BLAST = { radius: 3.4, damage: 40, lift: 4.2 };

/**
 * Detonate at a point: hurt everything alive nearby (falling off with
 * distance) and fling the loose props. Returns the number of things hit.
 */
export function explode(
  state: State,
  x: number,
  y: number,
  z: number,
  hurt: (target: PlacedItem, amount: number, fromX: number, fromZ: number) => void,
  hurtPlayerAt?: (amount: number, fromX: number, fromZ: number) => void,
  playerPos?: THREE.Vector3
) {
  let hits = 0;
  for (const target of [...placed]) {
    if (target.entry.paint || target.entry.src === 'spawn') continue;
    const d = Math.hypot(target.obj.position.x - x, target.obj.position.z - z);
    if (d > BLAST.radius || Math.abs(target.obj.position.y - y) > 3) continue;
    const falloff = 1 - d / BLAST.radius;
    if (target.clips?.length) {
      hurt(target, Math.round(BLAST.damage * falloff), x, z);
      hits++;
    } else if (target.entry.pickable && !target.carried) {
      // Loose props get thrown rather than damaged — a blast that only hurts
      // characters reads as a magic spell, not an explosion.
      const dir = Math.atan2(target.obj.position.x - x, target.obj.position.z - z);
      target.flight = {
        vx: Math.sin(dir) * 5 * falloff,
        vy: BLAST.lift * falloff,
        vz: Math.cos(dir) * 5 * falloff,
        restY: target.entry.y,
        harmless: true,
      };
    }
  }
  // The thrower is not immune. Standing next to your own bomb should cost you.
  if (playerPos && hurtPlayerAt) {
    const d = Math.hypot(playerPos.x - x, playerPos.z - z);
    if (d < BLAST.radius && Math.abs(playerPos.y - y) < 3) {
      hurtPlayerAt(Math.round(BLAST.damage * (1 - d / BLAST.radius) * 0.6), x, z);
    }
  }
  void state;
  return hits;
}

/** A short-lived flash so a blast is something you SEE, not just survive. */
export function blastFlash(scene: THREE.Scene, x: number, y: number, z: number) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffc663, transparent: true, opacity: 0.9 });
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), mat);
  ball.position.set(x, y + 0.3, z);
  scene.add(ball);
  const t0 = performance.now();
  const grow = () => {
    const t = (performance.now() - t0) / 380;
    if (t >= 1) {
      scene.remove(ball);
      ball.geometry.dispose();
      mat.dispose();
      return;
    }
    ball.scale.setScalar(1 + t * 4.5);
    mat.opacity = 0.9 * (1 - t);
    requestAnimationFrame(grow);
  };
  requestAnimationFrame(grow);
}

/** Remove a spent bomb from the world. */
export function consume(state: State, item: PlacedItem) {
  removeItem(state, item);
}

export { instantiate };
