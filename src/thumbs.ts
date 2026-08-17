import * as THREE from 'three';
import { loadModel } from './level';

/**
 * Palette thumbnails, rendered from the real models.
 *
 * One shared offscreen renderer draws each asset once and caches a data URL.
 * Rendering is lazy (driven by an IntersectionObserver in the palette) because
 * eagerly drawing 71 models on open costs a visible hitch, and most of them are
 * never scrolled to.
 */

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

const SIZE = 192;

/**
 * Where the drawn pixels sit vertically in the last render, 0 (top) to 1
 * (bottom), or null if nothing was drawn. Reads the alpha channel, so it finds
 * the subject rather than its bounding box.
 */
function measureInkCentre(): number | null {
  if (!renderer) return null;
  const gl = renderer.getContext();
  const px = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let top = SIZE;
  let bot = -1;
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (px[(row * SIZE + col) * 4 + 3] > 12) {
        if (row < top) top = row;
        if (row > bot) bot = row;
        break;
      }
    }
  }
  if (bot < 0) return null;
  // readPixels is bottom-up; flip to match image coordinates.
  return 1 - (top + bot) / 2 / SIZE;
}

function ensureRig() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.1);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c39a, 1.6));

  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
}

export function cachedThumb(src: string) {
  return cache.get(src) ?? null;
}

export async function thumbFor(src: string): Promise<string | null> {
  const hit = cache.get(src);
  if (hit) return hit;
  const inFlight = pending.get(src);
  if (inFlight) return inFlight;

  const job = (async () => {
    ensureRig();
    let model: THREE.Group;
    try {
      model = (await loadModel(src)).clone(true);
    } catch {
      return null;
    }
    // Frame the model: centre it, then pull the camera back to fit its radius.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    model.position.sub(centre);
    scene!.add(model);

    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = (radius / Math.tan((camera!.fov * Math.PI) / 360)) * 1.35;
    camera!.position.set(dist * 0.7, dist * 0.55, dist * 0.8);
    /*
     * Aim slightly ABOVE the box centre.
     *
     * Centring the bounding box is not the same as centring what you see:
     * these rigs stand with arms and legs spread, so the box is taller than
     * the body and the visual mass — head and torso — sits in its upper half.
     * Framing the box left every portrait hugging the top of its tile with
     * dead space beneath. Looking a little higher pushes the subject down
     * into the middle of the frame.
     */
    /*
     * Two passes, because one number can't centre every rig.
     *
     * A fixed aim offset moved the subjects down but left them spread from
     * 0.36 to 0.46 of the frame — how high the visual mass sits depends on
     * the model. So: render once, measure where the ink actually is by
     * reading the alpha channel, then aim by the error and render again.
     * Costs one extra draw of a 192px offscreen frame and works for any pack
     * added later without anyone tuning a constant.
     */
    // Frame height in world units at the subject, from the vertical FOV.
    const frameH = 2 * dist * Math.tan((camera!.fov * Math.PI) / 360);
    let aimY = 0;
    // Iterate: aiming up by dY does not shift the subject by exactly dY/frameH
    // under perspective, so one correction undershoots. Three passes converge
    // to within a couple of percent for every rig tried.
    for (let pass = 0; pass < 3; pass++) {
      camera!.lookAt(0, aimY, 0);
      renderer!.render(scene!, camera!);
      const inkMid = measureInkCentre();
      if (inkMid === null) break;
      if (Math.abs(inkMid - 0.5) < 0.02) break;
      aimY += (0.5 - inkMid) * frameH;
    }
    camera!.lookAt(0, aimY, 0);

    renderer!.render(scene!, camera!);
    const url = renderer!.domElement.toDataURL('image/png');
    scene!.remove(model);
    cache.set(src, url);
    pending.delete(src);
    return url;
  })();

  pending.set(src, job);
  return job;
}
