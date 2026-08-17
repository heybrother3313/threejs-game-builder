import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLAYER_CHOICES } from './character';
import { findHandBone } from './weapons';

/**
 * The weapon-fitting bench.
 *
 * Every rig puts its grip somewhere slightly different and every weapon has
 * its own natural axis, so "where does a cutlass sit in a frog's fist" is
 * models x weapons worth of numbers that can only be judged by looking. Two
 * attempts at deriving them — bone origin, then finger position — both landed
 * the blade around the character's wrist, because the thing being optimised is
 * how it LOOKS and the loop had no eyes in it.
 *
 * So this puts a human in the loop: pick a character and a weapon, watch the
 * Weapon clip play on a loop, drag six sliders, save. Fits live in
 * localStorage and are consumed by the attach code, falling back to the
 * automatic guess for anything unfitted.
 */

export type Fit = {
  bone: string;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: number;
};

const KEY = 'sandbox-weapon-fits-v1';

function allFits(): Record<string, Fit> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Fit>;
  } catch {
    return {};
  }
}

/** Fit key: one per character+weapon pair, falling back to character-only. */
function keyFor(character: string, weapon: string) {
  return `${character.split('/').pop()}|${weapon.split('/').pop()}`;
}

export function fitFor(character: string, weapon: string): Fit | null {
  const fits = allFits();
  return fits[keyFor(character, weapon)] ?? fits[`${character.split('/').pop()}|*`] ?? null;
}

function saveFit(character: string, weapon: string, fit: Fit, allWeapons: boolean) {
  const fits = allFits();
  fits[allWeapons ? `${character.split('/').pop()}|*` : keyFor(character, weapon)] = fit;
  localStorage.setItem(KEY, JSON.stringify(fits));
}

/** Weapons worth fitting — the ones that change how a swing hits. */
const WEAPONS = [
  'Cutlass', 'Sword', 'Swords', 'Axe', 'Axe Rifle', 'Dagger', 'Large Bone',
  'Pistol', 'Rifle', 'Shotgun',
].map((n) => ({ label: n, src: `/models/quaternius-pirate/${n}.glb` }));

/* ----------------------------------------------------------------- bench --- */

let el: HTMLDivElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let mixer: THREE.AnimationMixer | null = null;
let rig: THREE.Group | null = null;
let weapon: THREE.Object3D | null = null;
/**
 * The weapon's size BEFORE it was parented to a bone.
 *
 * Measuring it afterwards returns a world size that already includes the
 * bone's (large) scale, and dividing that out again shrank the weapon to
 * nothing — which is why the bench showed a character holding thin air.
 */
let weaponIntrinsic = 1;
let hand: THREE.Object3D | null = null;
let clock: THREE.Clock | null = null;
let raf = 0;
let current = { character: PLAYER_CHOICES[0].src, weapon: WEAPONS[0].src };
let fit: Fit = { bone: '', pos: [0, 0.1, 0], rot: [Math.PI / 2, 0, 0], scale: 0.75 };

export function isRigFitOpen() {
  // getComputedStyle, not the inline value: the stylesheet hides this panel by
  // default, so an empty inline display still means hidden.
  return !!el && getComputedStyle(el).display !== 'none';
}

export function toggleRigFit(open?: boolean) {
  ensure();
  if (!el) return;
  const show = open ?? !isRigFitOpen();
  // 'block', never '' — clearing the inline style hands control back to the
  // stylesheet, which says display:none, so the panel stayed invisible while
  // every DOM check said it was open.
  el.style.display = show ? 'block' : 'none';
  if (show) {
    void load();
    tick();
  } else if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function ensure() {
  if (el) return;
  const style = document.createElement('style');
  style.textContent = `
    /* Capped and scrollable: at 803px of sliders it ran off the bottom of a
       750px window, which put Save out of reach. */
    #rigfit { position:fixed; right:16px; top:74px; width:300px; z-index:26;
      max-height: calc(100vh - 100px); overflow-y:auto; overscroll-behavior:contain;
      pointer-events:auto; display:none; padding:10px;
      font-family: var(--font-body, Inter, sans-serif);
      background: var(--surface-face,#faf6ef); color: var(--text-primary,#111);
      border:2px solid var(--border-strong,#111); border-radius:14px;
      box-shadow:0 5px 0 var(--border-strong,#111); }
    #rigfit h3 { margin:0 0 6px; font-family: var(--font-display,sans-serif); font-size:14px; }
    #rigfit canvas { width:100%; height:200px; border:2px solid var(--border-strong,#111);
      border-radius:10px; background:#dfe9ef; display:block; margin-bottom:8px; }
    #rigfit label { display:block; font-size:10px; letter-spacing:.1em;
      text-transform:uppercase; color: var(--text-secondary,#666); margin:6px 0 2px; }
    #rigfit select, #rigfit input[type=text] { width:100%; font-size:12px; padding:4px 6px;
      border:2px solid var(--border-strong,#111); border-radius:6px;
      background: var(--surface-page,#fff); color:inherit; }
    #rigfit .row { display:flex; gap:6px; align-items:center; }
    #rigfit .row input[type=range] { flex:1; }
    #rigfit .row .v { width:44px; text-align:right; font-size:11px; font-variant-numeric:tabular-nums; }
    #rigfit .btns { display:flex; gap:6px; margin-top:10px; }
    #rigfit button { flex:1; font-family:inherit; font-size:12px; font-weight:700;
      padding:6px; border:2px solid var(--border-strong,#111); border-radius:8px;
      background: var(--surface-page,#fff); cursor:pointer;
      box-shadow:0 3px 0 var(--border-strong,#111); }
    #rigfit button.accent { background: var(--accent,#fd9b9b); }
    #rigfit .note { font-size:10px; color: var(--text-secondary,#666); margin-top:6px; }
  `;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'rigfit';
  el.innerHTML = `
    <h3>Weapon fit</h3>
    <canvas></canvas>
    <label>Character</label>
    <select id="rf-char">${PLAYER_CHOICES.map(
      (c) => `<option value="${c.src}">${c.label}</option>`
    ).join('')}</select>
    <label>Weapon</label>
    <select id="rf-weap">${WEAPONS.map(
      (w) => `<option value="${w.src}">${w.label}</option>`
    ).join('')}</select>
    <label>Bone</label>
    <select id="rf-bone"></select>
    ${['x', 'y', 'z'].map((a, i) => `
      <label>Position ${a.toUpperCase()}</label>
      <div class="row"><input type="range" id="rf-p${i}" min="-0.6" max="0.6" step="0.005">
      <span class="v" id="rf-pv${i}"></span></div>`).join('')}
    ${['x', 'y', 'z'].map((a, i) => `
      <label>Rotation ${a.toUpperCase()}</label>
      <div class="row"><input type="range" id="rf-r${i}" min="-3.15" max="3.15" step="0.02">
      <span class="v" id="rf-rv${i}"></span></div>`).join('')}
    <label>Length (m)</label>
    <div class="row"><input type="range" id="rf-s" min="0.2" max="2" step="0.01">
    <span class="v" id="rf-sv"></span></div>
    <div class="btns">
      <button id="rf-save" class="accent">Save</button>
      <button id="rf-all">Save for all weapons</button>
    </div>
    <div class="note">Plays the Weapon clip on a loop — judge it moving, not at rest.</div>
  `;
  document.body.appendChild(el);

  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1.4, 0.1, 50);
  camera.position.set(1.5, 1.5, 2.4);
  camera.lookAt(0, 0.9, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8a70, 2.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  clock = new THREE.Clock();

  const on = (id: string, ev: string, fn: (e: Event) => void) =>
    el!.querySelector(id)!.addEventListener(ev, fn);
  on('#rf-char', 'change', (e) => {
    current.character = (e.target as HTMLSelectElement).value;
    void load();
  });
  on('#rf-weap', 'change', (e) => {
    current.weapon = (e.target as HTMLSelectElement).value;
    void load();
  });
  on('#rf-bone', 'change', (e) => {
    fit.bone = (e.target as HTMLSelectElement).value;
    reattach();
  });
  for (let i = 0; i < 3; i++) {
    on(`#rf-p${i}`, 'input', (e) => {
      fit.pos[i] = parseFloat((e.target as HTMLInputElement).value);
      apply();
    });
    on(`#rf-r${i}`, 'input', (e) => {
      fit.rot[i] = parseFloat((e.target as HTMLInputElement).value);
      apply();
    });
  }
  on('#rf-s', 'input', (e) => {
    fit.scale = parseFloat((e.target as HTMLInputElement).value);
    apply();
  });
  on('#rf-save', 'click', () => {
    saveFit(current.character, current.weapon, fit, false);
    flash('Saved for this pair');
  });
  on('#rf-all', 'click', () => {
    saveFit(current.character, current.weapon, fit, true);
    flash('Saved for every weapon');
  });
  el.addEventListener('keydown', (ev) => ev.stopPropagation());
  el.style.display = 'none';
}

function flash(msg: string) {
  const n = el?.querySelector('.note');
  if (!n) return;
  const was = n.textContent;
  n.textContent = msg;
  setTimeout(() => { n.textContent = was; }, 1400);
}

async function load() {
  if (!scene) return;
  if (rig) scene.remove(rig);
  rig = null;
  weapon = null;
  const gltf = await new GLTFLoader().loadAsync(current.character);
  rig = gltf.scene;
  const box = new THREE.Box3().setFromObject(rig);
  const s = 1.55 / Math.max(box.getSize(new THREE.Vector3()).y, 1e-3);
  rig.scale.setScalar(s);
  rig.position.y = -new THREE.Box3().setFromObject(rig).min.y;
  scene.add(rig);
  mixer = new THREE.AnimationMixer(rig);
  const clip =
    gltf.animations.find((a) => a.name.split('|').includes('Weapon')) ??
    gltf.animations.find((a) => a.name.split('|').includes('Idle'));
  if (clip) mixer.clipAction(clip).play();

  // Bone list, hand first so the sensible default is preselected.
  const bones: string[] = [];
  rig.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o.name); });
  const auto = findHandBone(rig, 'L');
  const saved = fitFor(current.character, current.weapon);
  fit = saved
    ? { ...saved, pos: [...saved.pos], rot: [...saved.rot] }
    : { bone: auto?.name ?? bones[0] ?? '', pos: [0, 0.1, 0], rot: [Math.PI / 2, 0, 0], scale: 0.75 };
  const sel = el!.querySelector('#rf-bone') as HTMLSelectElement;
  sel.innerHTML = bones
    .map((b) => `<option value="${b}"${b === fit.bone ? ' selected' : ''}>${b}</option>`)
    .join('');
  syncInputs();
  reattach();
}

function syncInputs() {
  if (!el) return;
  for (let i = 0; i < 3; i++) {
    (el.querySelector(`#rf-p${i}`) as HTMLInputElement).value = String(fit.pos[i]);
    (el.querySelector(`#rf-pv${i}`) as HTMLElement).textContent = fit.pos[i].toFixed(3);
    (el.querySelector(`#rf-r${i}`) as HTMLInputElement).value = String(fit.rot[i]);
    (el.querySelector(`#rf-rv${i}`) as HTMLElement).textContent = fit.rot[i].toFixed(2);
  }
  (el.querySelector('#rf-s') as HTMLInputElement).value = String(fit.scale);
  (el.querySelector('#rf-sv') as HTMLElement).textContent = fit.scale.toFixed(2);
}

async function reattach() {
  if (!rig) return;
  if (weapon) weapon.parent?.remove(weapon);
  weapon = null;
  const found: THREE.Object3D[] = [];
  rig.traverse((o) => { if (o.name === fit.bone) found.push(o); });
  hand = found[0] ?? null;
  if (!hand) return;
  const gltf = await new GLTFLoader().loadAsync(current.weapon);
  weapon = gltf.scene;
  const raw = new THREE.Box3().setFromObject(weapon).getSize(new THREE.Vector3());
  weaponIntrinsic = Math.max(raw.x, raw.y, raw.z, 1e-3);
  hand.add(weapon);
  apply();
}

/** Sliders are in METRES and radians; the bone's scale is divided out. */
function apply() {
  if (!weapon || !hand) return;
  hand.updateWorldMatrix(true, false);
  const bs = new THREE.Vector3();
  hand.getWorldScale(bs);
  const inv = 1 / Math.max(bs.x, 1e-6);
  weapon.scale.setScalar((fit.scale / weaponIntrinsic) * inv);
  weapon.position.set(fit.pos[0] * inv, fit.pos[1] * inv, fit.pos[2] * inv);
  weapon.rotation.set(fit.rot[0], fit.rot[1], fit.rot[2]);
  syncInputs();
}

function tick() {
  if (!renderer || !scene || !camera || !el || !isRigFitOpen()) return;
  const c = renderer.domElement;
  if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
    renderer.setSize(c.clientWidth, c.clientHeight, false);
    camera.aspect = c.clientWidth / Math.max(c.clientHeight, 1);
    camera.updateProjectionMatrix();
  }
  mixer?.update(clock?.getDelta() ?? 0.016);
  renderer.render(scene, camera);
  raf = requestAnimationFrame(tick);
}
