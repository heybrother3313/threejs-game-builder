import type { State } from 'vibegame';
import {
  LevelEntry,
  instantiate,
  persist,
  placed,
  reapply,
  removeItem,
  serialize,
  syncMarker,
} from './level';

/**
 * The builder's AI assistant, running on a LOCAL model first.
 *
 * The entire level is one JSON dialect and the builder already has verbs
 * (place, move, path, dialog, animate), so "AI in the builder" reduces to:
 * natural language in, a JSON patch out, applied through the same code paths
 * as clicks. Requests go to Ollama via the dev-server proxy (/ollama), so
 * there's no CORS and no key. Config persists in the browser.
 */

export type AiConfig = { url: string; model: string };
const CONFIG_KEY = 'sandbox-ai-v1';

export function aiConfig(): AiConfig {
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) return JSON.parse(saved) as AiConfig;
  } catch {
    /* fall through to default */
  }
  return { url: '/ollama', model: 'qwen3-coder:30b' };
}

export function saveAiConfig(cfg: AiConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export async function listModels(cfg: AiConfig): Promise<string[]> {
  const res = await fetch(`${cfg.url}/api/tags`);
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

/** What the model is allowed to hand back. */
type Patch = {
  add?: LevelEntry[];
  update?: { index: number; set: Partial<LevelEntry> }[];
  remove?: number[];
};

const MODEL_DIRS = [
  'quaternius-pirate',
  'animated-animal-pack',
  'animated-enemies',
  'animated-fish-bundle',
  'stylized-nature-megakit',
];

function systemPrompt(assetNames: Record<string, string[]>): string {
  return [
    'You edit a 3D game level. The level is a JSON array of entries. Entry fields:',
    'src (string, "/models/<dir>/<Name>.glb"), x, y, z (numbers, world position; ground is y=0),',
    'rotY (radians), scale OR fitHeight (target height in metres — prefer fitHeight ~1-4 for props, 8+ for buildings),',
    'solid (boolean: player collides), pickable (boolean: player can carry/throw it),',
    'clip (animation name, e.g. "Idle", "Walk", "Attack"; fish use "Swimming_Normal"),',
    'path ([[x,z],...] patrol loop), speed (units/s), dialog (string shown with a "!" marker),',
    'paint (ground tile: sand|grass|water|road|rock|jungle — paint entries use src:"paint" and 2-unit grid x/z).',
    '',
    'The playable beach spans roughly x -13..13, z -9..9; water lies beyond ±9 in z.',
    '',
    'Available model directories and names:',
    ...Object.entries(assetNames).map(
      ([dir, names]) => `/models/${dir}/: ${names.join(', ')}`
    ),
    '',
    'Reply with ONLY a JSON object, no prose: {"add": [entries], "update": [{"index": i, "set": {fields}}], "remove": [indices]}.',
    'Indices refer to the CURRENT LEVEL array below. Omit keys you do not need.',
  ].join('\n');
}

async function assetIndex(): Promise<Record<string, string[]>> {
  // Nature kit has a manifest; the rest we know statically from the palette.
  const out: Record<string, string[]> = {};
  for (const dir of MODEL_DIRS) {
    try {
      const res = await fetch(`/models/${dir}/manifest.json`);
      if (res.ok) {
        out[dir] = (await res.json()) as string[];
        continue;
      }
    } catch {
      /* fall through */
    }
    out[dir] = [];
  }
  return out;
}

export type AiResult = {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  removed: number;
  raw?: string;
};

export async function runAssistant(
  state: State,
  cfg: AiConfig,
  request: string
): Promise<AiResult> {
  const assets = await assetIndex();
  const body = {
    model: cfg.model,
    stream: false,
    format: 'json',
    options: { temperature: 0.2 },
    messages: [
      { role: 'system', content: systemPrompt(assets) },
      {
        role: 'user',
        content: `CURRENT LEVEL:\n${serialize()}\n\nREQUEST: ${request}`,
      },
    ],
  };

  const res = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, message: `Ollama answered ${res.status}`, added: 0, updated: 0, removed: 0 };
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';

  let patch: Patch;
  try {
    patch = JSON.parse(raw) as Patch;
  } catch {
    return { ok: false, message: 'Model reply was not valid JSON', added: 0, updated: 0, removed: 0, raw };
  }
  return applyPatch(state, patch, raw);
}

async function applyPatch(state: State, patch: Patch, raw: string): Promise<AiResult> {
  let added = 0;
  let updated = 0;
  let removed = 0;

  // Remove from the highest index down so earlier indices stay valid.
  const toRemove = [...new Set(patch.remove ?? [])].sort((a, b) => b - a);
  for (const i of toRemove) {
    const item = placed[i];
    if (item && !item.entry.follow) {
      removeItem(state, item);
      removed++;
    }
  }

  for (const u of patch.update ?? []) {
    const item = placed[u.index];
    if (!item || !u.set) continue;
    Object.assign(item.entry, u.set);
    reapply(state, item);
    syncMarker(state, item);
    updated++;
  }

  for (const entry of patch.add ?? []) {
    if (!entry || typeof entry.src !== 'string') continue;
    if (entry.x === undefined || entry.z === undefined) continue;
    entry.y = entry.y ?? 0;
    entry.rotY = entry.rotY ?? 0;
    const item = await instantiate(state, entry);
    if (item) added++;
  }

  persist();
  return {
    ok: true,
    message: `Applied: ${added} added, ${updated} updated, ${removed} removed.`,
    added,
    updated,
    removed,
    raw,
  };
}
