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
    const dist = (radius / Math.tan((camera!.fov * Math.PI) / 360)) * 1.5;
    camera!.position.set(dist * 0.7, dist * 0.55, dist * 0.8);
    camera!.lookAt(0, 0, 0);

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
