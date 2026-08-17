import type { State } from 'vibegame';
import { PlacedItem, placed } from './level';
import { lootCounts } from './loot';
import { npcRuntime } from './npc';

/**
 * Objectives: the layer that turns a place into a game.
 *
 * Everything before this was ambient — NPCs wandered, combat resolved, loot
 * dropped — but nothing tracked what you were trying to DO or whether you had
 * done it. An objective is a tracked condition with a step number; the island
 * shows the lowest incomplete step and advances when it's satisfied.
 *
 * Objectives live ON the thing they concern, the same way NPC behaviour does:
 * the dragon carries "defeat the dragon", the bell carries "ring the bell".
 * A separate quest script would drift from the level the moment anyone edited
 * it, which is the same reason the quest board reads its jobs off the NPCs.
 */

export type Objective = {
  /** Order in the chain. Steps complete in ascending order. */
  step: number;
  kind: 'defeat' | 'collect' | 'reach' | 'activate' | 'talk';
  /** Shown in the HUD while this step is current. */
  text: string;
  /** collect: loot kind and how many. */
  item?: string;
  count?: number;
  /** reach: how close counts as arriving. */
  radius?: number;
  /** Line shown when the step completes. */
  done?: string;
};

/** Things the player has activated (E) or talked to, by entry identity. */
const triggered = new WeakSet<PlacedItem>();
export function markTriggered(item: PlacedItem) {
  triggered.add(item);
}
export function isTriggered(item: PlacedItem) {
  return triggered.has(item);
}

/** Highest step the player has finished. */
let cleared = -1;
/** What the player already had when a collect step became current. */
const baselines = new WeakMap<PlacedItem, number>();

export function resetObjectives() {
  cleared = -1;
  banner = null;
  bannerT = 0;
}

function baselineFor(item: PlacedItem): number {
  const b = baselines.get(item);
  return b ?? 0;
}

/** Snapshot the inventory as a collect step opens. */
function armBaselines(forStep: PlacedItem[]) {
  for (const item of forStep) {
    const o = item.entry.objective;
    if (o?.kind !== 'collect' || baselines.has(item)) continue;
    baselines.set(item, lootCounts()[o.item ?? ''] ?? 0);
  }
}

function stepsInLevel(): number[] {
  const s = new Set<number>();
  for (const item of placed) if (item.entry.objective) s.add(item.entry.objective.step);
  return [...s].sort((a, b) => a - b);
}

function satisfied(item: PlacedItem, px: number, pz: number): boolean {
  const o = item.entry.objective!;
  switch (o.kind) {
    case 'defeat':
      return npcRuntime(item).state === 'dead';
    case 'collect':
      // Counted from when the step STARTED, not from zero. You arrive on an
      // island carrying whatever you left the last one with, and "fetch the
      // strongbox" must not be satisfied by a strongbox you already own.
      return (lootCounts()[o.item ?? ''] ?? 0) - baselineFor(item) >= (o.count ?? 1);
    case 'reach': {
      const d = Math.hypot(item.obj.position.x - px, item.obj.position.z - pz);
      return d <= (o.radius ?? 3);
    }
    case 'activate':
    case 'talk':
      return triggered.has(item);
  }
}

/* ------------------------------------------------------------------ ui --- */

let hud: HTMLDivElement | null = null;
let banner: string | null = null;
let bannerT = 0;

function ensureUi() {
  if (hud) return;
  const style = document.createElement('style');
  style.textContent = `
    #objective { position:fixed; left:50%; top:16px; transform:translateX(-50%);
      z-index:15; pointer-events:none; text-align:center;
      font-family: var(--font-body, Inter, sans-serif); display:none; }
    #objective .eyebrow { font-family: var(--font-display, sans-serif); font-weight:700;
      font-size:10px; letter-spacing:.16em; text-transform:uppercase;
      color: var(--text-secondary,#666); margin-bottom:3px; }
    #objective .task { display:inline-block; font-weight:700; font-size:15px;
      color: var(--text-primary,#111); background: var(--surface-face,#faf6ef);
      border:2px solid var(--border-strong,#111); border-radius:12px;
      box-shadow:0 4px 0 var(--border-strong,#111); padding:6px 16px; }
    #objective .task.done { background:#bfe6a8; }
  `;
  document.head.appendChild(style);
  hud = document.createElement('div');
  hud.id = 'objective';
  document.body.appendChild(hud);
}

/** Drive one frame. Returns the current step, or null when the island is done. */
export function updateObjectives(
  _state: State,
  dt: number,
  px: number,
  pz: number,
  active: boolean
) {
  ensureUi();
  if (!hud) return null;
  if (!active) {
    hud.style.display = 'none';
    return null;
  }

  const steps = stepsInLevel();
  if (!steps.length) {
    hud.style.display = 'none';
    return null;
  }

  if (bannerT > 0) {
    bannerT -= dt;
    hud.style.display = '';
    hud.innerHTML = `<div class="eyebrow">Complete</div><div class="task done">${banner}</div>`;
    return null;
  }

  const current = steps.find((s) => s > cleared);
  if (current === undefined) {
    hud.style.display = '';
    hud.innerHTML = `<div class="eyebrow">Island</div><div class="task done">All done — sail home</div>`;
    return null;
  }

  const forStep = placed.filter((i) => i.entry.objective?.step === current);
  armBaselines(forStep);
  const all = forStep.every((i) => satisfied(i, px, pz));
  if (all && forStep.length) {
    cleared = current;
    const o = forStep[0].entry.objective!;
    banner = o.done ?? o.text;
    bannerT = 2.2;
    return current;
  }

  // Progress on a counted objective is worth showing; "collect 3 gems" with no
  // number is a guess about how you're doing.
  const o = forStep[0].entry.objective!;
  let text = o.text;
  if (o.kind === 'collect' && (o.count ?? 1) > 1) {
    const got = (lootCounts()[o.item ?? ''] ?? 0) - baselineFor(forStep[0]);
    text += ` (${Math.max(0, Math.min(got, o.count!))}/${o.count})`;
  } else if (o.kind === 'defeat' && forStep.length > 1) {
    const left = forStep.filter((i) => !satisfied(i, px, pz)).length;
    text += ` (${forStep.length - left}/${forStep.length})`;
  }
  hud.style.display = '';
  hud.innerHTML = `<div class="eyebrow">Objective</div><div class="task">${text}</div>`;
  return current;
}
