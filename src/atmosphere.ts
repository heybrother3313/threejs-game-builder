import * as THREE from 'three';
import type { State } from 'vibegame';
import { getScene, threeCameras } from 'vibegame/rendering';
import { ISLAND } from './ground';

/**
 * The horizon. Without it the world ends at a flat clear-colour and every
 * screenshot has a table edge; three cheap pieces make it a place instead:
 *
 *   1. a gradient sky dome (zenith blue falling to a pale horizon)
 *   2. an endless ocean plane below everything the levels build
 *   3. distance fog tuned so the ocean fades out rather than stopping
 *
 * Plus a ring of silhouette islands out in the haze — unreachable set
 * dressing, but they're what makes "sail to the fishing village" feel like
 * sailing TO somewhere rather than swapping scenes.
 *
 * Fog is a play-mode effect: the build camera lives at distances where haze
 * is just interference, so the builder switches it off.
 */

const HORIZON = new THREE.Color('#cfe9f4');
const ZENITH = new THREE.Color('#82c7e6');
const OCEAN = new THREE.Color('#3f7fb2');

/** Where the sea sits. Anything that floats needs to agree with this. */
export const WATER_Y = -0.35;

let fog: THREE.Fog | null = null;
let sceneRef: THREE.Scene | null = null;
let water: THREE.Mesh | null = null;
let waterBase: Float32Array | null = null;

export function initAtmosphere(state: State) {
  const scene = getScene(state);
  if (!scene) return;
  sceneRef = scene;

  // Sky dome: vertex-coloured inverted sphere — no shader needed, and
  // MeshBasicMaterial with vertexColors interpolates the gradient for free.
  const domeGeo = new THREE.SphereGeometry(380, 24, 12);
  const pos = domeGeo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // t: 0 at the horizon (and below), 1 straight up.
    const t = Math.max(0, Math.min(1, pos.getY(i) / 380));
    c.copy(HORIZON).lerp(ZENITH, Math.pow(t, 0.65));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(
    domeGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })
  );
  dome.renderOrder = -1;
  scene.add(dome);

  // Backstop plane far below the fog line, so the animated sheet can be
  // finite without the sky ever peeking through at a glancing angle.
  const backstop = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshLambertMaterial({ color: 0x34689b })
  );
  backstop.rotation.x = -Math.PI / 2;
  backstop.position.y = -0.7;
  scene.add(backstop);
  void OCEAN;

  // The island skirt. The playfield is a rectangular slab, and a slab over
  // water is a floating table from any downward camera angle. The skirt must
  // be RECTANGULAR like the slab: a circle wide enough to cover the corners
  // (15.8 out) bulges seven units past the flat edges — sand that looks
  // walkable with nothing under it, and fish swimming over beach. A snug
  // rectangular shelf keeps the visual coastline within a step of the real
  // floor, so what looks like land IS land.
  buildShoreline(scene);
  // THE water: one animated sheet instead of two flat slabs. A vertex-colour
  // gradient runs shore→deep (light aqua over the reef, deep blue past it),
  // and a gentle multi-axis swell rolls the surface. The scene is lit mostly
  // by ambient, which flattens lighting-based facets — so each facet carries
  // its own baked ±6% tone variation. That sparkle is the whole difference
  // between "water" and "blue linoleum".
  const geo = new THREE.PlaneGeometry(320, 320, 96, 96);
  geo.rotateX(-Math.PI / 2);
  const wpos = geo.getAttribute('position') as THREE.BufferAttribute;
  const shoreC = new THREE.Color('#8fd4ea');
  const midC = new THREE.Color('#5fa3cd');
  const deepC = new THREE.Color('#34689b');
  const wcolors = new Float32Array(wpos.count * 3);
  const wc = new THREE.Color();
  for (let i = 0; i < wpos.count; i++) {
    // Distance from the island's rectangle, not its centre — the gradient
    // should hug the coast on all sides equally.
    const dx = Math.max(Math.abs(wpos.getX(i)) - (ISLAND.x + 2), 0);
    const dz = Math.max(Math.abs(wpos.getZ(i)) - (ISLAND.z + 2), 0);
    const d = Math.hypot(dx, dz);
    wc.copy(shoreC)
      .lerp(midC, Math.min(d / 10, 1))
      .lerp(deepC, Math.max(0, Math.min((d - 10) / 30, 1)));
    const sparkle =
      0.94 + 0.12 * Math.abs(Math.sin(wpos.getX(i) * 91.7 + wpos.getZ(i) * 47.9));
    wcolors[i * 3] = wc.r * sparkle;
    wcolors[i * 3 + 1] = wc.g * sparkle;
    wcolors[i * 3 + 2] = wc.b * sparkle;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(wcolors, 3));
  water = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  );
  water.position.y = WATER_Y;
  scene.add(water);
  waterBase = Float32Array.from(wpos.array as Float32Array);

  // Far islands: dark low lumps half-swallowed by the fog. Cones are enough —
  // at that distance silhouette is all that survives.
  const islandMat = new THREE.MeshLambertMaterial({ color: 0x4a7a6a });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const r = 105 + (i % 3) * 18;
    const island = new THREE.Mesh(
      new THREE.ConeGeometry(9 + (i % 3) * 5, 6 + (i % 2) * 5, 7),
      islandMat
    );
    island.position.set(Math.cos(a) * r, -0.6, Math.sin(a) * r);
    island.rotation.y = a;
    scene.add(island);
  }

  fog = new THREE.Fog(HORIZON, 48, 150);
  scene.fog = fog;

  // The dome must be inside the camera frustum or the sky ends mid-air.
  for (const cam of threeCameras.values()) {
    if (cam instanceof THREE.PerspectiveCamera && cam.far < 500) {
      cam.far = 500;
      cam.updateProjectionMatrix();
    }
  }
}

let shelfMesh: THREE.Mesh | null = null;

/** The sandy shelf hugging the island. Rebuilt when the island resizes. */
function buildShoreline(scene: THREE.Scene) {
  if (shelfMesh) {
    scene.remove(shelfMesh);
    shelfMesh.geometry.dispose();
  }
  const shelf = new THREE.Mesh(
    new THREE.BoxGeometry(ISLAND.x * 2 + 1.5, 1.0, ISLAND.z * 2 + 1.5),
    new THREE.MeshLambertMaterial({ color: 0xe8d6a0 })
  );
  shelf.position.y = -0.55; // top at -0.05, a hair under the sand top
  shelf.receiveShadow = true;
  scene.add(shelf);
  shelfMesh = shelf;
}

/** Re-fit the shoreline after the island changes size. */
export function resizeShoreline(state: State) {
  const scene = getScene(state);
  if (scene) buildShoreline(scene);
}

/**
 * Roll the swell. Call once per rendered frame (draw group). Amplitude is
 * small on purpose: fish bob at the surface, and a heavy sea would swallow
 * and expose them comically.
 */
export function updateWater() {
  if (!water || !waterBase) return;
  const t = performance.now() / 1000;
  const geo = water.geometry as THREE.PlaneGeometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const x = waterBase[i * 3];
    const z = waterBase[i * 3 + 2];
    arr[i * 3 + 1] =
      Math.sin(x * 0.7 + t * 1.1) * 0.085 +
      Math.cos(z * 0.55 + t * 0.8) * 0.085 +
      Math.sin((x + z) * 0.32 + t * 0.5) * 0.04;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Builder switch: haze helps play, hinders authoring. */
export function setAtmosphereFog(on: boolean) {
  if (sceneRef) sceneRef.fog = on ? fog : null;
}
