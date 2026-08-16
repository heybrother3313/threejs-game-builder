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

const BLADES: Record<string, Blade> = {
  Cutlass: { name: 'Cutlass', damage: 26, reach: 2.9 },
  Sword: { name: 'Sword', damage: 24, reach: 2.8 },
  Swords: { name: 'Swords', damage: 28, reach: 2.9 },
  Axe: { name: 'Axe', damage: 30, reach: 2.6 },
  'Axe Rifle': { name: 'Axe Rifle', damage: 30, reach: 2.7 },
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
