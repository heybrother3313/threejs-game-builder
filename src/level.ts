import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { State } from 'vibegame';
import { Body, BodyType, Collider } from 'vibegame/physics';
import { getScene } from 'vibegame/rendering';
import { Transform } from 'vibegame/transforms';
import type { NpcConfig } from './npc';
import assetMeta from './levels/asset-meta.json';
import defaultLevel from './levels/default-level.json';

type AssetMeta = { height: number; standYFrac: number; baseXZFrac: [number, number] };
const META = assetMeta as unknown as Record<string, AssetMeta>;

/** Metadata for a src path, keyed by bare model name. */
function metaFor(src: string): AssetMeta | undefined {
  return META[src.split('/').pop()!.replace(/\.glb$/, '')];
}

/**
 * Level placement machinery, shared by the seed level and the map builder.
 *
 * An entry is pure data (JSON-able — this IS the level format). instantiate()
 * turns one into a scene object plus, when solid, an invisible box collider
 * sized from the model's measured bounds. Colliders are raw physics entities
 * with NO Renderer on purpose: hiding instanced renderers coincided with
 * grabbed items vanishing, so we never create one at all.
 */
export type LevelEntry = {
  src: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Absolute uniform scale. Filled in from fitHeight/fitMaxDim on first load. */
  scale?: number;
  fitHeight?: number;
  fitMaxDim?: number;
  flip?: boolean;
  solid?: boolean;
  /** Shave the collider's top — lumpy rocks, roof ridges. */
  trimTop?: number;
  /** Force the collider footprint (metres). Palms need a trunk, not a box
   *  as wide as their fronds. */
  colliderXZ?: number;
  /** Place the model's TOP at y instead of its base (decks). */
  alignTop?: boolean;
  /** Ride a named kinematic body (the raft). Not editable in the builder. */
  follow?: string;
  /** Can be picked up and thrown. Shown with a marker ring in build mode. */
  pickable?: boolean;
  /** Play an animation clip on loop (characters/creatures). */
  clip?: string;
  /** Patrol path: world-space [x, z] waypoints walked in a loop. */
  path?: [number, number][];
  /** Patrol speed, units/s. */
  speed?: number;
  /** Walking into this NPC shows this line (with a "!" marker overhead). */
  dialog?: string;
  /** Behaviour, combat and conversation — see npc.ts. */
  npc?: NpcConfig;
  /** A painted ground tile rather than a model. */
  paint?: string;
};

export type PlacedItem = {
  entry: LevelEntry;
  obj: THREE.Group;
  solidE: number | null;
  /** Oriented wireframe box — matches the collider, rotation included. */
  border: THREE.LineSegments;
  followBase?: THREE.Vector3;
  followOrigin?: THREE.Vector3;
  /** Animation rig for NPC assets (characters ship 14+ clips). */
  mixer?: THREE.AnimationMixer;
  clips?: THREE.AnimationClip[];
  /** Ring drawn under pickable items so you can see what's interactive. */
  marker?: THREE.Mesh;
  /** Set while the player is carrying this item. */
  carried?: boolean;
  /** In-flight throw: velocity plus the height it should land at. */
  flight?: { vx: number; vy: number; vz: number; restY: number };
  /** Patrol state: distance travelled along the path loop. */
  pathDist?: number;
  /** The visual's authored base position, so path motion is a pure offset. */
  homePos?: THREE.Vector3;
  /** Path polyline shown in the builder. */
  pathLine?: THREE.Line;
  /** "!" sprite over NPCs that have dialog. */
  bang?: THREE.Sprite;
  currentAction?: THREE.AnimationAction;
};

/** Ground paint palette — the "terrain" side of the builder. */
export const PAINTS: Record<string, number> = {
  sand: 0xe8d6a0,
  grass: 0x77a95b,
  water: 0x3f7fb2,
  road: 0xb9a689,
  rock: 0x9aa7ad,
  jungle: 0x3f6b3a,
};
export const PAINT_TILE = 2;

export const placed: PlacedItem[] = [];

/**
 * Bump this whenever SEED changes in a way players must receive. An autosaved
 * level takes priority over the seed, so edits to the default course are
 * invisible to anyone with a save — which is exactly why the ship and cannon
 * stayed walk-through after being marked solid.
 */
const STORAGE_KEY = 'sandbox-level-v4';
const modelCache = new Map<string, Promise<THREE.Group>>();
const loader = new GLTFLoader();

/** Animation clips per source file, captured alongside the cached scene. */
const modelClips = new Map<string, THREE.AnimationClip[]>();

export function loadModel(src: string): Promise<THREE.Group> {
  let p = modelCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) =>
      loader.load(
        src,
        (g) => {
          modelClips.set(src, g.animations ?? []);
          resolve(g.scene);
        },
        undefined,
        reject
      )
    );
    modelCache.set(src, p);
  }
  return p;
}

/** Clip names available for a model, for the builder's NPC controls. */
export function clipsFor(src: string) {
  return (modelClips.get(src) ?? []).map((c) => c.name);
}

/** Kit clips are named "CharacterArmature|…|Idle|…" — match a whole segment. */
export function findClip(clips: THREE.AnimationClip[], want: string) {
  return (
    clips.find((c) => c.name.split('|').includes(want)) ??
    clips.find((c) => c.name.toLowerCase().includes(want.toLowerCase())) ??
    null
  );
}

/**
 * The default course, authored in build mode and exported with Save.
 *
 * This is the hand-off point for level design: build in the browser, hit Save,
 * and drop the file over src/levels/default-level.json — no code changes. The
 * exported format is already self-contained (absolute scale, no fit hints), so
 * it round-trips exactly as it looked when saved.
 */
export const SEED = defaultLevel as LevelEntry[];

/** Kept for reference: the original hand-written course. */
export const ORIGINAL_SEED: LevelEntry[] = [
  { src: P('Rock'), x: 4, y: 0, z: -2, rotY: 0.4, fitHeight: 1.35, solid: true, trimTop: 0.15 },
  { src: P('Rocks-38eDa0gjwZ'), x: 7.5, y: 0, z: -4, rotY: 2.1, fitHeight: 2.15, solid: true, trimTop: 0.15 },
  { src: P('Rock-4vHWF8XUBn'), x: 10.5, y: 0, z: -1.5, rotY: 5.0, fitHeight: 2.95, solid: true, trimTop: 0.15 },
  { src: P('Rocks'), x: -8, y: 0, z: 4, rotY: 0.3, fitHeight: 1.7, solid: true, trimTop: 0.1 },
  { src: P('Rocks-IFU6cm2Xow'), x: -10.5, y: 0, z: 0.5, rotY: 1.2, fitHeight: 2.9, solid: true, trimTop: 0.1 },
  { src: P('Rock-6cytS1cPiL'), x: -12, y: 0, z: -3.5, rotY: 0.7, fitHeight: 4.1, solid: true, trimTop: 0.1 },
  { src: P('House-2kytqGs4rH'), x: -12, y: 0, z: -7, rotY: 0.5, fitHeight: 4.8, solid: true, trimTop: 0.2 },
  { src: P('Wood'), x: 6, y: 2.775, z: 3.5, rotY: 0, fitMaxDim: 2.9, alignTop: true, follow: 'raft' },
  { src: P('Ship'), x: 2, y: -1.4, z: 16, rotY: 2.2, fitHeight: 8, solid: true, trimTop: 3.4 },
  // Sized by footprint (a dock is wide, not tall); trimTop lands you on the
  // planks rather than on top of its posts.
  { src: P('Dock'), x: 6.5, y: 0, z: 10.5, rotY: Math.PI, fitMaxDim: 4.5, solid: true, trimTop: 1.74 },
  // Palms collide on the trunk only — a box as wide as the fronds would stop
  // you a couple of metres from the tree.
  { src: P('Palm Tree'), x: -6, y: 0, z: 7.5, rotY: 1.1, fitHeight: 3.6, solid: true, colliderXZ: 0.5 },
  { src: P('Palm Tree-A6cKJYFsIb'), x: 9.5, y: 0, z: 6.5, rotY: 3.9, fitHeight: 3.0, solid: true, colliderXZ: 0.5 },
  { src: P('Palm Tree-P0tgwyXBgr'), x: 12.5, y: 0, z: -6, rotY: 5.6, fitHeight: 3.2, solid: true, colliderXZ: 0.5 },
  { src: P('Barrel'), x: 1.8, y: 0, z: 4.4, rotY: 0.9, fitHeight: 0.85, solid: true },
  { src: P('Chest Gold'), x: -2.6, y: 0, z: 5.6, rotY: 2.4, fitHeight: 0.75, solid: true },
  { src: P('Cannon'), x: 0.5, y: 0, z: -5, rotY: -0.6, fitHeight: 1.0, solid: true },
  { src: P('Anchor'), x: -4.5, y: 0, z: 6.8, rotY: 0.9, fitMaxDim: 1.3, solid: true },
  { src: P('Skull'), x: 11.5, y: 0, z: -3.5, rotY: 1.8, fitHeight: 0.6 },
];

export function P(name: string) {
  return `/models/quaternius-pirate/${name}.glb`;
}

function makeShadows(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}

function destroySolid(state: State, item: PlacedItem) {
  if (item.solidE !== null && state.exists(item.solidE)) {
    state.destroyEntity(item.solidE);
  }
  item.solidE = null;
}

function buildSolid(state: State, item: PlacedItem) {
  destroySolid(state, item);
  if (!item.entry.solid) return;
  const { size, center, yaw } = orientedBox(item);
  const qy = Math.sin(yaw / 2);
  const qw = Math.cos(yaw / 2);
  const e = state.createEntity();
  state.addComponent(e, Transform, {
    posX: center.x, posY: center.y, posZ: center.z,
    rotY: qy, rotW: qw, eulerY: (yaw * 180) / Math.PI,
    scaleX: 1, scaleY: 1, scaleZ: 1,
  });
  state.addComponent(e, Body, {
    type: BodyType.Fixed,
    posX: center.x, posY: center.y, posZ: center.z,
    rotY: qy, rotW: qw, eulerY: (yaw * 180) / Math.PI,
    mass: 0, gravityScale: 0,
  });
  state.addComponent(e, Collider, {
    shape: 0, sizeX: size.x, sizeY: size.y, sizeZ: size.z,
  });
  item.solidE = e;
}

/**
 * A box around the model's BULK, not its extremities.
 *
 * A full bounding box is what made colliders feel like huge invisible walls:
 * one cannon barrel, anchor fluke or roof overhang inflates the whole box, and
 * you collide with empty air well before you touch anything. Taking a quantile
 * of the actual vertex cloud per axis ignores those thin outliers — the box
 * hugs the part of the model that reads as solid. Low-poly kit meshes are a
 * few hundred verts, so this is cheap; big ones get sampled.
 */
export function coreBounds(obj: THREE.Object3D, q = 0.04): THREE.Box3 {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const v = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 2000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      xs.push(v.x);
      ys.push(v.y);
      zs.push(v.z);
    }
  });
  if (xs.length === 0) return new THREE.Box3().setFromObject(obj);
  const pick = (arr: number[], t: number) => {
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))];
  };
  // Keep the true floor: you must be able to stand where the model meets ground.
  const minY = Math.min(...ys);
  return new THREE.Box3(
    new THREE.Vector3(pick(xs, q), minY, pick(zs, q)),
    new THREE.Vector3(pick(xs, 1 - q), pick(ys, 1 - q), pick(zs, 1 - q))
  );
}

/**
 * The oriented box that hugs a placed model: size, world centre, and yaw.
 *
 * An axis-aligned box around a rotated model is enormous — a ship turned 45°
 * gets a box with corners far out in open water, which is what made borders
 * look loose and made items stop you long before you touched them. So measure
 * with the rotation temporarily removed (giving a tight box in the model's own
 * frame), then rotate that box back. Rapier colliders can be oriented, so the
 * physics box matches what's drawn.
 */
export function orientedBox(item: PlacedItem) {
  const { obj, entry } = item;
  const yaw = obj.rotation.y;
  obj.rotation.y = 0;
  obj.updateMatrixWorld(true);
  const local = entry.solid ? coreBounds(obj) : new THREE.Box3().setFromObject(obj);
  obj.rotation.y = yaw;
  obj.updateMatrixWorld(true);

  // Where the collider's ceiling goes. Preference order: an explicit trimTop
  // the author dialled in, else the analysed standable surface from
  // asset-meta.json (scale-invariant, so it survives resizing), else the
  // model's own top. This is what stops you landing on a mast or a roof ridge.
  if (entry.solid) {
    if (entry.trimTop !== undefined) {
      local.max.y -= entry.trimTop;
    } else {
      const meta = metaFor(entry.src);
      if (meta && meta.standYFrac < 0.999) {
        const fullHeight = meta.height * (entry.scale ?? 1);
        local.max.y = Math.min(local.max.y, local.min.y + fullHeight * meta.standYFrac);
      }
    }
  }
  const size = local.getSize(new THREE.Vector3());
  size.x = Math.max(size.x, 0.05);
  size.y = Math.max(size.y, 0.05);
  size.z = Math.max(size.z, 0.05);
  if (entry.solid && entry.colliderXZ) {
    size.x = entry.colliderXZ;
    size.z = entry.colliderXZ;
  }

  // Rotation happens about the object's own origin, so spin the unrotated
  // centre around that pivot to find where the box actually sits.
  const c = local.getCenter(new THREE.Vector3());
  const pivot = obj.position;
  const dx = c.x - pivot.x;
  const dz = c.z - pivot.z;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const center = new THREE.Vector3(
    pivot.x + dx * cos + dz * sin,
    c.y,
    pivot.z - dx * sin + dz * cos
  );
  return { size, center, yaw };
}

/** Apply the entry's transform to an already-loaded object. */
function applyEntryTransform(item: PlacedItem) {
  const { entry, obj } = item;
  obj.rotation.set(0, entry.rotY, 0);
  const s = entry.scale ?? 1;
  obj.scale.set(entry.flip ? -s : s, s, s);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const baseY = entry.alignTop ? entry.y - size.y : entry.y;
  obj.position.set(
    entry.x - (box.min.x + box.max.x) / 2,
    baseY - box.min.y,
    entry.z - (box.min.z + box.max.z) / 2
  );
  obj.updateMatrixWorld(true);
}

/** A flat painted ground tile — the terrain half of the builder. */
function instantiatePaint(state: State, entry: LevelEntry): PlacedItem | null {
  const scene = getScene(state);
  if (!scene) return null;
  const colour = PAINTS[entry.paint!] ?? 0xffffff;
  const geo = new THREE.PlaneGeometry(PAINT_TILE, PAINT_TILE);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: colour, roughness: 1 })
  );
  mesh.receiveShadow = true;
  // Sit just above the ground plane; polygonOffset keeps it from z-fighting.
  (mesh.material as THREE.MeshStandardMaterial).polygonOffset = true;
  (mesh.material as THREE.MeshStandardMaterial).polygonOffsetFactor = -2;
  mesh.position.set(entry.x, entry.y + 0.012, entry.z);
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);

  const border = makeBorder(scene);
  const item: PlacedItem = { entry, obj: group, solidE: null, border };
  placed.push(item);
  refreshBorder(item);
  return item;
}

function makeBorder(scene: THREE.Scene) {
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x33ff88, depthTest: false, transparent: true })
  );
  border.renderOrder = 999;
  border.visible = false;
  scene.add(border);
  return border;
}

export async function instantiate(state: State, entry: LevelEntry): Promise<PlacedItem | null> {
  const scene = getScene(state);
  if (!scene) return null;
  if (entry.paint) return instantiatePaint(state, entry);
  let src: THREE.Group;
  let clips: THREE.AnimationClip[] = [];
  try {
    src = await loadModel(entry.src);
    clips = modelClips.get(entry.src) ?? [];
  } catch {
    console.warn('[level] failed to load', entry.src);
    return null;
  }
  // Skinned models (Tentacle, the characters) must be cloned with
  // SkeletonUtils or the copy shares/loses its skeleton and renders at a wild
  // size — that's what made a placed Tentacle enormous and unselectable.
  let skinned = false;
  src.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  const obj = (skinned ? cloneSkinned(src) : src.clone(true)) as THREE.Group;
  makeShadows(obj);
  if (skinned) {
    obj.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) m.frustumCulled = false;
    });
  }

  // Resolve fit -> absolute scale once, then the entry is self-contained.
  if (entry.scale === undefined) {
    obj.updateMatrixWorld(true);
    const probe = new THREE.Box3().setFromObject(obj);
    const size = probe.getSize(new THREE.Vector3());
    const usable = Number.isFinite(size.x + size.y + size.z) && size.y > 1e-3;
    if (!usable) {
      console.warn('[level] unmeasurable model, using scale 1:', entry.src);
    }
    let s = 1;
    if (usable) {
      if (entry.fitHeight) {
        s = entry.fitHeight / size.y;
        // Fitting by height explodes anything modelled lying down — an anchor
        // on its side is barely tall, so matching its height scaled it to nine
        // units across. Cap the longest axis relative to the requested height.
        // Only catch pathological cases (an anchor is ~10:1); genuinely wide
        // pieces like docks should use fitMaxDim instead of being squashed.
        const longest = Math.max(size.x, size.y, size.z) * s;
        const cap = entry.fitHeight * 4;
        if (longest > cap) s *= cap / longest;
      } else if (entry.fitMaxDim) {
        s = entry.fitMaxDim / Math.max(size.x, size.y, size.z, 1e-3);
      }
    }
    entry.scale = s;
    delete entry.fitHeight;
    delete entry.fitMaxDim;
  }

  // Unit cube wireframe, scaled/rotated to the collider each refresh.
  const border = makeBorder(scene);
  const item: PlacedItem = { entry, obj, solidE: null, border, clips };
  applyEntryTransform(item);
  item.homePos = obj.position.clone();
  scene.add(obj);
  buildSolid(state, item);
  refreshBorder(item);
  applyMarker(item, scene);
  syncPathLine(item, scene);
  syncBang(item, scene);

  // NPCs: anything with clips can idle in place. Default to Idle so a dropped
  // character breathes instead of standing in its bind pose.
  if (clips.length > 0) {
    const mixer = new THREE.AnimationMixer(obj);
    const clip = findClip(clips, entry.clip ?? 'Idle') ?? clips[0];
    if (clip) {
      const action = mixer.clipAction(clip);
      action.play();
      item.currentAction = action;
    }
    item.mixer = mixer;
    if (!entry.clip) entry.clip = 'Idle';
  }

  if (entry.follow) {
    const target = state.getEntityByName(entry.follow);
    if (target !== null) {
      item.followBase = obj.position.clone();
      item.followOrigin = new THREE.Vector3(
        Body.posX[target], Body.posY[target], Body.posZ[target]
      );
    }
  }
  placed.push(item);
  return item;
}

export function refreshBorder(item: PlacedItem) {
  const { size, center, yaw } = orientedBox(item);
  item.border.position.copy(center);
  item.border.rotation.set(0, yaw, 0);
  item.border.scale.set(size.x, size.y, size.z);
}

/** Re-apply a mutated entry: move/rotate/scale/flip, then rebuild physics.
 *  Also the single home of marker/path/bang upkeep — markers used to be
 *  positioned only by builder edits, so carrying an item left its coral ring
 *  behind at the old spot. */
export function reapply(state: State, item: PlacedItem) {
  applyEntryTransform(item);
  item.homePos = item.obj.position.clone();
  item.pathDist = 0;
  buildSolid(state, item);
  refreshBorder(item);
  const scene = getScene(state);
  if (scene) {
    applyMarker(item, scene);
    syncPathLine(item, scene);
    syncBang(item, scene);
  }
}

export function removeItem(state: State, item: PlacedItem) {
  const scene = getScene(state);
  destroySolid(state, item);
  scene?.remove(item.obj);
  scene?.remove(item.border);
  const i = placed.indexOf(item);
  if (i >= 0) placed.splice(i, 1);
}

/** A ring under pickable items so interactivity is visible, not guessed. */
function applyMarker(item: PlacedItem, scene: THREE.Scene) {
  if (item.entry.pickable && !item.marker) {
    const { size, center } = orientedBox(item);
    const r = Math.max(size.x, size.z) * 0.62;
    const geo = new THREE.RingGeometry(r * 0.82, r, 28);
    geo.rotateX(-Math.PI / 2);
    const marker = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xfd9b9b,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    marker.renderOrder = 998;
    marker.position.set(center.x, center.y - size.y / 2 + 0.03, center.z);
    scene.add(marker);
    item.marker = marker;
  } else if (!item.entry.pickable && item.marker) {
    item.marker.parent?.remove(item.marker);
    item.marker = undefined;
  } else if (item.marker) {
    const { size, center } = orientedBox(item);
    item.marker.position.set(center.x, center.y - size.y / 2 + 0.03, center.z);
  }
}

export function syncMarker(state: State, item: PlacedItem) {
  const scene = getScene(state);
  if (scene) applyMarker(item, scene);
}

/**
 * Freeze switch for NPC life. In build mode a patrolling fish is a moving
 * target you can't click, so freezing snaps every creature back to its
 * authored spot and holds its pose; play mode (or the builder's Anims toggle)
 * turns life back on.
 */
let animationsPlaying = true;
export function setAnimationsPlaying(v: boolean) {
  animationsPlaying = v;
  if (!v) {
    for (const item of placed) {
      if (item.entry.path || item.mixer) {
        applyEntryTransform(item);
        item.pathDist = 0;
        positionBang(item);
      }
    }
  }
}

/** Paths are authoring chrome: visible while building, hidden in play. */
let pathsVisible = false;
export function setPathsVisible(v: boolean) {
  pathsVisible = v;
  for (const item of placed) {
    if (item.pathLine) item.pathLine.visible = v;
  }
}

/** Dashed polyline showing an NPC's patrol loop. */
function syncPathLine(item: PlacedItem, scene: THREE.Scene) {
  if (item.pathLine) {
    scene.remove(item.pathLine);
    item.pathLine.geometry.dispose();
    item.pathLine = undefined;
  }
  const path = item.entry.path;
  if (!path || path.length < 2) return;
  const pts = [...path, path[0]].map(([x, z]) => new THREE.Vector3(x, item.entry.y + 0.06, z));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0xfd9b9b, dashSize: 0.3, gapSize: 0.18, depthTest: false })
  );
  line.computeLineDistances();
  line.renderOrder = 997;
  line.visible = pathsVisible;
  scene.add(line);
  item.pathLine = line;
}

/** "!" above NPCs that have something to say. */
function syncBang(item: PlacedItem, scene: THREE.Scene) {
  if (item.bang && !item.entry.dialog) {
    scene.remove(item.bang);
    item.bang = undefined;
    return;
  }
  if (!item.entry.dialog || item.bang) {
    if (item.bang) positionBang(item);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fd9b9b';
  ctx.font = 'bold 44px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 32, 34);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })
  );
  sprite.scale.setScalar(0.55);
  sprite.renderOrder = 1001;
  scene.add(sprite);
  item.bang = sprite;
  positionBang(item);
}

function positionBang(item: PlacedItem) {
  if (!item.bang) return;
  const box = new THREE.Box3().setFromObject(item.obj);
  item.bang.position.set(
    (box.min.x + box.max.x) / 2,
    box.max.y + 0.45,
    (box.min.z + box.max.z) / 2
  );
}

/** Swap an NPC's looping clip (used by the builder's animation picker). */
export function setClip(item: PlacedItem, segment: string) {
  if (!item.mixer || !item.clips) return;
  const clip = findClip(item.clips, segment);
  if (!clip) return;
  item.entry.clip = segment;
  const next = item.mixer.clipAction(clip);
  next.reset().fadeIn(0.18).play();
  item.currentAction?.fadeOut(0.18);
  item.currentAction = next;
}



/**
 * Per-frame level upkeep: raft riders, NPC animation, and thrown items.
 *
 * Thrown props are integrated by hand rather than handed to Rapier: a placed
 * item's collider is a static box, and turning it into a dynamic body mid-flight
 * (then back again on landing) is far more machinery than a parabola needs.
 */
export function updateLevel(state: State, dt: number, playerPos?: THREE.Vector3) {
  void playerPos;
  for (const item of placed) {
    if (animationsPlaying && item.mixer) item.mixer.update(dt);

    // Patrol: walk the authored loop, facing along it. Motion is applied as an
    // offset from the item's authored position so nothing is persisted.
    const path = item.entry.path;
    if (animationsPlaying && path && path.length >= 2 && item.homePos && !item.carried && !item.flight) {
      const pts = [...path, path[0]];
      const lens: number[] = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        lens.push(l);
        total += l;
      }
      if (total > 0.01) {
        item.pathDist = ((item.pathDist ?? 0) + (item.entry.speed ?? 1.3) * dt) % total;
        let d = item.pathDist;
        let seg = 0;
        while (d > lens[seg]) {
          d -= lens[seg];
          seg++;
        }
        const t = lens[seg] > 0 ? d / lens[seg] : 0;
        const px = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
        const pz = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
        item.obj.position.x = item.homePos.x + (px - item.entry.x);
        item.obj.position.z = item.homePos.z + (pz - item.entry.z);
        item.obj.rotation.y = Math.atan2(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
        positionBang(item);
      }
    }


    if (item.flight) {
      const f = item.flight;
      f.vy -= 22 * dt;
      item.entry.x += f.vx * dt;
      item.entry.y += f.vy * dt;
      item.entry.z += f.vz * dt;
      if (item.entry.y <= f.restY) {
        item.entry.y = f.restY;
        item.flight = undefined;
        reapply(state, item); // land: rebuild the collider where it stopped
        persist();
      } else {
        applyEntryTransform(item);
      }
      continue;
    }

    if (!item.entry.follow || !item.followBase || !item.followOrigin) continue;
    const e = state.getEntityByName(item.entry.follow);
    if (e === null) continue;
    item.obj.position.set(
      item.followBase.x + (Transform.posX[e] - item.followOrigin.x),
      item.followBase.y + (Transform.posY[e] - item.followOrigin.y),
      item.followBase.z + (Transform.posZ[e] - item.followOrigin.z)
    );
  }
}

/** Nearest pickable item within reach of a point, facing considered. */
export function findPickable(px: number, pz: number, fx: number, fz: number, reach: number) {
  let best: PlacedItem | null = null;
  let bestDist = reach;
  for (const item of placed) {
    if (!item.entry.pickable || item.carried || item.flight) continue;
    const dx = item.entry.x - px;
    const dz = item.entry.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist > bestDist || dist < 1e-3) continue;
    if ((dx / dist) * fx + (dz / dist) * fz < 0.2) continue;
    best = item;
    bestDist = dist;
  }
  return best;
}

/** Carry: strip physics, park the visual in the player's hands. */
export function beginCarry(state: State, item: PlacedItem) {
  item.carried = true;
  if (item.solidE !== null && state.exists(item.solidE)) {
    state.destroyEntity(item.solidE);
    item.solidE = null;
  }
  item.border.visible = false;
}

export function carryTo(item: PlacedItem, x: number, y: number, z: number, yaw: number) {
  item.entry.x = x;
  item.entry.y = y;
  item.entry.z = z;
  item.entry.rotY = yaw;
  applyEntryTransform(item);
  if (item.marker) item.marker.visible = false;
}

export function endCarry(
  state: State,
  item: PlacedItem,
  velocity: { vx: number; vy: number; vz: number } | null,
  restY: number
) {
  item.carried = false;
  if (item.marker) item.marker.visible = true;
  if (velocity) {
    item.flight = { ...velocity, restY };
  } else {
    item.entry.y = restY;
    reapply(state, item);
    persist();
  }
}

/**
 * Asset analysis pass — run once, commit the result, ship it.
 *
 * Colliders were being hand-tuned per placement, which doesn't survive
 * rescaling and doesn't scale to 71 models. This scans every asset's geometry
 * and derives, in MODEL-LOCAL units (so it's scale-invariant):
 *
 *  - `height`/`footprint`: tight bounds of the bulk.
 *  - `standY`: the surface you should land on. Found by area-weighting only
 *    the upward-facing triangles and taking the highest band that still holds
 *    real area — that's a dock's planks, not the mast above them, and a
 *    house's roof, not its chimney. Area is the key: a mast has many vertices
 *    but almost no horizontal surface.
 *  - `baseXZ`: footprint measured BELOW that surface, so a palm gets its trunk
 *    rather than a box as wide as its fronds.
 *
 * Output lands in src/levels/asset-meta.json and is consumed at load time.
 */
export async function analyzeAssets(files: string[]) {
  const out: Record<string, unknown> = {};
  for (const file of files) {
    const src = P(file);
    let model: THREE.Group;
    try {
      model = await loadModel(src);
    } catch {
      continue;
    }
    const probe = model.clone(true);
    probe.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(probe);
    const size = box.getSize(new THREE.Vector3());

    // Area of upward-facing triangles, bucketed by height.
    const bands = new Map<number, number>();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();
    const BAND = Math.max(size.y / 60, 1e-3);
    probe.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const idx = geo.getIndex();
      const tri = idx ? idx.count / 3 : pos.count / 3;
      for (let t = 0; t < tri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const area = n.length() / 2;
        if (area < 1e-6) continue;
        n.normalize();
        if (n.y < 0.75) continue; // not a surface you can stand on
        const y = (a.y + b.y + c.y) / 3;
        const k = Math.round((y - box.min.y) / BAND);
        bands.set(k, (bands.get(k) ?? 0) + area);
      }
    });

    let standY = size.y;
    if (bands.size > 0) {
      const maxArea = Math.max(...bands.values());
      const keys = [...bands.entries()]
        .filter(([, area]) => area >= maxArea * 0.2)
        .map(([k]) => k)
        .sort((x, y) => y - x);
      if (keys.length) standY = keys[0] * BAND;
    }

    // Footprint of everything at or below the standable surface.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const v = new THREE.Vector3();
    probe.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (v.y - box.min.y > standY + BAND) continue;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      }
    });

    out[file] = {
      height: +size.y.toFixed(4),
      sizeXZ: [+size.x.toFixed(4), +size.z.toFixed(4)],
      // Fractions of height => scale-invariant.
      standYFrac: +Math.min(1, Math.max(0, standY / Math.max(size.y, 1e-6))).toFixed(4),
      baseXZFrac: [
        +((maxX - minX) / Math.max(size.x, 1e-6)).toFixed(4),
        +((maxZ - minZ) / Math.max(size.z, 1e-6)).toFixed(4),
      ],
    };
  }
  return out;
}

export function serialize(): string {
  return JSON.stringify(placed.map((i) => i.entry), null, 1);
}

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, serialize());
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

export function clearPersisted() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Adopt a level.json exported earlier (or by someone else) and reload. */
export function importLevel(json: string) {
  const parsed = JSON.parse(json) as LevelEntry[];
  if (!Array.isArray(parsed)) throw new Error('level.json must be an array');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  location.reload();
}

export async function loadLevel(state: State) {
  let entries: LevelEntry[] = SEED;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      entries = JSON.parse(saved) as LevelEntry[];
      console.info(`[level] loaded ${entries.length} entries from saved level`);
    } catch {
      console.warn('[level] saved level unreadable — using seed');
    }
  }
  await Promise.all(entries.map((e) => instantiate(state, { ...e })));
}
