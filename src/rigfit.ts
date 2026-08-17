import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLAYER_CHOICES } from './character';
import { KEY, allFits, fitFor, localFits, type Fit } from './weapons';
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

/**
 * Everything that can be fitted to a hand.
 *
 * Grouped because the bench now does three different jobs. A blade is fitted
 * against the swing; a thrown thing is fitted against the wind-up, where what
 * matters is that it sits in the palm rather than lining up with an arc; a rod
 * is held through a whole idle and never leaves the hand at all. They reduce to
 * the same six numbers against a bone, but a flat list of fifteen entries hides
 * which job you are doing.
 *
 * Guns stay out — a different mechanic, and none is implemented.
 */
const pirate = (n: string) => ({ label: n, src: `/models/quaternius-pirate/${n}.glb` });

const WEAPON_GROUPS: { group: string; items: { label: string; src: string }[] }[] = [
  { group: 'Melee', items: ['Cutlass', 'Sword', 'Axe', 'Dagger', 'Large Bone'].map(pirate) },
  // Thrown: the bomb is the one that already has behaviour behind it; the rest
  // are here because anything you can pick up is something you can throw, and
  // it has to look held while you wind up.
  { group: 'Thrown', items: ['Bomb', 'Rock', 'Prop Bottle', 'Skull', 'Chicken Leg'].map(pirate) },
  // The rod ships as five tiers (Lvl1..Lvl5) behind hashed filenames — these
  // are genuinely different models, not the usual duplicate-export trap.
  { group: 'Fishing', items: [
    { label: 'Fishing Rod I', src: '/models/animated-fish-bundle/Fishing Rod.glb' },
    { label: 'Fishing Rod II', src: '/models/animated-fish-bundle/Fishing Rod-0YAR0Lg58p.glb' },
    { label: 'Fishing Rod III', src: '/models/animated-fish-bundle/Fishing Rod-lDlWQjn9Zg.glb' },
    { label: 'Fishing Rod IV', src: '/models/animated-fish-bundle/Fishing Rod-9AOHhRPHE7.glb' },
    { label: 'Fishing Rod V', src: '/models/animated-fish-bundle/Fishing Rod-aOabqWh68m.glb' },
  ] },
];

const WEAPONS = WEAPON_GROUPS.flatMap((g) => g.items);

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
/** Playback controls: a swing at full speed is too quick to fit against. */
let playing = true;
let speed = 0.35;
/** The loaded character's clips, and which one the bench is holding. */
let clips: THREE.AnimationClip[] = [];
let clipName = '';
/** True once the user picks a pose by hand, so reloads stop overriding it. */
let clipPinned = false;

/** Which group the selected item belongs to, for pose and group defaults. */
function groupOf(src: string) {
  return WEAPON_GROUPS.find((g) => g.items.some((i) => i.src === src))?.group ?? 'Melee';
}

/** Sensible starting pose for the kind of thing being fitted. */
function preferredClip(): string {
  // A blade is judged mid-swing, a thrown thing during the wind-up (Punch is
  // the closest thing these rigs have to one), and a rod just hangs there.
  const g = groupOf(current.weapon);
  const want =
    g === 'Melee' ? ['Weapon', 'Punch']
    : g === 'Thrown' ? ['Punch', 'Weapon', 'Idle']
    : ['Idle', 'Walk'];
  for (const w of want) {
    const hit = clips.find((a) => a.name.split('|').includes(w));
    if (hit) return hit.name;
  }
  return clips[0]?.name ?? '';
}

function playClip(name: string) {
  if (!mixer) return;
  mixer.stopAllAction();
  const clip = clips.find((a) => a.name === name);
  if (!clip) return;
  clipName = name;
  mixer.clipAction(clip).play();
  applySpeed();
}

function applySpeed() {
  if (mixer) mixer.timeScale = playing ? speed : 0;
  const v = el?.querySelector('#rf-speedv');
  if (v) v.textContent = playing ? `${speed.toFixed(2)}x` : 'held';
  const s = el?.querySelector('#rf-speed') as HTMLInputElement | null;
  if (s) s.value = String(speed);
}

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
  el.style.display = show ? 'flex' : 'none';
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
    /* Two columns: a big preview that stays put, and a scrolling control
       strip beside it. One narrow column meant the model was tiny AND the
       playback controls sat below the fold, so you could never watch the
       swing and press pause at the same time. */
    #rigfit { position:fixed; left:50%; top:74px; transform:translateX(-50%);
      width:min(760px, calc(100vw - 32px)); height:min(560px, calc(100vh - 110px));
      z-index:26; display:none; padding:12px; gap:12px;
      pointer-events:auto;
      font-family: var(--font-body, Inter, sans-serif);
      background: var(--surface-face,#faf6ef); color: var(--text-primary,#111);
      border:2px solid var(--border-strong,#111); border-radius:14px;
      box-shadow:0 5px 0 var(--border-strong,#111); }
    #rigfit .stage { flex:1 1 auto; display:flex; flex-direction:column; min-width:0; }
    #rigfit .controls { flex:0 0 268px; overflow-y:auto; overscroll-behavior:contain;
      padding-right:4px; }
    #rigfit h3 { margin:0 0 6px; font-family: var(--font-display,sans-serif); font-size:14px; }
    #rigfit canvas { width:100%; flex:1 1 auto; border:2px solid var(--border-strong,#111);
      border-radius:10px; background:#dfe9ef; display:block; }
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
    <div class="stage">
      <h3>Weapon fit</h3>
      <canvas></canvas>
    </div>
    <div class="controls">
    <label>Character</label>
    <select id="rf-char">${PLAYER_CHOICES.map(
      (c) => `<option value="${c.src}">${c.label}</option>`
    ).join('')}</select>
    <label>Item</label>
    <select id="rf-weap">${WEAPON_GROUPS.map(
      (g) => `<optgroup label="${g.group}">${g.items.map(
        (w) => `<option value="${w.src}">${w.label}</option>`
      ).join('')}</optgroup>`
    ).join('')}</select>
    <label>Pose</label>
    <select id="rf-clip"></select>
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
    <label>Animation</label>
    <div class="row">
      <button id="rf-play" style="flex:0 0 74px">Pause</button>
      <input type="range" id="rf-speed" min="0" max="1" step="0.05">
      <span class="v" id="rf-speedv"></span>
    </div>
    <div class="btns">
      <button id="rf-save" class="accent">Save</button>
      <button id="rf-all">Save for all weapons</button>
    </div>
    <div class="btns">
      <button id="rf-export">Export fits for the repo</button>
    </div>
    <div class="note">Scrub the speed to zero to hold a pose, then fit against it.</div>
    </div>
  `;
  document.body.appendChild(el);

  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1.4, 0.1, 50);
  frameCharacter();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8a70, 2.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  clock = new THREE.Clock();

  // The preview is its own little viewport: drag to turn the model, wheel to
  // zoom. Bound to the canvas so it never reaches the builder behind it.
  let dragging = false;
  let last = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    view.yaw -= (e.clientX - last.x) * 0.01;
    view.pitch = Math.max(-0.9, Math.min(1.2, view.pitch + (e.clientY - last.y) * 0.006));
    last = { x: e.clientX, y: e.clientY };
    frameCharacter();
    e.stopPropagation();
  });
  const endDrag = (e: PointerEvent) => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    view.zoom = Math.max(0.35, Math.min(3, view.zoom * (1 + Math.sign(e.deltaY) * 0.12)));
    frameCharacter();
  }, { passive: false });

  const on = (id: string, ev: string, fn: (e: Event) => void) =>
    el!.querySelector(id)!.addEventListener(ev, fn);
  on('#rf-char', 'change', (e) => {
    current.character = (e.target as HTMLSelectElement).value;
    void load();
  });
  on('#rf-weap', 'change', (e) => {
    const prev = groupOf(current.weapon);
    current.weapon = (e.target as HTMLSelectElement).value;
    // Crossing from Melee to Thrown means a different pose is the right one to
    // judge against, so an explicit pick only sticks within its own group.
    if (groupOf(current.weapon) !== prev) clipPinned = false;
    void load();
  });
  on('#rf-clip', 'change', (e) => {
    clipPinned = true;
    playClip((e.target as HTMLSelectElement).value);
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
  on('#rf-play', 'click', () => {
    playing = !playing;
    (el!.querySelector('#rf-play') as HTMLElement).textContent = playing ? 'Pause' : 'Play';
    applySpeed();
  });
  on('#rf-speed', 'input', (e) => {
    speed = parseFloat((e.target as HTMLInputElement).value);
    applySpeed();
  });
  on('#rf-export', 'click', () => {
    const blob = new Blob([JSON.stringify(allFits(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'weapon-fits.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    flash('Downloaded — drop it in src/levels/');
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
  // The pose you fit against depends on the job. A blade is judged mid-swing,
  // so Weapon is the default — but a bomb is judged during the wind-up and a
  // rod during a plain Idle, and neither of those is the Weapon clip. These
  // rigs have no Throw, so the choice has to be the user's.
  clips = gltf.animations;
  const want =
    clipPinned && clips.some((a) => a.name === clipName) ? clipName : preferredClip();
  const clipSel = el!.querySelector('#rf-clip') as HTMLSelectElement;
  clipSel.innerHTML = clips
    .map((a) => {
      const short = a.name.split('|').pop() ?? a.name;
      return `<option value="${a.name}"${a.name === want ? ' selected' : ''}>${short}</option>`;
    })
    .join('');
  playClip(want);
  applySpeed();

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

/**
 * Pull the camera back far enough to hold the whole character.
 *
 * A fixed camera position framed the model fine in a short wide box and then
 * filled the frame with its head once the stage became tall and narrow. The
 * distance is derived from the field of view and the current aspect instead,
 * so it re-frames whenever the panel is resized.
 */
/** Orbit state for the preview: yaw, pitch and a zoom multiplier. */
const view = { yaw: 0.42, pitch: 0.12, zoom: 1 };

function frameCharacter() {
  if (!camera) return;
  const H = 2.0; // character plus headroom, metres
  const W = 1.4; // arms out
  const vfov = (camera.fov * Math.PI) / 180;
  const forHeight = H / 2 / Math.tan(vfov / 2);
  const forWidth = W / 2 / Math.tan(vfov / 2) / Math.max(camera.aspect, 1e-3);
  const dist = Math.max(forHeight, forWidth) * 1.12 * view.zoom;
  // Spherical around the character's middle, so drag orbits and wheel dollies.
  const cy = 0.8 + Math.sin(view.pitch) * dist * 0.35;
  camera.position.set(
    Math.sin(view.yaw) * Math.cos(view.pitch) * dist,
    Math.max(0.15, 1.0 + Math.sin(view.pitch) * dist * 0.5),
    Math.cos(view.yaw) * Math.cos(view.pitch) * dist
  );
  camera.lookAt(0, Math.min(1.3, Math.max(0.4, cy)), 0);
}

function tick() {
  if (!renderer || !scene || !camera || !el || !isRigFitOpen()) return;
  const c = renderer.domElement;
  if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
    renderer.setSize(c.clientWidth, c.clientHeight, false);
    camera.aspect = c.clientWidth / Math.max(c.clientHeight, 1);
    camera.updateProjectionMatrix();
    frameCharacter();
  }
  mixer?.update(clock?.getDelta() ?? 0.016);
  renderer.render(scene, camera);
  raf = requestAnimationFrame(tick);
}

/** Persist a fit locally; the committed file stays the shared default. */
function saveFit(character: string, weapon: string, fit: Fit, allWeapons: boolean) {
  const fits = localFits();
  const c = character.split('/').pop();
  fits[allWeapons ? `${c}|*` : `${c}|${weapon.split('/').pop()}`] = fit;
  localStorage.setItem(KEY, JSON.stringify(fits));
}
