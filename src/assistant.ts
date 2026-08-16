import type { State } from 'vibegame';
import {
  LevelEntry,
  PAINT_TILE,
  PAINTS,
  instantiate,
  persist,
  placed,
  reapply,
  removeItem,
  syncMarker,
} from './level';

/**
 * The builder's AI assistant, running on a LOCAL model first.
 *
 * The entire level is one JSON dialect and the builder already has verbs
 * (place, move, path, dialog, quest, portal, paint), so "AI in the builder"
 * reduces to: natural language in, a JSON patch out, applied through the same
 * code paths as clicks. Requests go to Ollama via the dev-server proxy
 * (/ollama), so there's no CORS and no key.
 *
 * Hard lessons encoded here:
 *  - Ollama's DEFAULT CONTEXT IS 4K TOKENS and it silently truncates from the
 *    top. A level dump plus an asset catalog blows straight past that, the
 *    system prompt falls off, and the model returns confident nonsense. We
 *    set num_ctx explicitly AND keep the context small anyway (paint tiles
 *    are summarised, entries are compacted).
 *  - `format: "json"` guarantees JSON, not OUR json. Passing a full JSON
 *    Schema as `format` makes Ollama grammar-constrain the reply to the
 *    patch shape — the difference between "usually" and "always".
 *  - Models invent asset paths. Every src is validated against the real
 *    catalog, bare names are resolved across packs, and anything unresolvable
 *    comes back as an error the model gets ONE chance to fix.
 */

export type AiConfig = { url: string; model: string };

/** Where the player is standing, so prompts can say "in front of me". */
let playerPosProvider:
  | (() => { x: number; z: number; facingX: number; facingZ: number })
  | null = null;
export function setPlayerPosProvider(fn: typeof playerPosProvider) {
  playerPosProvider = fn;
}

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

/**
 * Canned prompts: the assistant can only compose verbs it knows exist, and a
 * blank box doesn't advertise them. These double as documentation and as the
 * fastest way to get a testable scenario on screen.
 */
export const QUICK_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: 'Combat test',
    prompt:
      'Spawn two hostile monsters about 6 units in front of the player (health 30, damage 8, ' +
      'aggroRadius 5, loot Coins) and four pickable barrels within 2 units of the player to throw.',
  },
  {
    label: 'Village scene',
    prompt:
      'Build a little village scene near the player: two friendly people with pirate-voiced ' +
      'dialogue, one patrolling a small square, one who can follow. Add market clutter ' +
      '(barrels, buckets) and paint a road disc under it.',
  },
  {
    label: 'Fetch quest',
    prompt:
      'Create a quest: a friendly character who asks for a Gem Blue and rewards a Gold Bag ' +
      'with a thankful line, and place the Gem Blue somewhere guarded by one hostile monster ' +
      'about 8 units away.',
  },
  {
    label: 'Wildlife',
    prompt:
      'Add a fox, a deer and two birds near the player with wander behaviour, non-solid, ' +
      'speed about 1.5, plus a patch of grass and ferns around them.',
  },
  {
    label: 'Guard patrol',
    prompt:
      'Add two hostile guards patrolling a rectangle around the biggest structure in the level, ' +
      'aggroRadius 5, health 40, dropping a Gold Bag when defeated.',
  },
  {
    label: 'Boss arena',
    prompt:
      'Stage a boss fight about 10 units from the player: one big monster (health 120, damage 15, ' +
      'loot Chest Gold), two weaker minions guarding it, throwable bombs nearby, and a couple of ' +
      'climbable rocks (solid, trimTop 0.15) to fight from.',
  },
];

/* ------------------------------------------------------------ catalog --- */

const MODEL_DIRS: { dir: string; hint: string }[] = [
  { dir: 'quaternius-pirate', hint: 'pirate props, buildings, ships, weapons, treasure, a few characters' },
  { dir: 'ultimate-monsters', hint: 'animated creatures — best pick for enemies and monster NPCs' },
  { dir: 'animated-animal-pack', hint: 'animated wildlife (fox, deer, wolf, horse…)' },
  { dir: 'animated-fish-bundle', hint: 'animated fish (clip "Swimming_Normal") plus docks and boats' },
  { dir: 'stylized-nature-megakit', hint: 'trees, rocks, plants, flowers — scenery, no rigs' },
  { dir: 'terrain', hint: 'Hill and Mountain — big landscape pieces, solid, fitHeight 2-6' },
  { dir: 'kenney-survival', hint: 'ground platforms (Rock Flat, Rock Flat Grass, Floor), camp gear, tools, tents' },
  { dir: 'ultimate-modular-men-pack', hint: 'animated male people' },
  { dir: 'ultimate-modular-women-pack', hint: 'animated female people' },
  { dir: 'animated-men-pack', hint: 'animated men with jump/death clips' },
  { dir: 'animated-women-pack', hint: 'animated women with jump/death clips' },
  { dir: 'animated-enemies', hint: 'animated classic enemies (skeleton, spider…)' },
];

let catalogCache: Map<string, string[]> | null = null;

/** dir -> model names, from the manifests the thumbnailer already relies on. */
async function catalog(): Promise<Map<string, string[]>> {
  if (catalogCache) return catalogCache;
  const out = new Map<string, string[]>();
  await Promise.all(
    MODEL_DIRS.map(async ({ dir }) => {
      try {
        const res = await fetch(`/models/${dir}/manifest.json`);
        out.set(dir, res.ok ? ((await res.json()) as string[]) : []);
      } catch {
        out.set(dir, []);
      }
    })
  );
  catalogCache = out;
  return out;
}

/**
 * Make a model-proposed src real. Exact path wins; then the same name in any
 * pack; then a case-insensitive contains-match. Null means it doesn't exist
 * anywhere and the op is rejected rather than silently dropped on the floor.
 */
function resolveSrc(cat: Map<string, string[]>, src: string): string | null {
  const m = /^\/models\/([^/]+)\/(.+)\.glb$/.exec(src);
  const wanted = (m ? m[2] : src.replace(/\.glb$/i, '')).trim();
  if (m && (cat.get(m[1]) ?? []).includes(wanted)) return src;
  for (const [dir, names] of cat) {
    if (names.includes(wanted)) return `/models/${dir}/${wanted}.glb`;
  }
  const lower = wanted.toLowerCase();
  for (const [dir, names] of cat) {
    const hit =
      names.find((n) => n.toLowerCase() === lower) ??
      names.find((n) => n.toLowerCase().includes(lower));
    if (hit) return `/models/${dir}/${hit}.glb`;
  }
  return null;
}

/* -------------------------------------------------------------- patch --- */

type PaintOp = { color: string; cx: number; cz: number; r: number };
type Patch = {
  add?: LevelEntry[];
  update?: { id: number; set: Partial<LevelEntry> }[];
  remove?: number[];
  paint?: PaintOp[];
};

/** Grammar-enforced by Ollama structured outputs: the reply IS this shape. */
const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    add: { type: 'array', items: { type: 'object' } },
    update: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, set: { type: 'object' } },
        required: ['id', 'set'],
      },
    },
    remove: { type: 'array', items: { type: 'integer' } },
    paint: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          color: { type: 'string' },
          cx: { type: 'number' },
          cz: { type: 'number' },
          r: { type: 'number' },
        },
        required: ['color', 'cx', 'cz', 'r'],
      },
    },
  },
} as const;

/* ------------------------------------------------------------- prompt --- */

function systemPrompt(cat: Map<string, string[]>): string {
  return [
    'You are the level editor for a 3D island game. You receive the current level and a',
    'request; you reply with ONE JSON patch. No prose, no markdown.',
    '',
    'PATCH SHAPE (omit keys you do not need):',
    '{"add":[ENTRY...], "update":[{"id":N,"set":{...}}...], "remove":[N...],',
    ' "paint":[{"color":"sand|grass|water|road|rock|jungle","cx":X,"cz":Z,"r":RADIUS}...]}',
    'ids come from the CURRENT LEVEL listing. paint fills a ground disc (use it for roads,',
    'clearings, terrain — never add paint tiles via "add").',
    '',
    'ENTRY fields:',
    '  src        "/models/<pack>/<Name>.glb" — MUST exist in the catalog below',
    '  x, z       world position. Ground is y=0 (omit y unless stacking on something).',
    '  rotY       radians. fitHeight: target height in metres (props 0.4-1.5, people ~1.7,',
    '             monsters 1.5-2.6, trees 3-6, buildings 4-9). Use fitMaxDim instead for',
    '             wide flat things (docks, sprawled models).',
    '  solid      true = player collides (buildings, rocks, trees). Grass/flowers/small',
    '             props: false. trimTop 0.15 on climbable rocks.',
    '  pickable   true = player can carry (E) and throw (F). Use for barrels, bombs, props.',
    '  clip       looped animation: "Idle" | "Walk" | "Run" | fish "Swimming_Normal".',
    '             Fish/sharks belong IN the water: past the beach edge (|z|>9 or |x|>13)',
    '             AND y about -0.45 so the body sits half in the water (water line is -0.35).',
    '  path       [[x,z],...] patrol loop. speed: units/s (walk 1.2-1.8, run 2-3).',
    '  exitTo     world id — piece becomes a travel portal (E to sail):',
    '             pirate-cove | fishing-village | jungle-outpost | monster-arena | blank-sands',
    '',
    'ENTRY.npc — set for anything that should act alive (needs a rigged pack):',
    '  faction    "friendly" | "neutral" | "hostile" (hostile chases + attacks)',
    '  behavior   "idle" | "patrol" | "wander" | "guard" | "flee"',
    '  health, damage, speed, aggroRadius (notice range; keep 4-6 so fights are picked,',
    '  not ambient), attackRadius (~1.7)',
    '  lines      ["…","…"] conversation, advanced with E',
    '  canFollow  true offers "follow me". guideTo [x,z] + arriveLine = escort.',
    '  loot       drop on defeat: Coins | Gold Bag | Gold ore | Gem Blue | Gem Green |',
    '             Gem Pink | Chest Gold (loot auto-collects into the player inventory)',
    '  wantsItem + thanksLine + reward = fetch quest. Collectibles: Coins, Gold Bag,',
    '    Gold ore, Gem Blue/Green/Pink, Chest Gold, Skull, Prop Bottle. The NPC',
    '    automatically ASKS for wantsItem in conversation — no need to script it.',
    '',
    'SCENE RECIPES — compose these, they are what makes a request a SCENE:',
    '  Guarded prize: loot on the ground + hostile guard behavior:"guard" nearby.',
    '  Quest chain: NPC A wantsItem X + reward Y; place X guarded elsewhere.',
    '  Patrol route: path around a landmark + faction hostile + small aggroRadius.',
    '  Escort: guideTo a far point + arriveLine; put danger along the way.',
    '  Market/camp: cluster props 0.5-1 unit apart near a building + one talker;',
    '    scatter 6-12 non-solid plants around; paint a road/clearing disc under it.',
    '  Boss: big monster health 100+, minions with lower health, throwables nearby,',
    '    climbable rocks (solid + trimTop) for height advantage.',
    '  Only rigged packs (monsters/animals/fish/people/enemies) can be NPCs; nature-kit',
    '  and props cannot walk or talk.',
    '',
    'EXAMPLE — "add a guarded treasure north of the player" (player at 0,0 facing -z):',
    '{"add":[{"src":"/models/quaternius-pirate/Gem Pink.glb","x":0,"z":-8,"rotY":0.4,',
    '"fitHeight":0.4,"pickable":true},{"src":"/models/ultimate-monsters/Orc.glb","x":0.8,',
    '"z":-7,"rotY":1.6,"fitHeight":1.8,"clip":"Idle","npc":{"faction":"hostile",',
    '"behavior":"guard","health":40,"damage":9,"aggroRadius":5,"loot":"Coins"}}]}',
    '',
    'ASSET CATALOG (the ONLY valid srcs):',
    ...MODEL_DIRS.map(({ dir, hint }) => {
      const names = cat.get(dir) ?? [];
      return `/models/${dir}/ (${hint}): ${names.join(', ')}`;
    }),
  ].join('\n');
}

/**
 * The level as the model sees it: compact ids for real pieces, paint
 * summarised. 150 paint tiles as JSON is context poison — it starves the
 * instructions and the model starts freelancing.
 */
function levelContext(): string {
  const lines: string[] = [];
  const paintCounts: Record<string, number> = {};
  for (let i = 0; i < placed.length; i++) {
    const e = placed[i].entry;
    if (e.paint) {
      paintCounts[e.paint] = (paintCounts[e.paint] ?? 0) + 1;
      continue;
    }
    if (e.src === 'spawn') {
      lines.push(`${i}: SPAWN FLAG at (${e.x.toFixed(1)}, ${e.z.toFixed(1)})`);
      continue;
    }
    const parts: string[] = [
      `${i}: ${e.src.split('/').pop()!.replace('.glb', '')}`,
      `(${e.x.toFixed(1)}, ${e.z.toFixed(1)})`,
    ];
    if (e.y) parts.push(`y=${e.y.toFixed(1)}`);
    if (e.solid) parts.push('solid');
    if (e.pickable) parts.push('pickable');
    if (e.clip && e.clip !== 'Idle') parts.push(`clip=${e.clip}`);
    if (e.path?.length) parts.push(`path[${e.path.length}]`);
    if (e.exitTo) parts.push(`portal→${e.exitTo}`);
    if (e.npc) {
      const n = e.npc;
      parts.push(
        `npc{${n.faction ?? 'neutral'}/${n.behavior ?? 'idle'}` +
          `${n.lines?.length ? ` ${n.lines.length} lines` : ''}` +
          `${n.wantsItem ? ` wants ${n.wantsItem}` : ''}}`
      );
    }
    lines.push(parts.join(' '));
  }
  const paintSummary = Object.entries(paintCounts)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return (
    `PAINT TILES (summary — edit via the paint op): ${paintSummary || 'none'}\n` +
    `PIECES (id: name (x, z) flags):\n${lines.join('\n')}`
  );
}

/* -------------------------------------------------------------- apply --- */

export type AiResult = {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  removed: number;
  painted?: number;
  errors?: string[];
  raw?: string;
};

async function applyPatch(state: State, patch: Patch, raw: string): Promise<AiResult> {
  const cat = await catalog();
  const errors: string[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  let painted = 0;

  // Remove from the highest id down so earlier ids stay valid.
  const toRemove = [...new Set(patch.remove ?? [])].sort((a, b) => b - a);
  for (const i of toRemove) {
    const item = placed[i];
    if (item && !item.entry.follow) {
      removeItem(state, item);
      removed++;
    } else errors.push(`remove: no piece with id ${i}`);
  }

  for (const u of patch.update ?? []) {
    const item = placed[u.id];
    if (!item || !u.set) {
      errors.push(`update: no piece with id ${u.id}`);
      continue;
    }
    if (u.set.src) {
      const fixed = resolveSrc(cat, u.set.src);
      if (!fixed) {
        errors.push(`update ${u.id}: unknown src "${u.set.src}"`);
        delete u.set.src;
      } else u.set.src = fixed;
    }
    Object.assign(item.entry, u.set);
    reapply(state, item);
    syncMarker(state, item);
    updated++;
  }

  for (const entry of patch.add ?? []) {
    if (!entry || typeof entry.src !== 'string') continue;
    const fixed = resolveSrc(cat, entry.src);
    if (!fixed) {
      errors.push(`add: unknown src "${entry.src}" — pick from the catalog`);
      continue;
    }
    entry.src = fixed;
    if (entry.x === undefined || entry.z === undefined) {
      errors.push(`add ${fixed.split('/').pop()}: missing x/z`);
      continue;
    }
    entry.y = entry.y ?? 0;
    entry.rotY = entry.rotY ?? 0;
    const item = await instantiate(state, entry);
    if (item) added++;
    else errors.push(`add: ${entry.src} failed to load`);
  }

  for (const op of patch.paint ?? []) {
    if (!PAINTS[op.color]) {
      errors.push(`paint: unknown color "${op.color}"`);
      continue;
    }
    const r = Math.min(Math.abs(op.r), 14);
    for (let dx = -r; dx <= r; dx += PAINT_TILE) {
      for (let dz = -r; dz <= r; dz += PAINT_TILE) {
        if (Math.hypot(dx, dz) > r) continue;
        const x = Math.round((op.cx + dx) / PAINT_TILE) * PAINT_TILE;
        const z = Math.round((op.cz + dz) / PAINT_TILE) * PAINT_TILE;
        if (Math.abs(x) > 13 || Math.abs(z) > 19) continue;
        const existing = placed.find((i) => i.entry.paint && i.entry.x === x && i.entry.z === z);
        if (existing) {
          if (existing.entry.paint === op.color) continue;
          removeItem(state, existing);
        }
        await instantiate(state, { src: 'paint', paint: op.color, x, y: 0, z, rotY: 0 });
        painted++;
      }
    }
  }

  persist();
  const bits: string[] = [];
  if (added) bits.push(`${added} added`);
  if (updated) bits.push(`${updated} updated`);
  if (removed) bits.push(`${removed} removed`);
  if (painted) bits.push(`${painted} tiles painted`);
  if (!bits.length) bits.push('nothing changed');
  return {
    ok: true,
    message: `Applied: ${bits.join(', ')}.${errors.length ? `\n⚠ ${errors.join('\n⚠ ')}` : ''}`,
    added,
    updated,
    removed,
    painted,
    errors,
    raw,
  };
}

/**
 * Accept what small models actually emit: a proper patch, a bare entry, or a
 * bare array of entries. Grammar constraint makes the first the norm; the
 * fallbacks cost nothing and save a round trip when it drifts.
 */
function normalize(parsed: unknown): Patch | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) return { add: parsed as LevelEntry[] };
  const o = parsed as Record<string, unknown>;
  if (o.add || o.update || o.remove || o.paint) return o as Patch;
  if (typeof o.src === 'string') return { add: [o as unknown as LevelEntry] };
  return null;
}

/* ---------------------------------------------------------------- run --- */

type ChatMsg = { role: string; content: string };

async function chat(cfg: AiConfig, messages: ChatMsg[]): Promise<string> {
  const res = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: PATCH_SCHEMA,
      // The default 4k context truncates the system prompt off the top and
      // the model starts inventing. 16k fits catalog + level with room over.
      options: { temperature: 0.2, num_ctx: 16384 },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

export async function runAssistant(
  state: State,
  cfg: AiConfig,
  request: string
): Promise<AiResult> {
  const cat = await catalog();
  const pp = playerPosProvider?.();
  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt(cat) },
    {
      role: 'user',
      content:
        (pp
          ? `PLAYER at (${pp.x.toFixed(1)}, ${pp.z.toFixed(1)}), facing (${pp.facingX.toFixed(2)}, ` +
            `${pp.facingZ.toFixed(2)}). "In front of the player" = along that facing.\n\n`
          : '') +
        `CURRENT LEVEL:\n${levelContext()}\n\nREQUEST: ${request}`,
    },
  ];

  let raw: string;
  try {
    raw = await chat(cfg, messages);
  } catch (err) {
    return { ok: false, message: (err as Error).message, added: 0, updated: 0, removed: 0 };
  }

  const patch = parseRaw(raw);
  if (!patch) {
    return {
      ok: false,
      message: 'Model reply was not a usable patch',
      added: 0,
      updated: 0,
      removed: 0,
      raw,
    };
  }
  let result = await applyPatch(state, patch, raw);

  // One self-repair round: feed the errors back and apply only the fixes.
  if (result.errors?.length) {
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content:
        `Some operations failed:\n${result.errors.join('\n')}\n` +
        `Reply with a patch that fixes ONLY these failures (correct srcs from the catalog, ` +
        `valid ids). Do not repeat operations that succeeded.`,
    });
    try {
      const raw2 = await chat(cfg, messages);
      const patch2 = parseRaw(raw2);
      if (patch2) {
        const r2 = await applyPatch(state, patch2, raw2);
        result = {
          ...r2,
          added: result.added + r2.added,
          updated: result.updated + r2.updated,
          removed: result.removed + r2.removed,
          painted: (result.painted ?? 0) + (r2.painted ?? 0),
          message: `${result.message.split('\n')[0]} Retry: ${r2.message}`,
          raw: `${raw}\n---\n${raw2}`,
        };
      }
    } catch {
      /* the first round's result stands */
    }
  }
  return result;
}

function parseRaw(raw: string): Patch | null {
  // Grammar mode should make this trivial, but strip fences just in case.
  const text = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  try {
    return normalize(JSON.parse(text));
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return normalize(JSON.parse(text.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}
