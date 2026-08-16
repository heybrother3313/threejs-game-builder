import type { State } from 'vibegame';
import { LevelEntry, persist, placed, removeItem, instantiate } from './level';

/**
 * Undo/redo for the builder.
 *
 * Snapshots, not inverse operations. The level is already a serialisable array
 * of plain entries, so the cheapest correct history is "remember the whole
 * array before each change and restore it wholesale". Inverse ops would be
 * faster but need a hand-written undo for every verb (move, scale, flip,
 * solid, trim, dialogue, path, NPC config…) and one missing case corrupts the
 * level quietly. Levels are tens of entries, so copying is free.
 *
 * This matters most for the AI assistant: one prompt can add, move and delete
 * a dozen things at once, and "that wasn't what I meant" needs to be one
 * keystroke rather than an archaeology session.
 */

type Snapshot = { label: string; entries: LevelEntry[] };

const past: Snapshot[] = [];
const future: Snapshot[] = [];
const LIMIT = 60;

let state: State | null = null;
let restoring = false;
let onChange: (() => void) | null = null;

export function initHistory(gameState: State, changed?: () => void) {
  state = gameState;
  onChange = changed ?? null;
  past.length = 0;
  future.length = 0;
}

/** Deep copy: entries hold nested arrays (path) and objects (npc). */
function snapshotEntries(): LevelEntry[] {
  return placed
    .filter((i) => !i.entry.follow)
    .map((i) => JSON.parse(JSON.stringify(i.entry)) as LevelEntry);
}

/**
 * Record the state BEFORE a change. Call it at the top of any mutation —
 * cheap enough that over-calling is harmless, and a missed call is the only
 * way to lose a step.
 */
export function mark(label: string) {
  if (restoring) return;
  past.push({ label, entries: snapshotEntries() });
  if (past.length > LIMIT) past.shift();
  future.length = 0; // a new branch discards the redo stack
  onChange?.();
}

export function canUndo() {
  return past.length > 0;
}
export function canRedo() {
  return future.length > 0;
}
export function undoLabel() {
  return past[past.length - 1]?.label ?? null;
}
export function redoLabel() {
  return future[future.length - 1]?.label ?? null;
}

async function restore(entries: LevelEntry[]) {
  if (!state) return;
  restoring = true;
  // Rebuild wholesale: tear down everything the builder owns, then re-create.
  // The raft rider is excluded from snapshots, so leave it standing.
  for (const item of [...placed]) {
    if (!item.entry.follow) removeItem(state, item);
  }
  for (const e of entries) {
    await instantiate(state, JSON.parse(JSON.stringify(e)) as LevelEntry);
  }
  persist();
  restoring = false;
  onChange?.();
}

export async function undo() {
  if (!state || past.length === 0) return null;
  const step = past.pop()!;
  future.push({ label: step.label, entries: snapshotEntries() });
  await restore(step.entries);
  return step.label;
}

export async function redo() {
  if (!state || future.length === 0) return null;
  const step = future.pop()!;
  past.push({ label: step.label, entries: snapshotEntries() });
  await restore(step.entries);
  return step.label;
}
