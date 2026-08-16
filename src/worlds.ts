import * as THREE from 'three';
import type { State } from 'vibegame';
import {
  LevelEntry,
  instantiate,
  persist,
  placed,
  removeItem,
  serialize,
  spawnPoint,
} from './level';
import { STARTERS } from './starters';
import { clearHistory } from './history';

/**
 * Worlds: the island-hopping layer.
 *
 * A world is just a level with a name. The current one keeps autosaving to the
 * usual slot; every other one sleeps in a registry keyed by id. Travelling
 * saves where you are, wakes the destination, and rebuilds the scene in place
 * — no reload, because a reload would drop the play session (held items,
 * camera, health) on the floor.
 *
 * A destination id resolves in two steps: a world you've visited (and possibly
 * edited) wins; otherwise the starter of that id is built fresh. So "sail to
 * the fishing village" returns you to YOUR fishing village, edits intact.
 */

const WORLDS_KEY = 'sandbox-worlds-v1';
const CURRENT_KEY = 'sandbox-world-current';
export const HOME_WORLD = 'home';

function savedWorlds(): Record<string, LevelEntry[]> {
  try {
    return JSON.parse(localStorage.getItem(WORLDS_KEY) ?? '{}') as Record<string, LevelEntry[]>;
  } catch {
    return {};
  }
}

export function currentWorldId(): string {
  return localStorage.getItem(CURRENT_KEY) ?? HOME_WORLD;
}

/**
 * Loading a starter from the picker BECOMES that world — otherwise the level
 * banks under the old id when you travel, and sailing back later hands you a
 * fresh copy instead of the one you edited.
 */
export function setCurrentWorldId(id: string) {
  localStorage.setItem(CURRENT_KEY, id);
}

/** Pretty name for a world id — the starter's name if it is one. */
export function worldName(id: string): string {
  return STARTERS.find((s) => s.id === id)?.name ?? id;
}

/** Everywhere a portal can point: every starter, plus any world you've made. */
export function destinations(): { id: string; name: string }[] {
  const out = new Map<string, string>();
  out.set(HOME_WORLD, 'Home island');
  for (const s of STARTERS) out.set(s.id, s.name);
  for (const id of Object.keys(savedWorlds())) if (!out.has(id)) out.set(id, id);
  return [...out.entries()].map(([id, name]) => ({ id, name }));
}

let traveling = false;

/**
 * Go somewhere. Returns the new world's spawn point (teleporting the player
 * is the caller's job — physics writes live in main.ts), or null if the id
 * resolves to nothing.
 */
export async function travelTo(state: State, id: string): Promise<THREE.Vector3 | null> {
  if (traveling || id === currentWorldId()) return null;

  const worlds = savedWorlds();
  const target =
    worlds[id] ?? STARTERS.find((s) => s.id === id)?.build() ?? null;
  if (!target) return null;

  traveling = true;
  try {
    // Bank the world we're leaving before touching anything.
    worlds[currentWorldId()] = JSON.parse(serialize()) as LevelEntry[];
    localStorage.setItem(WORLDS_KEY, JSON.stringify(worlds));
    localStorage.setItem(CURRENT_KEY, id);

    // Undo history is per-world; an undo recorded on one island must never
    // write that island's entries into another island's save.
    clearHistory();

    for (const item of [...placed]) {
      if (!item.entry.follow) removeItem(state, item);
    }
    for (const e of target) {
      await instantiate(state, JSON.parse(JSON.stringify(e)) as LevelEntry);
    }
    persist();
    return spawnPoint();
  } finally {
    traveling = false;
  }
}
