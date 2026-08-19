import type { State } from 'vibegame';
import { PlacedItem, placed, removeItem } from './level';
import { thumbFor } from './thumbs';

/**
 * Loot: treasure collects itself.
 *
 * Coins and gems are score, not cargo — making the player stop, aim E at a
 * coin, carry it somewhere and drop it is homework. Run over it and it's
 * yours; a tray under the health bar slides down to show the running count.
 *
 * The inventory belongs to the PLAYER, not the level, so it lives in its own
 * storage slot and survives travel and reloads. Collected pieces are removed
 * from the scene without persisting, which has a pleasant side effect: they're
 * gone from the world you're in, but a rebuilt starter grows them back.
 */

/**
 * What auto-collects — the single source of truth. The builder's quest
 * dropdowns derive from this list, so an NPC can never want something the
 * inventory can't hold (a Skull quest was undeliverable for exactly that
 * mismatch: the dropdown offered it, the scoop ignored it).
 */
export const COLLECTIBLE_NAMES = [
  'Coins', 'Gold Bag', 'Gold ore', 'Gem Blue', 'Gem Green', 'Gem Pink',
  'Chest Gold', 'Skull', 'Prop Bottle',
] as const;
const LOOT_NAMES = new Set<string>(COLLECTIBLE_NAMES);

const KEY = 'sandbox-inventory-v1';

function lootName(src: string): string | null {
  const base = src.split('/').pop()?.replace(/\.glb$/i, '') ?? '';
  return LOOT_NAMES.has(base) ? base : null;
}

/** Loot is scooped, never carried — keeps E for barrels and conversation. */
export function isLoot(src: string): boolean {
  return lootName(src) !== null;
}

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
const counts: Record<string, number> = load();

/** How close "running over" is. Forgiving on height: coins land at your feet. */
const SCOOP_RADIUS = 1.05;
const SCOOP_HEIGHT = 1.4;

/** Call once per frame with the player's feet. Scoops anything close enough. */
export function updateLootPickup(state: State, px: number, py: number, pz: number) {
  for (const item of [...placed]) {
    if (item.carried) continue;
    // Mid-arc drops are still popping out of the corpse; let them land first
    // or the kill scoops its own reward before you ever see it.
    if (item.flight) continue;
    const name = lootName(item.entry.src);
    if (!name) continue;
    const d = Math.hypot(item.entry.x - px, item.entry.z - pz);
    if (d > SCOOP_RADIUS) continue;
    if (Math.abs(item.obj.position.y - py) > SCOOP_HEIGHT) continue;
    counts[name] = (counts[name] ?? 0) + 1;
    localStorage.setItem(KEY, JSON.stringify(counts));
    removeItem(state, item);
    renderTray(name);
  }
}

// ---------------------------------------------------------------------------
// The tray: slides down from under the health bar when something is scooped.

let tray: HTMLDivElement | null = null;

function ensureTray() {
  if (tray) return;
  const style = document.createElement('style');
  style.textContent = `
    #loot-tray { position:fixed; left:16px; top:64px; z-index:13; pointer-events:none;
      display:flex; flex-direction:column; gap:4px;
      font-family: var(--font-body, Inter, sans-serif); }
    #loot-tray .slot { display:flex; align-items:center; gap:6px;
      background: var(--surface-face,#faf6ef); border:2px solid var(--border-strong,#111);
      border-radius:10px; box-shadow: 0 3px 0 var(--border-strong,#111);
      padding:2px 10px 2px 2px; width:max-content;
      transform:translateX(0); transition: transform 180ms cubic-bezier(.2,1.4,.4,1); }
    #loot-tray .slot.pop { transform:translateX(6px) scale(1.06); }
    #loot-tray img { width:30px; height:30px; display:block; }
    #loot-tray .n { font-weight:700; font-size:14px; color: var(--text-primary,#111); }
  `;
  document.head.appendChild(style);
  tray = document.createElement('div');
  tray.id = 'loot-tray';
  document.body.appendChild(tray);
  renderTray();
}

/** Rebuild the rows; `popped` briefly bumps the row that just changed. */
/**
 * Packs a tray icon might live in, most likely first.
 *
 * The path used to be hardcoded to the pirate kit, which was fine while
 * everything in the inventory came from there. A caught fish does not — it is
 * granted straight to the counts, never touching the floor — so the icon has
 * to be looked for more widely. thumbFor returns null for a model that isn't
 * there, so trying in order costs a miss and nothing else.
 */
const TRAY_PACKS = [
  '/models/quaternius-pirate/',
  '/models/animated-fish-bundle/',
  '/models/kenney-survival/',
];

async function trayThumb(name: string): Promise<string | null> {
  for (const pack of TRAY_PACKS) {
    const url = await thumbFor(`${pack}${name}.glb`);
    if (url) return url;
  }
  return null;
}

function renderTray(popped?: string) {
  if (!tray) return;
  for (const name of Object.keys(counts)) {
    if (!counts[name]) continue;
    let slot = tray.querySelector<HTMLDivElement>(`[data-loot="${name}"]`);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.loot = name;
      const img = document.createElement('img');
      img.alt = name;
      void trayThumb(name).then((url) => {
        if (url) img.src = url;
      });
      const n = document.createElement('span');
      n.className = 'n';
      slot.append(img, n);
      tray.appendChild(slot);
    }
    slot.querySelector('.n')!.textContent = `×${counts[name]}`;
    if (name === popped) {
      slot.classList.remove('pop');
      void slot.offsetWidth; // restart the transition
      slot.classList.add('pop');
      setTimeout(() => slot?.classList.remove('pop'), 220);
    }
  }
}

/** What's in your hand, shown under the loot tray. */
let handEl: HTMLDivElement | null = null;
export function showHeld(label: string | null) {
  if (!handEl) {
    handEl = document.createElement('div');
    // Beside the health bar, not under it. This used to sit at a fixed 150px
    // from the top, which is inside the loot tray once you are carrying more
    // than a few things — the label ended up wedged between two loot slots
    // halfway down the screen, reading as a broken row rather than as what is
    // in your hand. The bar is a fixed 190px from left:16, so 222 clears it,
    // and the top lines the chip up with the bar rather than its caption.
    handEl.style.cssText =
      // translateY rather than a top that assumes a height: the chip grows
      // with the label's font, and 45 is the bar's centre line either way.
      'position:fixed;left:222px;top:45px;transform:translateY(-50%);' +
      'z-index:13;pointer-events:none;' +
      'font-family:var(--font-body,Inter,sans-serif);font-weight:700;font-size:13px;' +
      'color:var(--text-primary,#111);background:var(--surface-face,#faf6ef);' +
      'border:2px solid var(--border-strong,#111);border-radius:10px;' +
      'box-shadow:0 3px 0 var(--border-strong,#111);padding:3px 10px;display:none;';
    document.body.appendChild(handEl);
  }
  handEl.style.display = label ? '' : 'none';
  if (label) handEl.textContent = label;
}

/** Hide alongside the rest of the play HUD in build mode. */
export function setLootTrayVisible(v: boolean) {
  ensureTray();
  if (tray) tray.style.display = v ? '' : 'none';
  if (!v) showHeld(null);
}

/** Take n of a kind out of the inventory (fetch quests). False if short. */
export function spendLoot(name: string, n = 1): boolean {
  if ((counts[name] ?? 0) < n) return false;
  counts[name] -= n;
  localStorage.setItem(KEY, JSON.stringify(counts));
  ensureTray();
  const slot = tray?.querySelector<HTMLDivElement>(`[data-loot="${name}"]`);
  if (slot && !counts[name]) slot.remove();
  else renderTray(name);
  return true;
}

/** Put loot straight into the inventory — quest rewards skip the floor. */
export function grantLoot(name: string, n = 1) {
  counts[name] = (counts[name] ?? 0) + n;
  localStorage.setItem(KEY, JSON.stringify(counts));
  ensureTray();
  renderTray(name);
}

/** For tests and the AI panel: current counts, read-only. */
export function lootCounts(): Readonly<Record<string, number>> {
  return counts;
}

export type { PlacedItem };
