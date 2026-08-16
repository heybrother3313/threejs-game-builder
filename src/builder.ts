import * as THREE from 'three';
import type { State } from 'vibegame';
import { OrbitCamera } from 'vibegame/orbit-camera';
import { Transform } from 'vibegame/transforms';
import { threeCameras } from 'vibegame/rendering';
import {
  LevelEntry,
  PAINTS,
  PAINT_TILE,
  PlacedItem,
  clearPersisted,
  importLevel,
  instantiate,
  loadModel,
  persist,
  placed,
  reapply,
  refreshBorder,
  removeItem,
  serialize,
  setAnimationsPlaying,
  setClip,
  setPathsVisible,
  syncMarker,
} from './level';
import { cachedThumb, thumbFor } from './thumbs';
import extraPalette from './levels/extra-palette.json';
import { QUICK_PROMPTS, aiConfig, listModels, runAssistant, saveAiConfig } from './assistant';
import { PLAYER_CHOICES, playerModel, setPlayerModel } from './character';
import { DEFAULTS, resetNpc, type NpcConfig } from './npc';
import { canRedo, canUndo, initHistory, mark, redo, redoLabel, undo, undoLabel } from './history';

/**
 * The map builder: Tony Hawk park-editor semantics, not a DCC.
 *
 * Tab toggles build mode. Pick a piece and a ghost follows the cursor; click
 * drops it. Click a placed piece to select (shift-click adds), drag to move,
 * drag the arrow to change height, keys to rotate/scale/flip/mark. Paint chips
 * lay ground tiles instead. Everything autosaves; Save exports level.json and
 * Load brings one back.
 */

const KIT = '/models/quaternius-pirate';
const ANIMALS = '/models/animated-animal-pack';
const ENEMIES = '/models/animated-enemies';
const FISH = '/models/animated-fish-bundle';
const srcOf = (dir: string, name: string) => `${dir}/${name}.glb`;

type PaletteItem = { label: string; src: string; clip?: string };
type Category = { name: string; items: PaletteItem[] };

const kit = (label: string, name: string): PaletteItem => ({ label, src: srcOf(KIT, name) });
/** Animated packs idle by default so a dropped creature breathes. */
const npc = (dir: string, name: string, clip = 'Idle'): PaletteItem => ({
  label: name,
  src: srcOf(dir, name),
  clip,
});
/** Fish "idle" by swimming. */
const fish = (name: string): PaletteItem => npc(FISH, name, 'Swimming_Normal');

const CATEGORIES: Category[] = [
  {
    name: 'Terrain',
    items: [
      kit('Rock (small)', 'Rock'), kit('Rock (tall)', 'Rock-4vHWF8XUBn'),
      kit('Rock (spire)', 'Rock-6cytS1cPiL'), kit('Rock (round)', 'Rock-BvlfuHFAuI'),
      kit('Rock (flat)', 'Rock-KvXSMwoftt'), kit('Rock (chunk)', 'Rock-cg6yBEddtZ'),
      kit('Rocks (cluster)', 'Rocks'), kit('Rocks (wide)', 'Rocks-38eDa0gjwZ'),
      kit('Rocks (stack)', 'Rocks-IFU6cm2Xow'), kit('Rocks (pile)', 'Rocks-e1rgb5i2kF'),
      kit('Rocks (ridge)', 'Rocks-fy3szRMvuE'),
    ],
  },
  {
    name: 'Structures',
    items: [
      kit('Dock', 'Dock'), kit('Dock (broken)', 'Dock Broken'),
      { label: 'Dock (long)', src: srcOf(FISH, 'Dock Long') },
      { label: 'Dock (wide)', src: srcOf(FISH, 'Dock Wide') },
      { label: 'Dock (stairs)', src: srcOf(FISH, 'Dock Stairs') },
      kit('House', 'House'), kit('House (small)', 'House-2kytqGs4rH'),
      kit('House (big)', 'House-g7eSJLFi4V'), kit('Sawmill', 'Sawmill'),
      kit('Post', 'Post'), kit('Wood planks', 'Wood'),
    ],
  },
  {
    name: 'Ships',
    items: [
      kit('Ship (large)', 'Ship'), kit('Ship (small)', 'Small Ship'),
      { label: 'Boat', src: srcOf(FISH, 'Boat') }, kit('Anchor', 'Anchor'),
    ],
  },
  {
    name: 'Nature',
    items: [
      kit('Palm Tree', 'Palm Tree'), kit('Palm Tree (bend)', 'Palm Tree-A6cKJYFsIb'),
      kit('Palm Tree (tall)', 'Palm Tree-P0tgwyXBgr'), kit('Tentacle', 'Tentacle'),
    ],
  },
  {
    name: 'Animals',
    items: [
      npc(ANIMALS, 'Alpaca'), npc(ANIMALS, 'Bull'), npc(ANIMALS, 'Cow'),
      npc(ANIMALS, 'Deer'), npc(ANIMALS, 'Donkey'), npc(ANIMALS, 'Fox'),
      npc(ANIMALS, 'Horse'), npc(ANIMALS, 'Husky'), npc(ANIMALS, 'Shiba Inu'),
      npc(ANIMALS, 'Stag'), npc(ANIMALS, 'White Horse'), npc(ANIMALS, 'Wolf'),
    ],
  },
  {
    name: 'Enemies',
    items: [
      npc(ENEMIES, 'Frog'), npc(ENEMIES, 'Rat'), npc(ENEMIES, 'Snake'),
      npc(ENEMIES, 'Spider'), npc(ENEMIES, 'Wasp'),
    ],
  },
  {
    name: 'Fish',
    items: [
      fish('Anglerfish'), fish('Armored Catfish'), fish('Betta'), fish('Black Lion Fish'),
      fish('Blobfish'), fish('Blue Goldfish'), fish('Blue Tang'), fish('Butterfly Fish'),
      fish('Cardinal Fish'), fish('Clownfish'), fish('Coral Grouper'), fish('Cowfish'),
      fish('Flatfish'), fish('Flower Horn'), fish('Goblin Shark'), fish('Goldfish'),
      fish('Humphead'), fish('Koi'), fish('Lionfish'), fish('Mandarin Fish'),
      fish('Moorish Idol'), fish('Parrot Fish'), fish('Piranha'), fish('Puffer'),
      fish('Red Snapper'), fish('Royal Gramma'), fish('Shark'), fish('Sunfish'),
      fish('Swordfish'), fish('Tang'), fish('Tetra'), fish('Tuna'), fish('Turbot'),
      fish('Worm'), fish('Yellow Tang'), fish('Zebra Clown Fish'),
    ],
  },
  {
    name: 'Characters',
    items: [
      npc(KIT, 'Pirate Captain'), npc(KIT, 'Anne'), npc(KIT, 'Henry'),
      npc(KIT, 'Sharky'), npc(KIT, 'Mako'), npc(KIT, 'Skeleton'),
      npc(KIT, 'Skeleton-yq5ATpujSt'),
    ],
  },
  {
    name: 'Treasure',
    items: [
      kit('Chest (gold)', 'Chest Gold'), kit('Chest (closed)', 'Chest Closed'),
      kit('Coins', 'Coins'), kit('Gold bag', 'Gold Bag'), kit('Gold ore', 'Gold ore'),
      kit('Gem (blue)', 'Gem Blue'), kit('Gem (green)', 'Gem Green'),
      kit('Gem (pink)', 'Gem Pink'), kit('Skull', 'Skull'),
      kit('Skull (helmet)', 'Skull-VGtSTNRf2O'), kit('Large bone', 'Large Bone'),
      kit('Red X', 'Red X'),
    ],
  },
  {
    name: 'Props',
    items: [
      kit('Barrel', 'Barrel'), kit('Bucket', 'Bucket'), kit('Bucket of fish', 'Bucket of Fish'),
      kit('Bottle', 'Prop Bottle'), kit('Bomb', 'Bomb'), kit('Cannon', 'Cannon'),
      kit('Lute', 'Lute'), kit('Paper', 'Paper'), kit('Chicken leg', 'Chicken Leg'),
      { label: 'Fishing rod', src: srcOf(FISH, 'Fishing Rod') },
      { label: 'Lure', src: srcOf(FISH, 'Lure') },
    ],
  },
  {
    name: 'Weapons',
    items: [
      kit('Cutlass', 'Cutlass'), kit('Sword', 'Sword'), kit('Swords', 'Swords'),
      kit('Dagger', 'Dagger'), kit('Axe', 'Axe'), kit('Axe rifle', 'Axe Rifle'),
      kit('Pistol', 'Pistol'), kit('Rifle', 'Rifle'), kit('Shotgun', 'Shotgun'),
    ],
  },
];

// Generated packs (Nature Kit, People) come from a manifest so new zips can
// be added without hand-curating labels.
for (const cat of extraPalette as { name: string; clip: string | null; items: [string, string][] }[]) {
  CATEGORIES.push({
    name: cat.name,
    items: cat.items.map(([label, src]) => ({
      label,
      src,
      ...(cat.clip ? { clip: cat.clip } : {}),
    })),
  });
}

export let buildMode = false;
/** Read-only view of the current selection, for tests and diagnostics. */
export function selectionInfo() {
  return selection.map((i) => i.entry.src.split('/').pop());
}

/**
 * Select items programmatically. Exists because driving selection through
 * synthetic clicks is unreliable — the raycast depends on a camera that lags
 * badly in a throttled preview — and selection bugs have been the most common
 * class here, so they need to be testable directly.
 */
export function selectItems(items: PlacedItem[]) {
  select(null, false);
  for (const it of items) select(it, true);
}

let state: State;
let getCameraEntity: () => number | undefined;
/** Shift-click adds to this; every edit applies to the whole selection. */
let selection: PlacedItem[] = [];
let ghost: THREE.Group | null = null;
let ghostSrc: string | null = null;
let armed: PaletteItem | null = null;
let paintColour: string | null = null;
let allBorders = false;
let dragging = false;
/** Pointer is down on a selected item but hasn't crossed the drag threshold. */
let dragArmed = false;
const downPx = new THREE.Vector2();
/** Where on each item the drag started, so selecting never teleports it. */
let dragOffsets: { it: PlacedItem; ox: number; oz: number }[] = [];
let clipboard: LevelEntry[] = [];
let pasteBump = 0;
/** Plain click on an already-selected item: collapse to it on release-without-drag. */
let pendingCollapse: PlacedItem | null = null;
/** While true, ground clicks append waypoints to the selected NPC's patrol. */
let drawingPath = false;
/** Whether NPC life keeps running inside build mode (off = editable). */
let buildAnims = false;
/** While true, the next ground click sets the selected NPC's guide target. */
let pickingGuide = false;
/** One history entry per paint stroke, not per tile. */
let paintedThisStroke = false;
let orbiting = false;
/** Command-drag on empty space slides the view instead of orbiting it. */
let panning = false;
/** Shift-drag on empty space rubber-bands a selection. */
let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
let marqueeEl: HTMLDivElement | null = null;
let painting = false;
const orbitPrev = new THREE.Vector2();
let savedDistance = 0;
let savedPitch = 0;
const savedOffset = { x: 0, y: 0, z: 0 };

/** Tinkercad-style height handle drawn over the selection. */
let gizmo: THREE.Group | null = null;
let gizmoDrag: { pointerY: number; startYs: number[] } | null = null;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const openSections = new Set<string>();

let ui: HTMLDivElement;
let paletteEl: HTMLDivElement;
let statusEl: HTMLDivElement;

export function initBuilder(gameState: State, cameraEntityFn: () => number | undefined) {
  state = gameState;
  getCameraEntity = cameraEntityFn;
  buildUi();
  initHistory(gameState, refreshHistoryButtons);
  refreshHistoryButtons();
  buildGizmo();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', () => {
    if (marquee) commitMarquee();
    paintedThisStroke = false;
    if (pendingCollapse && !dragging) {
      select(pendingCollapse, false);
      setStatus(describe(pendingCollapse));
    }
    pendingCollapse = null;
    dragging = false;
    dragArmed = false;
    dragOffsets = [];
    orbiting = false;
    panning = false;
    painting = false;
    gizmoDrag = null;
  });
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', layoutRightPanels);
}

/* ------------------------------------------------------------------ UI --- */

function buildUi() {
  if (!document.querySelector('link[data-plinth]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/plinth.css';
    link.dataset.plinth = 'true';
    document.head.appendChild(link);
  }

  ui = document.createElement('div');
  ui.id = 'builder';
  ui.innerHTML = `
    <style>
      #builder { position: fixed; inset: 0; display: none; pointer-events: none;
        font-family: var(--font-body); z-index: 20; }
      #builder.on { display: block; }
      #builder .plinth { background: var(--surface-face); color: var(--text-primary);
        border: var(--border-w) solid var(--border-strong);
        border-radius: var(--radius-md);
        box-shadow: 0 var(--press-rest) 0 var(--border-strong); }

      #builder .bar { position:absolute; top:16px; left:50%; transform:translateX(-50%);
        padding: var(--space-xs) var(--space-md); pointer-events:auto;
        display:flex; gap: var(--space-sm); align-items:center; }
      #builder .bar .eyebrow { font-family: var(--font-display); font-weight:600;
        font-size: var(--text-label-sm); letter-spacing: var(--tracking-eyebrow);
        text-transform: uppercase; }
      #builder button { font-family: var(--font-body); font-size: var(--text-label-sm);
        font-weight:600; background: var(--surface-page); color: var(--text-primary);
        border: var(--border-w) solid var(--border-strong); border-radius: var(--radius-sm);
        padding: 6px 10px; cursor:pointer; box-shadow: 0 3px 0 var(--border-strong);
        transition: transform var(--dur-press) var(--ease-press),
                    box-shadow var(--dur-press) var(--ease-press); }
      #builder button:hover { background: var(--surface-tint);
        transform: translateY(-1px); box-shadow: 0 4px 0 var(--border-strong); }
      #builder button:active { transform: translateY(3px); box-shadow: 0 0 0 var(--border-strong); }
      #builder button.accent { background: var(--accent); }

      #builder .palette { position:absolute; left:16px; top:74px; bottom:16px; width:250px;
        display:flex; flex-direction:column; padding: var(--space-sm); pointer-events:auto; }
      #builder .palette .scroll { overflow-y:auto; overscroll-behavior: contain; flex:1; }
      #builder .palette input { width:100%; margin-bottom: var(--space-xs);
        font-family: var(--font-body); font-size: var(--text-label-sm);
        background: var(--surface-page); color: var(--text-primary);
        border: var(--border-w) solid var(--border-strong);
        border-radius: var(--radius-sm); padding: 7px 9px; }
      #builder .palette input:focus { outline: var(--focus-w) solid var(--focus-ring);
        outline-offset: 1px; }

      /* Collapsed by default: 150+ pieces across eleven groups is a wall. */
      #builder .cat > summary { list-style:none; cursor:pointer; display:flex;
        align-items:center; gap:6px; padding: 6px 4px; user-select:none;
        font-family: var(--font-display); font-size: var(--text-label-sm);
        letter-spacing: var(--tracking-eyebrow); text-transform: uppercase;
        color: var(--text-secondary); }
      #builder .cat > summary::-webkit-details-marker { display:none; }
      #builder .cat > summary:hover { color: var(--text-primary); }
      #builder .cat .caret { transition: transform var(--dur-base) var(--ease-press);
        display:inline-block; }
      #builder .cat[open] .caret { transform: rotate(90deg); }
      #builder .cat .count { margin-left:auto; opacity:.6; }

      #builder .item { display:flex; align-items:center; gap: var(--space-xs);
        font-size: var(--text-body-sm); padding: 4px 6px; border-radius: var(--radius-sm);
        cursor:pointer; border: var(--border-w) solid transparent; }
      #builder .item:hover { background: var(--surface-tint); }
      #builder .item.armed { background: var(--accent); border-color: var(--border-strong);
        font-weight:600; }
      #builder .item img { width:68px; height:68px; flex:0 0 68px;
        border-radius: var(--radius-sm); background: var(--surface-page);
        border: var(--border-w-hair) solid var(--border-quiet); }

      #builder .paints { display:flex; flex-wrap:wrap; gap:6px; padding: 4px 2px 8px; }
      #builder .paints .chip { width:30px; height:24px; border-radius: var(--radius-sm);
        border: var(--border-w) solid var(--border-strong); cursor:pointer; padding:0;
        box-shadow: 0 2px 0 var(--border-strong); }
      #builder .paints .chip.on { outline: var(--focus-w) solid var(--focus-ring); }

      #builder .status { position:absolute; bottom:18px; left:50%; transform:translateX(-50%);
        display:flex; gap: var(--space-sm); align-items:center; flex-wrap:wrap;
        justify-content:center; padding: 7px var(--space-md);
        font-size: var(--text-label-sm); color: var(--text-secondary);
        pointer-events:none; max-width: min(92vw, 1100px); }
      #builder .status .piece { font-family: var(--font-display);
        color: var(--text-primary); font-size: var(--text-body-sm); }
      #builder kbd { font-family: var(--font-display); font-weight:600;
        font-size: var(--text-label-sm); color: var(--text-primary);
        background: var(--surface-page);
        border: var(--border-w-hair) solid var(--border-strong);
        border-radius: var(--radius-sm); box-shadow: 0 2px 0 var(--border-strong);
        padding: 1px 6px; margin-right: 3px; }
      #builder .sep { width: var(--border-w-hair); height:14px; background: var(--border-quiet); }

      /* AI settings + assistant panel (gear in the top bar). */
      #builder .settings { position:absolute; right:16px; top:74px; width:264px;
        padding: var(--space-sm); pointer-events:auto; display:none;
        max-height: calc(100vh - 108px); overflow:hidden; flex-direction:column; }
      #builder .settings.on { display:flex; }
      #builder .settings .scroll { overflow-y:auto; overscroll-behavior:contain;
        flex:1; min-height:0; padding-right:4px; }
      #builder .settings h3 { font-family: var(--font-display);
        font-size: var(--text-body-sm); margin: 0 0 var(--space-xs); }
      #builder .settings label { display:block; font-size: var(--text-label-sm);
        color: var(--text-secondary); margin: var(--space-xs) 0 2px; }
      #builder .settings input, #builder .settings textarea {
        width:100%; box-sizing:border-box; font-family: var(--font-body);
        font-size: var(--text-label-sm); background: var(--surface-page);
        color: var(--text-primary); border: var(--border-w) solid var(--border-strong);
        border-radius: var(--radius-sm); padding: 6px 8px; resize: vertical; }
      #builder .settings .row { display:flex; gap:6px; margin-top: var(--space-xs); }
      #builder .settings .row button { flex:1; }
      #builder .settings .chips { display:flex; flex-wrap:wrap; gap:5px; }
      #builder .settings .chips button { flex:0 0 auto; padding:4px 9px; font-size:11px; }
      #builder .settings .recipes { margin-top: var(--space-xs); font-size:11px;
        color: var(--text-secondary); }
      #builder .settings .recipes summary { cursor:pointer; font-weight:600;
        color: var(--text-primary); font-family: var(--font-display); }
      #builder .settings .recipes p { margin: 6px 0; line-height:1.45; }
      #builder .settings #ai-out { font-size: var(--text-label-sm);
        color: var(--text-secondary); margin-top: var(--space-xs);
        max-height:140px; overflow-y:auto; white-space:pre-wrap; }

      /* NPC behavior panel: appears when one animated piece is selected. */
      /* Both right-hand panels cap their height and scroll internally —
         the model lists and NPC controls are taller than the viewport, and a
         panel whose Save/Clear buttons sit below the fold is unusable. */
      #builder .npc { position:absolute; right:16px; top:74px; width:224px;
        padding: var(--space-sm); pointer-events:auto; display:none;
        max-height: calc(100vh - 108px); overflow:hidden;
        flex-direction:column; }
      #builder .npc.on { display:flex; }
      #builder .npc .scroll { overflow-y:auto; overscroll-behavior:contain;
        flex:1; min-height:0; padding-right:4px; }
      #builder .npc h3 { font-family: var(--font-display); font-size: var(--text-body-sm);
        margin: 0 0 var(--space-xs); }
      #builder .npc label { display:block; font-size: var(--text-label-sm);
        color: var(--text-secondary); margin: var(--space-xs) 0 2px; }
      #builder .npc select, #builder .npc input[type=text], #builder .npc input[type=number] {
        width:100%; font-family: var(--font-body); font-size: var(--text-label-sm);
        background: var(--surface-page); color: var(--text-primary);
        border: var(--border-w) solid var(--border-strong);
        border-radius: var(--radius-sm); padding: 6px 8px; }
      #builder .npc .row { display:flex; gap:6px; margin-top: var(--space-xs); }
      #builder .npc button { flex:1; }
      #builder .npc button.live { background: var(--accent); }
    </style>
    <div class="bar plinth">
      <span class="eyebrow">Build mode</span>
      <button id="b-save" class="accent">Save level.json</button>
      <button id="b-undo" title="Undo (⌘Z)">↶</button>
      <button id="b-redo" title="Redo (⇧⌘Z)">↷</button>
      <button id="b-load">Load…</button>
      <button id="b-borders">Borders (B)</button>
      <button id="b-reset">Reset</button>
      <button id="b-anim" title="Preview animations while building">Anims: off</button>
      <button id="b-settings" title="AI settings">⚙︎ AI</button>
      <input id="b-file" type="file" accept="application/json,.json" hidden />
    </div>
    <div class="palette plinth">
      <div class="scroll" id="b-palette"></div>
    </div>
    <div class="npc plinth" id="b-npc"></div>
    <div class="settings plinth" id="b-ai">
      <h3>Settings</h3>
      <div class="scroll">
      <label>Player character</label>
      <select id="player-model">
        ${PLAYER_CHOICES.map((c) => `<option value="${c.src}">${c.label}</option>`).join('')}
      </select>
      <hr style="border:none;border-top:2px solid var(--border-quiet);margin:10px 0" />
      <label>Ollama URL (proxied)</label>
      <input id="ai-url" type="text" />
      <label>Model</label>
      <input id="ai-model" type="text" list="ai-models" />
      <datalist id="ai-models"></datalist>
      <div class="row">
        <button id="ai-test">Test connection</button>
      </div>
      <label>Quick scenarios</label>
      <div class="chips" id="ai-quick"></div>
      <details class="recipes">
        <summary>Recipes — how things behave</summary>
        <p><b>Anything with an animation</b> can be punched (F) or hit by a
        thrown prop. It doesn't need a Role.</p>
        <p><b>Role</b> decides who starts fights: <i>hostile</i> chases and
        attacks you; <i>neutral</i> only fights back once struck;
        <i>friendly</i> never attacks. <i>none</i> = scenery.</p>
        <p><b>Talk</b> needs Dialogue lines. Add <i>can follow</i> for
        "[F] Follow me", or a <i>guide target</i> for "[G] Lead the way".</p>
        <p><b>Throwables</b> need <i>pickable</i> — E picks up, F throws.</p>
        <p><b>Loot</b> drops when an NPC is defeated.</p>
        <p><b>Patrol</b>: draw a path. It walks the loop until a brain state
        (chase, follow, guide) takes over.</p>
        <p><b>No collider</b>: press <b>T</b> to toggle solid. Grass, flowers
        and pebbles are placed non-solid automatically.</p>
      </details>
      <label>Ask for level changes</label>
      <textarea id="ai-prompt" rows="4"
        placeholder="Add five pine trees along the west beach and a fox patrolling between them"></textarea>
      <div class="row">
        <button id="ai-run" class="accent">Run</button>
      </div>
      <div id="ai-out"></div>
      </div>
    </div>
    <div class="status plinth" id="b-status"></div>
  `;
  document.body.appendChild(ui);
  paletteEl = ui.querySelector('#b-palette')!;
  statusEl = ui.querySelector('#b-status')!;

  renderPalette('');
  ui.querySelector('#b-save')!.addEventListener('click', saveFile);
  const fileInput = ui.querySelector('#b-file') as HTMLInputElement;
  ui.querySelector('#b-load')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      importLevel(await file.text());
    } catch (err) {
      setStatus(
        `<b class="piece">Could not read that file</b><i class="sep"></i>${(err as Error).message}`
      );
    }
  });
  ui.querySelector('#b-undo')!.addEventListener('click', () => void doUndo());
  ui.querySelector('#b-redo')!.addEventListener('click', () => void doRedo());
  ui.querySelector('#b-borders')!.addEventListener('click', toggleBorders);
  const animBtn = ui.querySelector('#b-anim') as HTMLButtonElement;
  animBtn.addEventListener('click', () => {
    buildAnims = !buildAnims;
    animBtn.textContent = buildAnims ? 'Anims: on' : 'Anims: off';
    setAnimationsPlaying(buildAnims);
  });
  wireAiPanel();
  ui.querySelector('#b-reset')!.addEventListener('click', () => {
    clearPersisted();
    location.reload();
  });
  setStatus(IDLE_STATUS);
}

function wireAiPanel() {
  const panel = ui.querySelector('#b-ai') as HTMLDivElement;
  const urlEl = panel.querySelector('#ai-url') as HTMLInputElement;
  const modelEl = panel.querySelector('#ai-model') as HTMLInputElement;
  const listEl = panel.querySelector('#ai-models') as HTMLDataListElement;
  const promptEl = panel.querySelector('#ai-prompt') as HTMLTextAreaElement;
  const outEl = panel.querySelector('#ai-out') as HTMLDivElement;
  const cfg = aiConfig();
  urlEl.value = cfg.url;
  modelEl.value = cfg.model;
  const save = () => saveAiConfig({ url: urlEl.value.trim() || '/ollama', model: modelEl.value.trim() });
  urlEl.addEventListener('change', save);
  modelEl.addEventListener('change', save);
  for (const el of [urlEl, modelEl, promptEl]) {
    el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  ui.querySelector('#b-settings')!.addEventListener('click', () => {
    panel.classList.toggle('on');
    layoutRightPanels();
  });

  const modelSel = panel.querySelector('#player-model') as HTMLSelectElement;
  modelSel.value = playerModel();
  // A reload is the honest way to swap: the rig, its clips and the animation
  // state are all bound at startup.
  modelSel.addEventListener('change', () => {
    setPlayerModel(modelSel.value);
    location.reload();
  });

  const quick = panel.querySelector('#ai-quick') as HTMLDivElement;
  for (const q of QUICK_PROMPTS) {
    const b = document.createElement('button');
    b.textContent = q.label;
    b.title = q.prompt;
    // Fill, don't fire: you should be able to tweak before spending a run.
    b.addEventListener('click', () => {
      promptEl.value = q.prompt;
      promptEl.focus();
    });
    quick.appendChild(b);
  }

  ui.querySelector('#ai-test')!.addEventListener('click', async () => {
    outEl.textContent = 'Checking…';
    try {
      const models = await listModels(aiConfig());
      listEl.innerHTML = models.map((m) => `<option value="${m}">`).join('');
      outEl.textContent = `Connected. ${models.length} models:\n${models.join('\n')}`;
    } catch (err) {
      outEl.textContent = `Not reachable: ${(err as Error).message}`;
    }
  });

  ui.querySelector('#ai-run')!.addEventListener('click', async () => {
    const req = promptEl.value.trim();
    if (!req) return;
    outEl.textContent = 'Thinking… (local model, may take a moment)';
    mark('AI edit');
    try {
      const result = await runAssistant(state, aiConfig(), req);
      outEl.textContent = result.ok
        ? result.message
        : `${result.message}\n\n${(result.raw ?? '').slice(0, 400)}`;
    } catch (err) {
      outEl.textContent = `Failed: ${(err as Error).message}`;
    }
  });
}

function drawMarquee() {
  if (!marqueeEl) {
    marqueeEl = document.createElement('div');
    marqueeEl.style.cssText =
      'position:fixed;z-index:22;pointer-events:none;border:2px dashed var(--border-strong,#111);' +
      'background:rgba(253,155,155,.18);border-radius:4px;display:none;';
    document.body.appendChild(marqueeEl);
  }
  if (!marquee) {
    marqueeEl.style.display = 'none';
    return;
  }
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  marqueeEl.style.left = `${x}px`;
  marqueeEl.style.top = `${y}px`;
  marqueeEl.style.width = `${Math.abs(marquee.x1 - marquee.x0)}px`;
  marqueeEl.style.height = `${Math.abs(marquee.y1 - marquee.y0)}px`;
  marqueeEl.style.display = 'block';
}

/** Select everything whose on-screen position falls inside the rubber band. */
function commitMarquee() {
  const box = marquee;
  marquee = null;
  drawMarquee();
  if (!box) return;
  const cam = cameraObject();
  const canvas = document.getElementById('game-canvas');
  if (!cam || !canvas) return;
  // A click without a drag is not a marquee.
  if (Math.abs(box.x1 - box.x0) < 6 && Math.abs(box.y1 - box.y0) < 6) return;

  const r = canvas.getBoundingClientRect();
  const lo = { x: Math.min(box.x0, box.x1), y: Math.min(box.y0, box.y1) };
  const hi = { x: Math.max(box.x0, box.x1), y: Math.max(box.y0, box.y1) };
  const v = new THREE.Vector3();
  let added = 0;
  for (const item of placed) {
    if (item.entry.follow) continue;
    v.copy(item.border.position).project(cam);
    if (v.z > 1) continue; // behind the camera
    const sx = r.left + ((v.x + 1) / 2) * r.width;
    const sy = r.top + (1 - (v.y + 1) / 2) * r.height;
    if (sx < lo.x || sx > hi.x || sy < lo.y || sy > hi.y) continue;
    select(item, true);
    added++;
  }
  setStatus(
    added
      ? `<b class="piece">${selection.length} selected</b><i class="sep"></i>` +
          cap(['drag'], 'move together') + cap(['⌘C'], 'copy')
      : IDLE_STATUS
  );
}

function refreshHistoryButtons() {
  const u = ui?.querySelector('#b-undo') as HTMLButtonElement | null;
  const r = ui?.querySelector('#b-redo') as HTMLButtonElement | null;
  if (u) {
    u.disabled = !canUndo();
    u.style.opacity = canUndo() ? '1' : '0.4';
    u.title = canUndo() ? `Undo ${undoLabel()} (⌘Z)` : 'Nothing to undo';
  }
  if (r) {
    r.disabled = !canRedo();
    r.style.opacity = canRedo() ? '1' : '0.4';
    r.title = canRedo() ? `Redo ${redoLabel()} (⇧⌘Z)` : 'Nothing to redo';
  }
}

async function doUndo() {
  clearSelection();
  const label = await undo();
  setStatus(
    label
      ? `<b class="piece">Undid ${label}</b><i class="sep"></i>` + cap(['⇧⌘Z'], 'redo')
      : IDLE_STATUS
  );
}

async function doRedo() {
  clearSelection();
  const label = await redo();
  setStatus(
    label ? `<b class="piece">Redid ${label}</b>` : IDLE_STATUS
  );
}

function setStatus(html: string) {
  statusEl.innerHTML = html;
}

function renderPalette(filter: string) {
  const term = filter.trim().toLowerCase();
  paletteEl.innerHTML = '';

  const search = document.createElement('input');
  search.placeholder = 'Search pieces…';
  search.value = filter;
  search.addEventListener('input', () => {
    const v = search.value;
    renderPalette(v);
    const next = paletteEl.querySelector('input') as HTMLInputElement | null;
    next?.focus();
    next?.setSelectionRange(v.length, v.length);
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  paletteEl.appendChild(search);

  // Ground paints sit at the top — terrain first, like a park editor.
  const paints = document.createElement('div');
  paints.className = 'paints';
  for (const [name, colour] of Object.entries(PAINTS)) {
    const chip = document.createElement('button');
    chip.className = `chip${paintColour === name ? ' on' : ''}`;
    chip.style.background = `#${colour.toString(16).padStart(6, '0')}`;
    chip.title = `Paint ${name}`;
    chip.addEventListener('click', () => armPaint(name));
    paints.appendChild(chip);
  }
  paletteEl.appendChild(paints);

  for (const cat of CATEGORIES) {
    const hits = cat.items.filter(
      (it) =>
        !term || it.label.toLowerCase().includes(term) || it.src.toLowerCase().includes(term)
    );
    if (hits.length === 0) continue;

    const details = document.createElement('details');
    details.className = 'cat';
    // A search opens its matches; otherwise sections stay as the user left them.
    details.open = term ? true : openSections.has(cat.name);
    details.addEventListener('toggle', () => {
      if (details.open) {
        openSections.add(cat.name);
        void fillThumbs(details);
      } else {
        openSections.delete(cat.name);
      }
    });
    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="caret">▸</span>${cat.name}<span class="count">${hits.length}</span>`;
    details.appendChild(summary);

    for (const it of hits) {
      const row = document.createElement('div');
      row.className = 'item';
      const img = document.createElement('img');
      img.dataset.src = it.src;
      const cached = cachedThumb(it.src);
      if (cached) img.src = cached;
      row.appendChild(img);
      const label = document.createElement('span');
      label.textContent = it.label;
      row.appendChild(label);
      row.addEventListener('click', () => armPalette(it, row));
      details.appendChild(row);
    }
    paletteEl.appendChild(details);
    if (details.open) void fillThumbs(details);
  }
}

/**
 * Render thumbnails for one expanded section, one at a time.
 *
 * Tied to expansion rather than an IntersectionObserver: images inside a
 * collapsed <details> have no box, so the observer never reported them as
 * intersecting and no thumbnail ever appeared. Sequential awaits keep the
 * shared offscreen renderer from being hammered when a 36-item section opens.
 */
async function fillThumbs(section: HTMLElement) {
  const imgs = [...section.querySelectorAll('img')] as HTMLImageElement[];
  for (const img of imgs) {
    if (img.getAttribute('src')) continue;
    const url = await thumbFor(img.dataset.src!);
    if (url) img.src = url;
  }
}

let npcEl: HTMLDivElement;

/** Distinct action names from the horrible piped clip names. */
function clipSegments(item: PlacedItem): string[] {
  const out = new Set<string>();
  for (const c of item.clips ?? []) {
    const segs = c.name.split('|');
    out.add(segs[segs.length - 1]);
  }
  return [...out].sort();
}

/** Rebuild the behavior panel for the current selection. */
/** The NPC and AI panels share the right edge; stack rather than overlap. */
function layoutRightPanels() {
  const settings = ui.querySelector('#b-ai') as HTMLDivElement | null;
  if (!settings) return;
  const npcOn = !!npcEl?.classList.contains('on');
  const settingsOn = settings.classList.contains('on');
  const avail = window.innerHeight - 108;

  if (npcOn && settingsOn) {
    // Share the column: neither panel may push the other off the bottom.
    const half = Math.floor((avail - 12) / 2);
    npcEl.style.maxHeight = `${half}px`;
    settings.style.maxHeight = `${half}px`;
    settings.style.top = `${74 + half + 12}px`;
  } else {
    if (npcEl) npcEl.style.maxHeight = `${avail}px`;
    settings.style.maxHeight = `${avail}px`;
    settings.style.top = '74px';
  }
}

function updateNpcPanel() {
  if (!npcEl) npcEl = ui.querySelector('#b-npc')!;
  const item = selection.length === 1 ? selection[0] : null;
  const animated = item && (item.clips?.length ?? 0) > 0;
  npcEl.classList.toggle('on', !!animated);
  if (!animated || !item) {
    drawingPath = false;
    layoutRightPanels();
    return;
  }
  const e = item.entry;
  const n: NpcConfig = e.npc ?? {};
  npcEl.innerHTML = `
    <h3>${nameOf(e.src)}</h3>
    <div class="scroll">
    <label>Animation</label>
    <select id="n-clip">${clipSegments(item)
      .map((c) => `<option${c === e.clip ? ' selected' : ''}>${c}</option>`)
      .join('')}</select>
    <label>Patrol speed</label>
    <input id="n-speed" type="number" step="0.2" min="0.2" value="${e.speed ?? 1.3}" />
    <div class="row">
      <button id="n-path" class="${drawingPath ? 'live' : ''}">${
        drawingPath ? 'Done (Enter)' : e.path?.length ? `Path (${e.path.length})` : 'Draw path'
      }</button>
      <button id="n-clearpath">Clear</button>
    </div>
    <hr style="border:none;border-top:2px solid var(--border-quiet);margin:10px 0" />
    <label>Role</label>
    <select id="n-faction">
      ${['none', 'friendly', 'neutral', 'hostile']
        .map((f) => {
          const cur = e.npc ? n.faction ?? 'neutral' : 'none';
          return `<option value="${f}"${f === cur ? ' selected' : ''}>${f}</option>`;
        })
        .join('')}
    </select>
    <label>Behaviour</label>
    <select id="n-behavior">
      ${['idle', 'patrol', 'wander', 'guard', 'flee']
        .map((b) => `<option${b === (n.behavior ?? 'idle') ? ' selected' : ''}>${b}</option>`)
        .join('')}
    </select>
    <div class="row">
      <div style="flex:1"><label>Health</label>
        <input id="n-hp" type="number" min="1" value="${n.health ?? DEFAULTS.health}" /></div>
      <div style="flex:1"><label>Damage</label>
        <input id="n-dmg" type="number" min="0" value="${n.damage ?? DEFAULTS.damage}" /></div>
    </div>
    <div class="row">
      <div style="flex:1"><label>Aggro</label>
        <input id="n-aggro" type="number" min="0" step="0.5" value="${n.aggroRadius ?? DEFAULTS.aggroRadius}" /></div>
      <div style="flex:1"><label>Reach</label>
        <input id="n-reach" type="number" min="0.5" step="0.1" value="${n.attackRadius ?? DEFAULTS.attackRadius}" /></div>
    </div>
    <label>Loot on defeat</label>
    <input id="n-loot" type="text" placeholder="/models/quaternius-pirate/Coins.glb"
      value="${(n.loot ?? '').replace(/"/g, '&quot;')}" />
    <hr style="border:none;border-top:2px solid var(--border-quiet);margin:10px 0" />
    <label>Dialogue (one line per row)</label>
    <textarea id="n-lines" rows="3" placeholder="Ahoy there!">${(n.lines ?? (e.dialog ? [e.dialog] : [])).join('\n')}</textarea>
    <div class="row">
      <label style="flex:1;margin:6px 0 0"><input id="n-follow" type="checkbox" ${n.canFollow ? 'checked' : ''} /> can follow</label>
    </div>
    <div class="row">
      <button id="n-guide" class="${pickingGuide ? 'live' : ''}">${
        pickingGuide ? 'Click a spot…' : n.guideTo ? `Guide → ${n.guideTo[0]}, ${n.guideTo[1]}` : 'Set guide target'
      }</button>
      <button id="n-guideclear">Clear</button>
    </div>
    <label>Arrival line</label>
    <input id="n-arrive" type="text" placeholder="Here we are!" value="${(n.arriveLine ?? '').replace(/"/g, '&quot;')}" />
    </div>
  `;
  npcEl.querySelector('#n-clip')!.addEventListener('change', (ev) => {
    mark('animation');
    setClip(item, (ev.target as HTMLSelectElement).value);
    persist();
  });
  npcEl.querySelector('#n-speed')!.addEventListener('change', (ev) => {
    e.speed = Math.max(0.2, parseFloat((ev.target as HTMLInputElement).value) || 1.3);
    persist();
  });
  npcEl.querySelector('#n-path')!.addEventListener('click', () => {
    drawingPath = !drawingPath;
    if (drawingPath && !e.path) e.path = [];
    updateNpcPanel();
    setStatus(
      drawingPath
        ? `<b class="piece">Drawing path</b><i class="sep"></i>` +
            cap(['click'], 'add waypoint') + cap(['Enter'], 'finish')
        : describe(item)
    );
  });
  npcEl.querySelector('#n-clearpath')!.addEventListener('click', () => {
    mark('clear path');
    delete e.path;
    drawingPath = false;
    reapply(state, item);
    persist();
    updateNpcPanel();
  });
  const commit = (patch: Partial<NpcConfig>) => {
    mark('npc');
    e.npc = { ...(e.npc ?? {}), ...patch };
    resetNpc(item);
    reapply(state, item);
    persist();
  };
  const num = (id: string, key: keyof NpcConfig) => {
    const el = npcEl.querySelector(id) as HTMLInputElement;
    el.addEventListener('keydown', (ev) => ev.stopPropagation());
    el.addEventListener('change', () => commit({ [key]: parseFloat(el.value) } as Partial<NpcConfig>));
  };

  const faction = npcEl.querySelector('#n-faction') as HTMLSelectElement;
  faction.addEventListener('change', () => {
    if (faction.value === 'none') {
      delete e.npc;
      resetNpc(item);
      reapply(state, item);
      persist();
      updateNpcPanel();
      return;
    }
    commit({ faction: faction.value as NpcConfig['faction'] });
    updateNpcPanel();
  });
  (npcEl.querySelector('#n-behavior') as HTMLSelectElement).addEventListener('change', (ev) =>
    commit({ behavior: (ev.target as HTMLSelectElement).value as NpcConfig['behavior'] })
  );
  num('#n-hp', 'health');
  num('#n-dmg', 'damage');
  num('#n-aggro', 'aggroRadius');
  num('#n-reach', 'attackRadius');

  const lootEl = npcEl.querySelector('#n-loot') as HTMLInputElement;
  lootEl.addEventListener('keydown', (ev) => ev.stopPropagation());
  lootEl.addEventListener('change', () => commit({ loot: lootEl.value.trim() || undefined }));

  const linesEl = npcEl.querySelector('#n-lines') as HTMLTextAreaElement;
  linesEl.addEventListener('keydown', (ev) => ev.stopPropagation());
  linesEl.addEventListener('change', () => {
    const lines = linesEl.value.split('\n').map((l) => l.trim()).filter(Boolean);
    delete e.dialog; // superseded by the multi-line script
    commit({ lines: lines.length ? lines : undefined });
    e.dialog = lines[0]; // keeps the "!" marker logic working
    reapply(state, item);
  });

  (npcEl.querySelector('#n-follow') as HTMLInputElement).addEventListener('change', (ev) =>
    commit({ canFollow: (ev.target as HTMLInputElement).checked })
  );
  npcEl.querySelector('#n-guide')!.addEventListener('click', () => {
    pickingGuide = !pickingGuide;
    updateNpcPanel();
    setStatus(
      pickingGuide
        ? `<b class="piece">Guide target</b><i class="sep"></i>` + cap(['click'], 'pick the destination')
        : describe(item)
    );
  });
  npcEl.querySelector('#n-guideclear')!.addEventListener('click', () => {
    commit({ guideTo: undefined });
    updateNpcPanel();
  });
  const arriveEl = npcEl.querySelector('#n-arrive') as HTMLInputElement;
  arriveEl.addEventListener('keydown', (ev) => ev.stopPropagation());
  arriveEl.addEventListener('change', () => commit({ arriveLine: arriveEl.value.trim() || undefined }));

  layoutRightPanels();
}

/* ---------------------------------------------------------------- mode --- */

export function toggleBuildMode() {
  buildMode = !buildMode;
  ui.classList.toggle('on', buildMode);
  setPathsVisible(buildMode);
  // Build mode freezes NPC life (unless previewing); play always runs it.
  setAnimationsPlaying(buildMode ? buildAnims : true);
  const hint = document.getElementById('hint');
  if (hint) hint.style.display = buildMode ? 'none' : '';
  const cam = getCameraEntity();
  if (cam !== undefined) {
    if (buildMode) {
      savedDistance = OrbitCamera.currentDistance[cam];
      savedPitch = OrbitCamera.currentPitch[cam];
      savedOffset.x = OrbitCamera.offsetX[cam];
      savedOffset.y = OrbitCamera.offsetY[cam];
      savedOffset.z = OrbitCamera.offsetZ[cam];
      OrbitCamera.targetDistance[cam] = 17;
      OrbitCamera.targetPitch[cam] = 1.05;
    } else {
      OrbitCamera.targetDistance[cam] = savedDistance;
      OrbitCamera.targetPitch[cam] = savedPitch;
      // Cursor-zoom walks the pivot around; hand play mode its camera back.
      OrbitCamera.offsetX[cam] = savedOffset.x;
      OrbitCamera.offsetY[cam] = savedOffset.y;
      OrbitCamera.offsetZ[cam] = savedOffset.z;
    }
  }
  if (!buildMode) {
    disarm();
    clearSelection();
    allBorders = false;
    // Belt and braces: outlines are authoring chrome and must never survive
    // into play, whatever state the builder was left in.
    hideAllBorders();
  }
}

/* ------------------------------------------------------------- palette --- */

async function armPalette(item: PaletteItem, row: HTMLElement) {
  paletteEl.querySelectorAll('.armed').forEach((el) => el.classList.remove('armed'));
  row.classList.add('armed');
  armed = item;
  paintColour = null;
  clearSelection();
  setStatus(
    `<b class="piece">${item.label}</b><i class="sep"></i>` +
      cap(['click'], 'drop on the ground') +
      cap(['Esc'], 'cancel')
  );
  await ensureGhost(item.src);
}

function armPaint(name: string) {
  paintColour = name;
  armed = null;
  killGhost();
  clearSelection();
  renderPalette('');
  setStatus(
    `<b class="piece">Paint: ${name}</b><i class="sep"></i>` +
      cap(['drag'], 'paint tiles') +
      cap(['Esc'], 'stop')
  );
}

function disarm() {
  armed = null;
  paintColour = null;
  paletteEl?.querySelectorAll('.armed').forEach((el) => el.classList.remove('armed'));
  killGhost();
}

async function ensureGhost(src: string) {
  if (ghostSrc === src && ghost) return;
  killGhost();
  const model = await loadModel(src);
  if (armed?.src !== src) return; // re-armed while loading
  ghost = model.clone(true);
  ghost.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = (m.material as THREE.Material).clone();
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.transparent = true;
    mat.opacity = 0.55;
    mat.depthWrite = false;
  });
  const box = new THREE.Box3().setFromObject(ghost);
  const size = box.getSize(new THREE.Vector3());
  ghost.scale.setScalar(1.5 / Math.max(size.y, 1e-3));
  ghostSrc = src;
  sceneRef()?.add(ghost);
}

function killGhost() {
  ghost?.parent?.remove(ghost);
  ghost = null;
  ghostSrc = null;
}

function sceneRef(): THREE.Scene | null {
  return ((window as unknown as Record<string, any>).__game?.scene as THREE.Scene) ?? null;
}

/* --------------------------------------------------------------- gizmo --- */

function buildGizmo() {
  gizmo = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xfd9b9b, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), mat);
  shaft.position.y = 0.45;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 12), mat);
  head.position.y = 1.07;
  shaft.renderOrder = 1000;
  head.renderOrder = 1000;
  gizmo.add(shaft, head);
  gizmo.visible = false;
}

function placeGizmo() {
  if (!gizmo) return;
  const scene = sceneRef();
  if (scene && gizmo.parent !== scene) scene.add(gizmo);
  if (selection.length === 0) {
    gizmo.visible = false;
    return;
  }
  // Above the selection's centre, so it never hides inside a model.
  let cx = 0;
  let cz = 0;
  let top = -Infinity;
  for (const it of selection) {
    const box = new THREE.Box3().setFromObject(it.obj);
    cx += (box.min.x + box.max.x) / 2;
    cz += (box.min.z + box.max.z) / 2;
    top = Math.max(top, box.max.y);
  }
  gizmo.position.set(cx / selection.length, top + 0.25, cz / selection.length);
  gizmo.visible = true;
}

/** World units per screen pixel at the handle's depth, for 1:1 dragging. */
function worldPerPixel() {
  const cam = cameraObject() as THREE.PerspectiveCamera | null;
  if (!cam || !gizmo) return 0.01;
  const dist = cam.position.distanceTo(gizmo.position);
  return (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / window.innerHeight;
}

/* ------------------------------------------------------------ pointing --- */

function updateNdc(ev: { clientX: number; clientY: number }): boolean {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) return false;
  const r = canvas.getBoundingClientRect();
  ndc.set(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -(((ev.clientY - r.top) / r.height) * 2 - 1)
  );
  return true;
}

function cameraObject(): THREE.Camera | null {
  const cam = getCameraEntity();
  return cam !== undefined ? threeCameras.get(cam) ?? null : null;
}

function groundHit(): THREE.Vector3 | null {
  const cam = cameraObject();
  if (!cam) return null;
  raycaster.setFromCamera(ndc, cam);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, out) ? out : null;
}

function hitGizmo(): boolean {
  const cam = cameraObject();
  if (!cam || !gizmo || !gizmo.visible) return false;
  raycaster.setFromCamera(ndc, cam);
  return raycaster.intersectObjects(gizmo.children, true).length > 0;
}

function pickPlaced(): PlacedItem | null {
  const cam = cameraObject();
  if (!cam) return null;
  raycaster.setFromCamera(ndc, cam);
  const editable = placed.filter((i) => !i.entry.follow);
  const hits = raycaster.intersectObjects(
    editable.map((i) => i.obj),
    true
  );
  if (hits.length === 0) return null;
  let node: THREE.Object3D | null = hits[0].object;
  while (node) {
    const item = editable.find((i) => i.obj === node);
    if (item) return item;
    node = node.parent;
  }
  return null;
}

function paintAt(p: THREE.Vector3) {
  if (!paintColour) return;
  // One history entry per stroke, not per tile.
  if (!paintedThisStroke) {
    mark('paint');
    paintedThisStroke = true;
  }
  // Snap to the tile grid, and replace rather than stack.
  const x = Math.round(p.x / PAINT_TILE) * PAINT_TILE;
  const z = Math.round(p.z / PAINT_TILE) * PAINT_TILE;
  const existing = placed.find((i) => i.entry.paint && i.entry.x === x && i.entry.z === z);
  if (existing) {
    if (existing.entry.paint === paintColour) return;
    removeItem(state, existing);
  }
  void instantiate(state, {
    src: 'paint',
    x,
    y: 0,
    z,
    rotY: 0,
    paint: paintColour,
  }).then(() => persist());
}

function onPointerMove(ev: PointerEvent) {
  if (!buildMode) return;

  if (gizmoDrag) {
    const dy = (gizmoDrag.pointerY - ev.clientY) * worldPerPixel();
    selection.forEach((it, i) => {
      it.entry.y = +(gizmoDrag!.startYs[i] + dy).toFixed(3);
      reapply(state, it);
      syncMarker(state, it);
    });
    placeGizmo();
    if (selection[0]) setStatus(describe(selection[0]));
    return;
  }

  // Shift-drag slides the board under you: move the orbit pivot across the
  // ground instead of swinging the camera around it. Screen right/up become
  // world directions from the camera's yaw, and the step scales with zoom so a
  // drag covers the same screen distance whether you're close in or far out.
  if (marquee) {
    marquee.x1 = ev.clientX;
    marquee.y1 = ev.clientY;
    drawMarquee();
    return;
  }

  if (panning) {
    const cam = getCameraEntity();
    if (cam !== undefined) {
      const dx = ev.clientX - orbitPrev.x;
      const dy = ev.clientY - orbitPrev.y;
      const yaw = OrbitCamera.currentYaw[cam];
      const scale = OrbitCamera.currentDistance[cam] * 0.0016;
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const fwdX = -Math.sin(yaw);
      const fwdZ = -Math.cos(yaw);
      OrbitCamera.offsetX[cam] -= (rightX * dx - fwdX * dy) * scale;
      OrbitCamera.offsetZ[cam] -= (rightZ * dx - fwdZ * dy) * scale;
    }
    orbitPrev.set(ev.clientX, ev.clientY);
    return;
  }

  if (orbiting) {
    const cam = getCameraEntity();
    if (cam !== undefined) {
      const dx = ev.clientX - orbitPrev.x;
      const dy = ev.clientY - orbitPrev.y;
      const yaw = OrbitCamera.currentYaw[cam] - dx * 0.006;
      const pitch = Math.min(1.45, Math.max(0.12, OrbitCamera.currentPitch[cam] + dy * 0.005));
      OrbitCamera.currentYaw[cam] = yaw;
      OrbitCamera.targetYaw[cam] = yaw;
      OrbitCamera.currentPitch[cam] = pitch;
      OrbitCamera.targetPitch[cam] = pitch;
    }
    orbitPrev.set(ev.clientX, ev.clientY);
    return;
  }

  if (!updateNdc(ev)) return;
  const hit = groundHit();
  if (ghost && hit) ghost.position.set(hit.x, 0, hit.z);
  if (painting && hit) paintAt(hit);

  // A click is not a drag until the pointer has clearly moved. Without this,
  // selecting an item snapped it to wherever the cursor happened to be.
  if (dragArmed && !dragging) {
    if (Math.hypot(ev.clientX - downPx.x, ev.clientY - downPx.y) > 5) {
      dragging = true;
      mark(dragOffsets.length > 1 ? `move ${dragOffsets.length} pieces` : 'move');
    } else return;
  }

  if (dragging && dragOffsets.length && hit) {
    for (const { it, ox, oz } of dragOffsets) {
      it.entry.x = +(hit.x + ox).toFixed(2);
      it.entry.z = +(hit.z + oz).toFixed(2);
      reapply(state, it);
      syncMarker(state, it);
    }
    placeGizmo();
    persist();
  }
}

function onPointerDown(ev: PointerEvent) {
  if (!buildMode || ev.button !== 0) return;
  const target = ev.target as HTMLElement;
  // Any builder chrome swallows the click — otherwise clicking the NPC panel
  // lands in the "empty space" branch and deselects, closing the panel.
  if (target.closest('#builder .bar, #builder .palette, #builder .npc, #builder .settings')) return;
  if (!updateNdc(ev)) return;

  if (pickingGuide && selection.length === 1) {
    const hit = groundHit();
    if (hit) {
      mark('guide target');
      const it = selection[0];
      it.entry.npc = {
        ...(it.entry.npc ?? {}),
        guideTo: [+hit.x.toFixed(2), +hit.z.toFixed(2)],
      };
      pickingGuide = false;
      resetNpc(it);
      persist();
      updateNpcPanel();
      setStatus(describe(it));
    }
    return;
  }

  if (drawingPath && selection.length === 1) {
    const hit = groundHit();
    if (hit) {
      mark('waypoint');
      const e = selection[0].entry;
      e.path = e.path ?? [];
      e.path.push([+hit.x.toFixed(2), +hit.z.toFixed(2)]);
      reapply(state, selection[0]);
      persist();
      updateNpcPanel();
    }
    return;
  }

  if (hitGizmo()) {
    mark('height');
    gizmoDrag = { pointerY: ev.clientY, startYs: selection.map((s) => s.entry.y) };
    return;
  }

  if (paintColour) {
    const hit = groundHit();
    if (hit) {
      painting = true;
      paintAt(hit);
    }
    return;
  }

  if (armed) {
    const hit = groundHit();
    if (!hit) return;
    const entry: LevelEntry = {
      src: armed.src,
      x: +hit.x.toFixed(2),
      y: 0,
      z: +hit.z.toFixed(2),
      rotY: 0,
      fitHeight: 1.5,
      solid: defaultSolidFor(armed.src),
      ...(armed.clip ? { clip: armed.clip } : {}),
    };
    mark('place');
    void instantiate(state, entry).then((item) => {
      if (item) {
        persist();
        select(item, false);
        setStatus(describe(item));
      }
    });
    // One click, one placement: keeping the piece armed meant every stray
    // click stamped another copy until you remembered Esc.
    disarm();
    return;
  }

  const hit = pickPlaced();
  if (hit) {
    if (ev.shiftKey) {
      // Shift-click only edits the selection; it never begins a drag.
      select(hit, true);
    } else {
      // Clicking a member of the current selection keeps the group together so
      // a drag moves everyone. Replacing on every click was why multi-drag
      // moved only the clicked item. If the click ends without a drag,
      // pointerup collapses the selection to just this item.
      if (selection.includes(hit)) pendingCollapse = hit;
      else select(hit, false);
      const g = groundHit();
      if (g) {
        dragArmed = true;
        downPx.set(ev.clientX, ev.clientY);
        dragOffsets = selection.map((it) => ({
          it,
          ox: it.entry.x - g.x,
          oz: it.entry.z - g.z,
        }));
      }
    }
    if (selection[0]) setStatus(describe(selection[0]));
  } else {
    // Empty space. Shift rubber-bands a selection, Command slides the view, a
    // plain drag orbits.
    if (ev.shiftKey) {
      marquee = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY };
      drawMarquee();
    } else if (ev.metaKey || ev.ctrlKey) {
      panning = true;
    } else {
      clearSelection();
      orbiting = true;
      setStatus(IDLE_STATUS);
    }
    orbitPrev.set(ev.clientX, ev.clientY);
  }
}

function onWheel(ev: WheelEvent) {
  if (!buildMode) return;
  // Scrolling the asset list must scroll the list, not dolly the camera.
  if ((ev.target as HTMLElement)?.closest?.('#builder .palette, #builder .npc, #builder .settings')) return;
  const cam = getCameraEntity();
  if (cam === undefined) return;
  ev.preventDefault();

  const d0 = OrbitCamera.currentDistance[cam];
  const d1 = Math.min(60, Math.max(3, d0 + ev.deltaY * 0.02));

  // Zoom anchor: the selection when there is one (you're working on it, so
  // the camera should close in on it), otherwise the ground point under the
  // cursor — the map-app dolly. Either way the anchor stays fixed on screen
  // by sliding the orbit pivot (player + offset) toward it as distance
  // shrinks and away as it grows.
  let anchorX: number | null = null;
  let anchorZ: number | null = null;
  if (selection.length > 0) {
    anchorX = 0;
    anchorZ = 0;
    for (const it of selection) {
      anchorX += it.border.position.x;
      anchorZ += it.border.position.z;
    }
    anchorX /= selection.length;
    anchorZ /= selection.length;
  } else {
    updateNdc(ev);
    const hit = groundHit();
    if (hit) {
      anchorX = hit.x;
      anchorZ = hit.z;
    }
  }
  const target = OrbitCamera.target[cam];
  if (anchorX !== null && anchorZ !== null && target && d0 > 0.01) {
    const k = d1 / d0;
    const pivotX = Transform.posX[target] + OrbitCamera.offsetX[cam];
    const pivotZ = Transform.posZ[target] + OrbitCamera.offsetZ[cam];
    OrbitCamera.offsetX[cam] = anchorX + (pivotX - anchorX) * k - Transform.posX[target];
    OrbitCamera.offsetZ[cam] = anchorZ + (pivotZ - anchorZ) * k - Transform.posZ[target];
  }
  OrbitCamera.currentDistance[cam] = d1;
  OrbitCamera.targetDistance[cam] = d1;
}

/* ----------------------------------------------------------- selection --- */

/**
 * Whether a freshly placed piece should collide.
 *
 * Ground cover is the common case for "no border": grass, flowers, ferns and
 * pebbles are scattered by the dozen and colliding with any of them makes the
 * ground feel like a minefield. Everything else defaults to solid, and T flips
 * it for anything (including a whole selection at once).
 */
const NON_SOLID_PATTERNS = [
  'grass', 'flower', 'clover', 'fern', 'mushroom', 'petal', 'pebble',
  'plant', 'wheat', 'paper', 'coin', 'gem', 'lure',
];
function defaultSolidFor(src: string) {
  const name = src.split('/').pop()!.toLowerCase();
  return !NON_SOLID_PATTERNS.some((p) => name.includes(p));
}

function nameOf(src: string) {
  return src === 'paint' ? 'Ground paint' : src.split('/').pop()!.replace('.glb', '');
}

/**
 * Show or hide a piece's outline, collider boxes included.
 *
 * The per-collider wireframes used to be set once when created and never
 * again, so they outlived the selection that spawned them and hung around in
 * play mode. Visibility now flows through here, and nothing else touches
 * `.visible` on a border.
 */
function setBorderVisible(item: PlacedItem, visible: boolean, selected = false) {
  const colour = selected ? 0xffd747 : item.entry.solid ? 0x33ff88 : 0x8899aa;
  item.border.visible = visible;
  (item.border.material as THREE.LineBasicMaterial).color.set(colour);
  for (const w of item.partBorders) {
    w.visible = visible;
    (w.material as THREE.LineBasicMaterial).color.set(colour);
  }
}

/** Hide every outline in the level — used when leaving build mode. */
function hideAllBorders() {
  for (const i of placed) setBorderVisible(i, false);
}

function select(item: PlacedItem | null, additive: boolean) {
  if (!additive) {
    for (const s of selection) if (!allBorders) setBorderVisible(s, false);
    selection = [];
  }
  if (item) {
    if (selection.includes(item)) {
      selection = selection.filter((s) => s !== item); // shift-click toggles off
      setBorderVisible(item, allBorders);
    } else {
      selection.push(item);
      refreshBorder(item);
      setBorderVisible(item, true, true);
    }
  }
  placeGizmo();
  updateNpcPanel();
}

function clearSelection() {
  select(null, false);
}

function toggleBorders() {
  allBorders = !allBorders;
  for (const i of placed) {
    const on = allBorders || selection.includes(i);
    if (on) refreshBorder(i);
    setBorderVisible(i, on, selection.includes(i));
  }
}

/* ---------------------------------------------------------------- keys --- */

const cap = (keys: string[], label: string) =>
  `<span>${keys.map((k) => `<kbd>${k}</kbd>`).join('')}${label}</span>`;

function describe(item: PlacedItem) {
  const e = item.entry;
  const many = selection.length > 1 ? ` ×${selection.length}` : '';
  return (
    `<b class="piece">${nameOf(e.src)}${many}</b>` +
    `<i class="sep"></i>` +
    cap(['drag'], 'move') +
    cap(['Q', 'E'], `height ${e.y.toFixed(2)}`) +
    cap(['R'], 'rotate') +
    cap(['+', '−'], `size ${(e.scale ?? 1).toFixed(2)}`) +
    cap(['[', ']'], `top ${(e.trimTop ?? 0).toFixed(2)}`) +
    `<i class="sep"></i>` +
    cap(['X'], 'flip') +
    cap(['T'], `solid ${e.solid ? 'on' : 'off'}`) +
    cap(['P'], `pickable ${e.pickable ? 'on' : 'off'}`) +
    cap(['Del'], 'remove')
  );
}

const IDLE_STATUS =
  cap(['click'], 'place · select') +
  cap(['shift'], 'multi-select') +
  cap(['⌘C', '⌘V'], 'copy · paste') +
  cap(['⌘Z'], 'undo') +
  cap(['drag'], 'orbit') +
  cap(['⇧drag'], 'box-select') +
  cap(['⌘drag'], 'pan') +
  `<i class="sep"></i>` +
  cap(['B'], 'borders') +
  cap(['Tab'], 'play');

function onKeyDown(ev: KeyboardEvent) {
  if (ev.code === 'Tab') {
    ev.preventDefault();
    toggleBuildMode();
    return;
  }
  if (!buildMode) return;

  if (ev.code === 'Escape') {
    disarm();
    drawingPath = false;
    pickingGuide = false;
    clearSelection();
    setStatus(IDLE_STATUS);
    return;
  }
  if (ev.code === 'Enter' && drawingPath) {
    drawingPath = false;
    updateNpcPanel();
    if (selection[0]) setStatus(describe(selection[0]));
    return;
  }
  if (ev.code === 'KeyB') return toggleBorders();
  if (ev.code === 'KeyS' && !ev.metaKey) return saveFile();

  const cmd = ev.metaKey || ev.ctrlKey;
  if (cmd && ev.code === 'KeyZ') {
    ev.preventDefault();
    void (ev.shiftKey ? doRedo() : doUndo());
    return;
  }
  if (cmd && ev.code === 'KeyC' && selection.length) {
    clipboard = selection.map((s) => ({ ...s.entry }));
    for (const e of clipboard) delete e.follow; // the raft stays unique
    pasteBump = 0;
    ev.preventDefault();
    setStatus(`<b class="piece">Copied ${clipboard.length}</b><i class="sep"></i>` + cap(['⌘V'], 'paste'));
    return;
  }
  if (cmd && ev.code === 'KeyV' && clipboard.length) {
    ev.preventDefault();
    void pasteClipboard();
    return;
  }
  if (cmd && ev.code === 'KeyD' && selection.length) {
    ev.preventDefault();
    clipboard = selection.map((s) => ({ ...s.entry }));
    for (const e of clipboard) delete e.follow;
    pasteBump = 0;
    void pasteClipboard();
    return;
  }

  if (selection.length === 0) return;

  const step = ev.shiftKey ? 0.5 : 0.1;
  const apply = (fn: (e: LevelEntry) => void) => {
    for (const it of selection) {
      fn(it.entry);
      reapply(state, it);
      syncMarker(state, it);
    }
  };

  if (ev.code === 'KeyR')
    apply((e) => (e.rotY = +(e.rotY + (ev.shiftKey ? -1 : 1) * (Math.PI / 8)).toFixed(4)));
  else if (ev.code === 'Equal' || ev.code === 'NumpadAdd')
    apply((e) => (e.scale = +((e.scale ?? 1) * 1.12).toFixed(4)));
  else if (ev.code === 'Minus' || ev.code === 'NumpadSubtract')
    apply((e) => (e.scale = +((e.scale ?? 1) / 1.12).toFixed(4)));
  else if (ev.code === 'KeyE' || ev.code === 'ArrowUp') apply((e) => (e.y = +(e.y + step).toFixed(3)));
  else if (ev.code === 'KeyQ' || ev.code === 'ArrowDown') apply((e) => (e.y = +(e.y - step).toFixed(3)));
  else if (ev.code === 'KeyG') apply((e) => (e.y = 0));
  else if (ev.code === 'BracketLeft')
    apply((e) => (e.trimTop = +Math.max(0, (e.trimTop ?? 0) - 0.1).toFixed(2)));
  else if (ev.code === 'BracketRight')
    apply((e) => (e.trimTop = +((e.trimTop ?? 0) + 0.1).toFixed(2)));
  else if (ev.code === 'KeyX') apply((e) => (e.flip = !e.flip));
  else if (ev.code === 'KeyT') {
    // Make a mixed selection agree rather than inverting each piece: if any of
    // them still collide, the whole group turns solid off; press again to turn
    // them all on. Flipping individually leaves you toggling forever trying to
    // get a hillside of grass to match.
    const anySolid = selection.some((it) => it.entry.solid);
    apply((e) => (e.solid = !anySolid));
  }
  else if (ev.code === 'KeyP') apply((e) => (e.pickable = !e.pickable));
  else if (ev.code === 'Backspace' || ev.code === 'Delete') {
    for (const it of [...selection]) removeItem(state, it);
    selection = [];
    placeGizmo();
    persist();
    setStatus(IDLE_STATUS);
    return;
  } else return;

  ev.preventDefault();
  placeGizmo();
  persist();
  setStatus(describe(selection[0]));
}

/** Paste offsets a little more each time, so repeated pastes fan out. */
async function pasteClipboard() {
  mark(`paste ${clipboard.length}`);
  pasteBump += 0.8;
  const copies = clipboard.map((e) => ({ ...e, x: +(e.x + pasteBump).toFixed(2), z: +(e.z + pasteBump).toFixed(2) }));
  const made = (await Promise.all(copies.map((c) => instantiate(state, c)))).filter(
    (i): i is PlacedItem => i !== null
  );
  select(null, false);
  for (const it of made) select(it, true);
  persist();
  if (made[0]) setStatus(describe(made[0]));
}

/* ---------------------------------------------------------------- save --- */

function saveFile() {
  const blob = new Blob([serialize()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'level.json';
  a.click();
  URL.revokeObjectURL(a.href);
  persist();
  setStatus(
    `<b class="piece">Saved level.json</b><i class="sep"></i>` +
      cap(['Load…'], 'to bring one back')
  );
}
