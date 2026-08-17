import * as THREE from 'three';
import type { State } from 'vibegame';
import { Body, BodyType, Collider } from 'vibegame/physics';
import { getScene } from 'vibegame/rendering';
import { Transform } from 'vibegame/transforms';

/**
 * The island floor: rolling ground every level gets for free.
 *
 * This replaces the flat sand slab. It is generated rather than authored for
 * three reasons: the height is a FUNCTION, so looking up "how high is the
 * ground at (x, z)" costs no raycast and everything from prop placement to
 * NPC pathing can call it every frame; the relief can be tuned to stay inside
 * the character controller's step height; and the rim can be faded to zero so
 * the ground meets the shoreline with no seam — the failure mode of dropping
 * in a rectangular terrain model.
 *
 * Collision is a grid of thin boxes sampled from the same function. The engine
 * exposes only cuboid/ball/capsule colliders (no Rapier heightfield or
 * trimesh), so a proxy is the honest approximation; cells are small enough
 * that neighbouring steps stay well under the 0.3m autostep and it walks as a
 * slope rather than a staircase.
 */

/**
 * The playfield half-extents. Set per world before the ground is built — an
 * objective island wants room to travel through, a puzzle island wants to be
 * crossed in seconds, and everything downstream (slab, skirt, scatter bounds,
 * paint clamps) reads this rather than a literal.
 */
export const ISLAND = { x: 13, z: 9 };

/**
 * Terrain features stay the same SIZE as the island grows rather than
 * multiplying: a big island should have a few big hills you walk over, not a
 * hundred small ones. Frequency scales down with extent, which also keeps
 * slopes gentle enough for the collider grid to stay coarse.
 */
let featureScale = 1;

export function setIslandSize(x: number, z: number) {
  ISLAND.x = x;
  ISLAND.z = z;
  featureScale = Math.max(1, Math.sqrt((x * z) / (13 * 9)));
}
/**
 * Peak relief in metres. Height is measured UP FROM ZERO, never below it —
 * the base slab's top sits at y=0, so a hollow that dipped under it would
 * put the walkable floor above the visible ground, and the rim of the
 * collision grid would become a drop you fall off. Sitting the whole range
 * on top of the slab means the grid and the slab agree everywhere.
 */
const AMPLITUDE = 1.15;
/** Visual resolution: a fixed metres-per-quad, so a bigger island isn't coarser. */
const QUAD = 0.25;
/**
 * Collision resolution. Each cell is a FLAT-topped box, so the walkable
 * surface is a staircase however smooth the visual is — and at 1.0m the
 * risers were big enough to launch the character controller off the ground
 * between cells. The state machine saw that as a jump and flickered
 * Jump_Idle/Jump_Land while merely walking, which is the "skipping". Halving
 * the cell quarters the riser; the box count is still trivial for Rapier
 * static cuboids.
 */
const CELL_BASE = 0.5;

/**
 * Smooth pseudo-random relief: a few sine octaves. Deterministic, cheap, and
 * continuous, which matters — a discontinuous field would put a cliff between
 * two collision cells and read as an invisible wall.
 */
function relief(px: number, pz: number): number {
  const x = px / featureScale;
  const z = pz / featureScale;
  return (
    Math.sin(x * 0.21 + 1.3) * Math.cos(z * 0.19 - 0.7) * 0.55 +
    Math.sin(x * 0.4 - 2.1) * Math.cos(z * 0.37 + 1.9) * 0.28 +
    Math.sin((x + z) * 0.13 + 0.4) * 0.3 +
    Math.cos((x - z) * 0.31 - 1.1) * 0.14
  );
}

/**
 * Fade to zero at the coast. Without this the terrain ends in a cliff at the
 * island edge and the shoreline skirt can't hide it.
 */
function coastFade(x: number, z: number): number {
  // The ramp must stretch with the island. At a fixed 3.5m the shore rose the
  // full amplitude over 3.5 metres however big the island got, and since the
  // collision cells GROW with the island, the riser at the coast outran the
  // 0.3m autostep — the beach became a wall you could not climb.
  const ramp = 3.5 * featureScale;
  const fx = Math.min(1, Math.max(0, (ISLAND.x - Math.abs(x)) / ramp));
  const fz = Math.min(1, Math.max(0, (ISLAND.z - Math.abs(z)) / ramp));
  const t = Math.min(fx, fz);
  return t * t * (3 - 2 * t); // smoothstep
}

/** Ground height at a world position. O(1) — call it per frame, per entity. */
export function islandHeight(x: number, z: number): number {
  if (Math.abs(x) > ISLAND.x || Math.abs(z) > ISLAND.z) return 0;
  // relief() spans about ±1.27; fold it into 0..1 so the ground only ever
  // rises from the slab, and halve the slope while we're at it.
  const t = Math.max(0, Math.min(1, relief(x, z) * 0.4 + 0.5));
  return t * AMPLITUDE * coastFade(x, z);
}

const SAND = new THREE.Color('#e8d6a0');
const GRASS = new THREE.Color('#9dbf6a');
const DRY = new THREE.Color('#d8c48d');

let mesh: THREE.Mesh | null = null;
let baseMesh: THREE.Mesh | null = null;
let owned: number[] = [];

/** Tear down the ground so it can be rebuilt at a different island size. */
export function clearIslandGround(state: State) {
  const scene = getScene(state);
  // Strip physics before destroying. Dropping the entity outright left the
  // engine copying a rigid body whose Transform had already gone —
  // "[copyRigidbodyToTransforms] Entity N does not have the required
  // components" — because the body and its transform died in the wrong order.
  for (const e of owned) {
    if (!state.exists(e)) continue;
    if (state.hasComponent(e, Collider)) state.removeComponent(e, Collider);
    if (state.hasComponent(e, Body)) state.removeComponent(e, Body);
    state.destroyEntity(e);
  }
  owned = [];
  if (mesh && scene) scene.remove(mesh);
  if (baseMesh && scene) scene.remove(baseMesh);
  mesh = null;
  baseMesh = null;
}

export function initIslandGround(state: State) {
  const scene = getScene(state);
  if (!scene || mesh) return;

  const geo = new THREE.PlaneGeometry(
    ISLAND.x * 2, ISLAND.z * 2,
    Math.round((ISLAND.x * 2) / QUAD), Math.round((ISLAND.z * 2) / QUAD)
  );
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = islandHeight(x, z);
    pos.setY(i, h);
    // Sand at the waterline, dry grass on the rises — the colour carries the
    // relief, since ambient-heavy lighting flattens the facets.
    const t = Math.min(1, Math.max(0, (h + 0.15) / 0.7));
    c.copy(SAND).lerp(DRY, Math.min(1, t * 1.6)).lerp(GRASS, Math.max(0, t - 0.35) * 1.5);
    const jitter = 0.965 + 0.05 * Math.abs(Math.sin(x * 51.9 + z * 24.3));
    colors[i * 3] = c.r * jitter;
    colors[i * 3 + 1] = c.g * jitter;
    colors[i * 3 + 2] = c.b * jitter;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  );
  mesh.receiveShadow = true;
  scene.add(mesh);

  // The mass under the relief: its top sits at exactly 0, which is where the
  // terrain bottoms out, so the two agree everywhere and the grid's rim is
  // never a drop.
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(ISLAND.x * 2, 1, ISLAND.z * 2),
    new THREE.MeshLambertMaterial({ color: 0xe8d6a0 })
  );
  base.position.y = -0.5;
  scene.add(base);
  baseMesh = base;
  const e = state.createEntity();
  state.addComponent(e, Transform, {
    posX: 0, posY: -0.5, posZ: 0,
    rotY: 0, rotW: 1, eulerY: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
  });
  state.addComponent(e, Body, {
    type: BodyType.Fixed, posX: 0, posY: -0.5, posZ: 0,
    rotY: 0, rotW: 1, eulerY: 0, mass: 0, gravityScale: 0,
  });
  state.addComponent(e, Collider, {
    shape: 0, sizeX: ISLAND.x * 2, sizeY: 1, sizeZ: ISLAND.z * 2,
  });
  owned.push(e);

  buildColliders(state);
}

/** One thin box per cell, positioned from the height function directly. */
function buildColliders(state: State) {
  // Slopes flatten as the island grows (features keep their size), so cells
  // can grow with it and the box count stays roughly constant.
  const CELL = CELL_BASE * featureScale;
  const nx = Math.ceil((ISLAND.x * 2) / CELL);
  const nz = Math.ceil((ISLAND.z * 2) / CELL);
  const cx = (ISLAND.x * 2) / nx;
  const cz = (ISLAND.z * 2) / nz;
  const thick = 1.2;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = -ISLAND.x + cx * (i + 0.5);
      const z = -ISLAND.z + cz * (j + 0.5);
      // Sample the cell's corners too: a box topped at the centre height would
      // let you clip through the high shoulder of a rising cell.
      const h = Math.max(
        islandHeight(x, z),
        islandHeight(x - cx / 2, z - cz / 2),
        islandHeight(x + cx / 2, z - cz / 2),
        islandHeight(x - cx / 2, z + cz / 2),
        islandHeight(x + cx / 2, z + cz / 2)
      );
      const cy = h - thick / 2;
      const e = state.createEntity();
      state.addComponent(e, Transform, {
        posX: x, posY: cy, posZ: z,
        rotY: 0, rotW: 1, eulerY: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
      });
      state.addComponent(e, Body, {
        type: BodyType.Fixed,
        posX: x, posY: cy, posZ: z,
        rotY: 0, rotW: 1, eulerY: 0, mass: 0, gravityScale: 0,
      });
      state.addComponent(e, Collider, {
        shape: 0, sizeX: cx * 1.02, sizeY: thick, sizeZ: cz * 1.02,
      });
      owned.push(e);
    }
  }
}
