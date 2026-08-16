import * as THREE from 'three';
import type { State } from 'vibegame';
import { getScene, threeCameras } from 'vibegame/rendering';

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

let fog: THREE.Fog | null = null;
let sceneRef: THREE.Scene | null = null;

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

  // Endless ocean, with everything below it hidden — the skirt and any
  // underwater geometry end at this plane instead of hanging in a void.
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshLambertMaterial({ color: OCEAN })
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -0.62;
  scene.add(ocean);

  // The island skirt. The playfield is a rectangular slab, and a slab over
  // water is a floating table from any downward camera angle. The skirt must
  // be RECTANGULAR like the slab: a circle wide enough to cover the corners
  // (15.8 out) bulges seven units past the flat edges — sand that looks
  // walkable with nothing under it, and fish swimming over beach. A snug
  // rectangular shelf keeps the visual coastline within a step of the real
  // floor, so what looks like land IS land.
  const shelf = new THREE.Mesh(
    new THREE.BoxGeometry(27.5, 1.0, 19.5),
    new THREE.MeshLambertMaterial({ color: 0xe8d6a0 })
  );
  shelf.position.y = -0.55; // top at -0.05, a hair under the sand top
  shelf.receiveShadow = true;
  scene.add(shelf);
  // The shallows double as the LAGOON SURFACE — the water level everything
  // swimmable floats in. It must cover the whole reef (fish patrol out to
  // z≈17), or fish cross from shallows (-0.3) to open sea (-0.62) mid-path
  // and appear to levitate for the deep half of their loop.
  const shallows = new THREE.Mesh(
    new THREE.BoxGeometry(44, 0.5, 40),
    new THREE.MeshLambertMaterial({ color: 0x5fa3cd })
  );
  shallows.position.y = -0.55; // top at -0.3: above the sea, below the shelf
  scene.add(shallows);

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

/** Builder switch: haze helps play, hinders authoring. */
export function setAtmosphereFog(on: boolean) {
  if (sceneRef) sceneRef.fog = on ? fog : null;
}
