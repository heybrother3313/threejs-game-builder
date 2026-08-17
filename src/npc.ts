import * as THREE from 'three';
import type { State } from 'vibegame';
import { grantLoot, setLootTrayVisible, spendLoot } from './loot';
import { FISTS, blastFlash, explode, isBomb } from './weapons';
import {
  findClip, groundHeightAt, instantiate, loadModel, persist, placed, removeItem,
  syncMarker, type PlacedItem,
} from './level';
import { getScene } from 'vibegame/rendering';
import { isTriggered, markTriggered } from './objectives';
import { ISLAND } from './ground';

/**
 * NPC behaviour, combat, and conversation.
 *
 * The vocabulary is the standard one games converge on, kept data-driven so
 * the builder (and the AI assistant) can compose it without new code:
 *
 *   faction   friendly | neutral | hostile   — who fights whom
 *   behaviour idle | patrol | wander | guard | follow | flee
 *   combat    health, damage, aggro/attack radius, knockback, loot
 *   dialogue  lines, plus offers to FOLLOW the player or GUIDE them somewhere
 *
 * NPCs move by writing their scene position directly rather than through
 * Rapier. They're set dressing with intent, not physics bodies: the engine's
 * character controller is single-player-shaped, and a hand-driven agent is far
 * easier to reason about (and to freeze in build mode) than a second body type.
 */

export type NpcFaction = 'friendly' | 'neutral' | 'hostile';
export type NpcBehavior = 'idle' | 'patrol' | 'wander' | 'guard' | 'follow' | 'flee';

export type NpcConfig = {
  faction?: NpcFaction;
  behavior?: NpcBehavior;
  health?: number;
  /** Damage per hit dealt to the player. */
  damage?: number;
  /** Movement speed, units/s. */
  speed?: number;
  /** Notices the player inside this radius (hostile: chases; flee: runs). */
  aggroRadius?: number;
  /** Close enough to swing. */
  attackRadius?: number;
  /** Conversation, one line per advance. */
  lines?: string[];
  /** Offers "follow me" in conversation. */
  canFollow?: boolean;
  /** Offers to lead the player to this spot. */
  guideTo?: [number, number];
  /** Line said on arrival at guideTo. */
  arriveLine?: string;
  /** Asset dropped when defeated, e.g. "/models/quaternius-pirate/Coins.glb". */
  loot?: string;
  /**
   * The weapon this one fights with. Dropped on defeat as a pickable, so
   * beating something bare-handed arms you for the next fight — the only
   * source of blades today is wherever a level author happened to put one.
   * Unlike loot it does NOT auto-collect: a weapon is a thing you choose to
   * pick up, and you can only carry one.
   */
  weapon?: string;
  /** Fetch quest: loot kind this NPC wants (e.g. "Chest Gold"). Talking with
   *  it in your inventory hands it over — once. */
  wantsItem?: string;
  /** What they say when you deliver. */
  thanksLine?: string;
  /** Loot kind granted on delivery, straight to the inventory. */
  reward?: string;
  /** Set once the fetch quest is completed — survives saves and travel. */
  delivered?: boolean;
};

type RtState =
  | 'idle'
  | 'patrol'
  | 'wander'
  | 'chase'
  | 'attack'
  | 'hit'
  | 'dead'
  | 'follow'
  | 'guide'
  | 'flee'
  | 'talk';

type Runtime = {
  hp: number;
  maxHp: number;
  state: RtState;
  t: number;
  cooldown: number;
  /** Time until the in-flight swing actually connects. */
  swing: number;
  home: THREE.Vector3;
  wanderTarget?: THREE.Vector3;
  bar?: THREE.Sprite;
  action?: THREE.AnimationAction;
  actionName?: string;
  following: boolean;
  guiding: boolean;
  /**
   * "Stay here" means HERE, not "go back where you spawned". Without this the
   * NPC drops out of follow, path-walking reclaims the transform and snaps it
   * to its authored waypoint. Parked NPCs hold position until asked to move.
   */
  parked: boolean;
  spokeTo: boolean;
  /**
   * Struck, so fighting back — for THIS visit only.
   *
   * This used to be written onto entry.npc.faction, which the level saves.
   * One stray punch turned a friendly permanently hostile, and she came back
   * angry every time the island reloaded. A grudge should not outlive the
   * session that earned it.
   */
  provoked: boolean;
  /** Fetch quest delivered; wantsItem stops matching. */
  rewarded: boolean;
};

const rt = new WeakMap<PlacedItem, Runtime>();

/** Clip names differ per pack; try the plausible ones in order. */
const CLIPS: Record<string, string[]> = {
  idle: ['Idle', 'Idle_Neutral', 'Spider_Idle', 'Swimming_Normal', 'Idle_A', 'Flying_Idle'],
  walk: ['Walk', 'Spider_Walk', 'Swimming_Normal', 'Walk_A', 'Waddle'],
  run: ['Run', 'Gallop', 'Swimming_Fast', 'Run_A', 'Spider_Walk'],
  attack: [
    'Attack', 'Punch', 'Punch_Left', 'Spider_Attack', 'Bite', 'Sword',
    'Gun_Shoot', 'Headbutt', 'Attack_A', 'Kick_Left',
  ],
  hit: ['HitReact', 'HitRecieve', 'Hit', 'Idle_HitReact_Left', 'Spider_HitReact', 'Hit_A'],
  death: ['Death', 'Die', 'Spider_Death', 'Death_A'],
};

/** How far into a swing the blow actually connects, seconds. */
export const SWING_CONTACT = 0.32;

/**
 * Vertical limits. Every range check used to be flat distance in x/z, so an
 * NPC could punch someone standing on a rock above its head — the maths simply
 * didn't know about height. Reach covers slopes and a step or two; notice is
 * looser, since seeing someone up a ledge is fine, it's hitting them that
 * isn't.
 */
const REACH_HEIGHT = 1.5;
const NOTICE_HEIGHT = 4;

export const DEFAULTS: Required<Pick<NpcConfig, 'health' | 'damage' | 'speed' | 'aggroRadius' | 'attackRadius'>> = {
  health: 30,
  damage: 8,
  speed: 2.2,
  aggroRadius: 8,
  attackRadius: 1.7,
};

/* ------------------------------------------------------------- player --- */

const PLAYER_MAX_HP = 100;
/**
 * Knockback is spread over time, not applied as one shove.
 *
 * The push writes the player's position directly (the character controller has
 * no impulse channel), so a single 2-unit shove is a teleport: the chase camera
 * snaps with it and the whole scene appears to jump — it reads as the page
 * reloading. A small velocity bled out over a fifth of a second stays legible
 * as "you got hit" without moving you across the beach.
 */
const KNOCK_SPEED = 2.6;   // units/s
const KNOCK_TIME = 0.22;   // seconds
let knock = { x: 0, z: 0, t: 0 };
let playerHp = PLAYER_MAX_HP;
let playerHurtT = 0;
let spawn = new THREE.Vector3(0, 1.2, 0);
/** Set by main.ts so NPCs can shove the player around on hit. */
let pushPlayer: ((dx: number, dz: number) => void) | null = null;
let teleportPlayer: ((x: number, y: number, z: number) => void) | null = null;
/** Plays the player's death/respawn animation; set by main.ts. */
let playerDeathHook: ((dying: boolean) => void) | null = null;
/** Plays the player's flinch; set by main.ts. */
let playerHitHook: (() => void) | null = null;
/** True once you've been beaten; stays true until you choose to restart. */
let playerDead = false;
/** Death animation plays for this long before the restart prompt appears. */
let deathAnimT = 0;

export function configurePlayerHooks(opts: {
  spawn?: THREE.Vector3;
  push?: (dx: number, dz: number) => void;
  teleport?: (x: number, y: number, z: number) => void;
  death?: (dying: boolean) => void;
  hit?: () => void;
}) {
  if (opts.spawn) spawn = opts.spawn.clone();
  if (opts.push) pushPlayer = opts.push;
  if (opts.teleport) teleportPlayer = opts.teleport;
  if (opts.death) playerDeathHook = opts.death;
  if (opts.hit) playerHitHook = opts.hit;
}

/** True while the player is dead — main.ts freezes input and the brain idles. */
export function playerIsDead() {
  return playerDead;
}

/** Put the player back on their feet. Called by the restart prompt. */
export function respawnPlayer() {
  if (!playerDead) return;
  playerDead = false;
  deathAnimT = 0;
  playerHp = PLAYER_MAX_HP;
  renderHud();
  teleportPlayer?.(spawn.x, spawn.y, spawn.z);
  playerDeathHook?.(false);
  showBanner(null);
  for (const item of placed) {
    const r = rt.get(item);
    if (r && r.state !== 'dead') {
      r.state = 'idle';
      r.following = false;
      r.guiding = false;
    }
  }
}

export function playerHealth() {
  return { hp: playerHp, max: PLAYER_MAX_HP };
}

/* ----------------------------------------------------------------- UI --- */

let hud: HTMLDivElement | null = null;
let dialogEl: HTMLDivElement | null = null;
let promptEl: HTMLDivElement | null = null;

/** Talker state for the conversation currently on screen. */
let talking: { item: PlacedItem; index: number } | null = null;

function ensureUi() {
  if (hud) return;
  const style = document.createElement('style');
  style.textContent = `
    #npc-hud { position:fixed; left:16px; top:16px; z-index:14; pointer-events:none;
      font-family: var(--font-body, Inter, sans-serif); }
    #npc-hud .bar { width:190px; height:16px; background: var(--surface-page,#fff);
      border:2px solid var(--border-strong,#111); border-radius:999px; overflow:hidden;
      box-shadow: 0 3px 0 var(--border-strong,#111); }
    #npc-hud .fill { height:100%; background:#e0523e; transition: width 140ms linear; }
    #npc-hud .label { font-size:11px; letter-spacing:.08em; text-transform:uppercase;
      color: var(--text-primary,#111); margin-bottom:4px; font-family: var(--font-display, sans-serif); }

    /* Speech is deliberately NOT the control bar's paper: coral tint, ink
       border, and a name chip so it reads as a character talking. */
    #npc-dialog { position:fixed; left:50%; bottom:96px; transform:translateX(-50%);
      z-index:16; max-width:min(70vw,640px); display:none;
      background: var(--color-coral-soft,#ffe2db); color: var(--text-primary,#111);
      border:2px solid var(--border-strong,#111); border-radius:14px;
      box-shadow: 0 5px 0 var(--border-strong,#111); padding:12px 16px;
      font-family: var(--font-body, Inter, sans-serif); font-size:15px; }
    #npc-dialog .who { display:inline-block; background: var(--color-coral,#fd9b9b);
      border:2px solid var(--border-strong,#111); border-radius:999px;
      padding:1px 10px; font-size:11px; font-weight:700; letter-spacing:.06em;
      text-transform:uppercase; margin-bottom:8px;
      font-family: var(--font-display, sans-serif); }
    #npc-dialog .line { line-height:1.5; }
    #npc-dialog .opts { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    #npc-dialog .opt { background: var(--surface-page,#fff); border:2px solid var(--border-strong,#111);
      border-radius:8px; padding:4px 10px; font-size:12px; font-weight:600;
      box-shadow:0 2px 0 var(--border-strong,#111); }
    #npc-prompt { position:fixed; left:50%; bottom:70px; transform:translateX(-50%);
      z-index:15; display:none; background: var(--surface-face,#faf7f2);
      border:2px solid var(--border-strong,#111); border-radius:10px;
      box-shadow:0 3px 0 var(--border-strong,#111); padding:5px 12px; font-size:12px;
      font-family: var(--font-body, Inter, sans-serif); }
  `;
  document.head.appendChild(style);

  hud = document.createElement('div');
  hud.id = 'npc-hud';
  hud.innerHTML = `<div class="label">Health</div><div class="bar"><div class="fill" id="npc-hp"></div></div>`;
  document.body.appendChild(hud);

  dialogEl = document.createElement('div');
  dialogEl.id = 'npc-dialog';
  document.body.appendChild(dialogEl);

  promptEl = document.createElement('div');
  promptEl.id = 'npc-prompt';
  document.body.appendChild(promptEl);
}

let bannerEl: HTMLDivElement | null = null;
function showBanner(text: string | null, sub?: string) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'npc-banner';
    bannerEl.style.cssText =
      'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:18;' +
      'display:none;background:var(--color-coral,#fd9b9b);color:var(--text-primary,#111);' +
      'border:3px solid var(--border-strong,#111);border-radius:16px;' +
      'box-shadow:0 6px 0 var(--border-strong,#111);padding:14px 28px;' +
      'font-family:var(--font-display,sans-serif);font-weight:700;font-size:26px;' +
      'letter-spacing:.04em;text-transform:uppercase;';
    document.body.appendChild(bannerEl);
  }
  if (text) {
    bannerEl.innerHTML =
      `<div>${text}</div>` +
      (sub
        ? `<div style="margin-top:8px;font-size:13px;font-weight:600;letter-spacing:.02em;` +
          `text-transform:none;font-family:var(--font-body,sans-serif)">${sub}</div>`
        : '');
    bannerEl.style.display = 'block';
  } else {
    bannerEl.style.display = 'none';
  }
}

function setHudVisible(v: boolean) {
  ensureUi();
  if (hud) hud.style.display = v ? 'block' : 'none';
  if (!v) {
    if (dialogEl) dialogEl.style.display = 'none';
    if (promptEl) promptEl.style.display = 'none';
    if (bannerEl) bannerEl.style.display = 'none';
  }
}

function renderHud() {
  const fill = document.getElementById('npc-hp');
  if (fill) fill.style.width = `${Math.max(0, (playerHp / PLAYER_MAX_HP) * 100)}%`;
}

function nameOf(item: PlacedItem) {
  return item.entry.src.split('/').pop()!.replace('.glb', '');
}

function showDialog(item: PlacedItem, index: number) {
  ensureUi();
  const cfg = item.entry.npc ?? {};
  const lines = linesOf(item);
  if (!dialogEl || index >= lines.length) {
    endTalk();
    return;
  }
  talking = { item, index };
  const last = index === lines.length - 1;
  const opts: string[] = [];
  if (last) {
    if (cfg.canFollow) opts.push(npcRuntime(item).following ? '[F] Stay here' : '[F] Follow me');
    if (cfg.guideTo) opts.push('[G] Lead the way');
    opts.push('[E] Goodbye');
  } else {
    opts.push('[E] Continue');
  }
  dialogEl.innerHTML =
    `<div class="who">${nameOf(item)}</div>` +
    `<div class="line">${lines[index]}</div>` +
    `<div class="opts">${opts.map((o) => `<span class="opt">${o}</span>`).join('')}</div>`;
  dialogEl.style.display = 'block';
}

function endTalk() {
  talking = null;
  if (dialogEl) dialogEl.style.display = 'none';
}

function linesOf(item: PlacedItem): string[] {
  const cfg = item.entry.npc;
  const base = cfg?.lines?.length
    ? [...cfg.lines]
    : item.entry.dialog
      ? [item.entry.dialog]
      : [];
  // The ask is automatic: an NPC that wants something SAYS so, without the
  // author scripting it — and stops asking once it's been delivered.
  if (cfg?.wantsItem && !cfg.delivered) {
    base.push(
      `I am looking for a ${cfg.wantsItem}. Bring it to me and I will make it worth your while.`
    );
  }
  return base;
}

/* ------------------------------------------------------------ runtime --- */

export function npcRuntime(item: PlacedItem): Runtime {
  let r = rt.get(item);
  if (!r) {
    const cfg = item.entry.npc ?? {};
    // Warm the loot model now, not on the frame this NPC dies — parsing a GLB
    // mid-combat costs a visible hitch right at the killing blow.
    const effectiveLoot = resolveLoot(cfg.loot, cfg.faction);
  if (effectiveLoot) void loadModel(effectiveLoot).catch(() => undefined);
    r = {
      hp: cfg.health ?? DEFAULTS.health,
      maxHp: cfg.health ?? DEFAULTS.health,
      state: 'idle',
      t: 0,
      cooldown: 0,
      swing: 0,
      home: item.obj.position.clone(),
      following: false,
      guiding: false,
      parked: false,
      spokeTo: false,
      provoked: false,
      rewarded: false,
    };
    rt.set(item, r);
  }
  return r;
}

/** Reset an NPC's brain — used when the builder edits it. */
export function resetNpc(item: PlacedItem) {
  rt.delete(item);
  if (item.entry.npc) npcRuntime(item);
}

function play(item: PlacedItem, action: keyof typeof CLIPS, once = false) {
  const r = npcRuntime(item);
  if (!item.mixer || !item.clips) return;
  // One-shots (hit, attack) must replay even if already the current action —
  // otherwise the second punch in a row produces no visible reaction at all.
  if (r.actionName === action && !once) return;
  const clip =
    CLIPS[action].map((n) => findClip(item.clips!, n)).find(Boolean) ?? null;
  if (!clip) return;
  const next = item.mixer.clipAction(clip);
  next.reset();
  if (once) {
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
  } else {
    next.setLoop(THREE.LoopRepeat, Infinity);
  }
  next.fadeIn(0.15).play();
  r.action?.fadeOut(0.15);
  r.action = next;
  r.actionName = action;
  item.currentAction = next;
}

/** Water-bound: anything animated by a swimming clip lives IN the sea. */
function isSwimmer(item: PlacedItem) {
  return !!item.entry.clip?.startsWith('Swimming');
}

/** True if (x, z) is on the island slab — land, as far as a fish cares. */
function onLand(x: number, z: number) {
  return Math.abs(x) < ISLAND.x + 0.8 && Math.abs(z) < ISLAND.z + 0.8;
}

function faceAndStep(item: PlacedItem, tx: number, tz: number, speed: number, dt: number) {
  const p = item.obj.position;
  const dx = tx - p.x;
  const dz = tz - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return 0;
  const step = Math.min(speed * dt, dist);
  const nx = p.x + (dx / dist) * step;
  const nz = p.z + (dz / dist) * step;
  // A provoked fish must not beach itself: swimmers refuse any step onto the
  // island. They turn along the coast instead of climbing it.
  if (isSwimmer(item) && onLand(nx, nz)) {
    item.obj.rotation.y = Math.atan2(dx, dz);
    return dist;
  }
  p.x = nx;
  p.z = nz;
  // Chasing across a hill should climb it, not tunnel through it.
  if (!isSwimmer(item)) p.y = (item.entry.y ?? 0) + groundHeightAt(nx, nz);
  item.obj.rotation.y = Math.atan2(dx, dz);
  return dist;
}

/* --------------------------------------------------------- health bar --- */

function healthBar(item: PlacedItem): THREE.Sprite {
  const r = npcRuntime(item);
  if (r.bar) return r.bar;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 24;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })
  );
  sprite.scale.set(1.1, 0.2, 1);
  sprite.renderOrder = 1002;
  sprite.userData.canvas = canvas;
  item.obj.parent?.add(sprite);
  r.bar = sprite;
  return sprite;
}

function drawHealthBar(item: PlacedItem) {
  const r = npcRuntime(item);
  const sprite = healthBar(item);
  const canvas = sprite.userData.canvas as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const frac = Math.max(0, r.hp / r.maxHp);
  ctx.clearRect(0, 0, 128, 24);
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, 128, 24);
  ctx.fillStyle = '#faf7f2';
  ctx.fillRect(3, 3, 122, 18);
  ctx.fillStyle = frac > 0.5 ? '#5aa469' : frac > 0.25 ? '#e0a13e' : '#e0523e';
  ctx.fillRect(3, 3, 122 * frac, 18);
  (sprite.material.map as THREE.CanvasTexture).needsUpdate = true;

  const box = new THREE.Box3().setFromObject(item.obj);
  sprite.position.set(
    (box.min.x + box.max.x) / 2,
    box.max.y + 0.3,
    (box.min.z + box.max.z) / 2
  );
  sprite.visible = r.hp < r.maxHp && r.state !== 'dead';
}

/* ------------------------------------------------------------ damage --- */

export function damageNpc(state: State, item: PlacedItem, amount: number, fromX: number, fromZ: number) {
  const r = npcRuntime(item);
  if (r.state === 'dead') return;
  r.hp -= amount;
  drawHealthBar(item);
  if (r.hp <= 0) {
    r.state = 'dead';
    r.t = 0;
    play(item, 'death', true);
    // Defeated NPCs stop blocking and drop their loot.
    for (const e of item.solidEs) {
      if (state.exists(e)) state.destroyEntity(e);
    }
    item.solidEs = [];
    // Its weapon falls where it stood — not popped like loot, because you
    // want to see whose it was.
    const weapon = item.entry.npc?.weapon;
    if (weapon) {
      void instantiate(state, {
        src: weapon.includes('/') ? weapon : `/models/quaternius-pirate/${weapon}.glb`,
        x: item.obj.position.x + 0.5,
        y: 0,
        z: item.obj.position.z + 0.3,
        rotY: Math.random() * Math.PI * 2,
        fitHeight: 0.8,
        solid: false,
        pickable: true,
      });
    }
    const loot = resolveLoot(item.entry.npc?.loot, item.entry.npc?.faction);
    if (loot) {
      // Pop it out of the body rather than dropping it underneath. A flat item
      // spawned at the corpse's feet is invisible — hidden by the very model
      // that dropped it — so give it a short arc and land it clear of the body.
      const dir = Math.random() * Math.PI * 2;
      void instantiate(state, {
        src: loot,
        x: item.obj.position.x,
        y: 0.9,
        z: item.obj.position.z,
        rotY: Math.random() * Math.PI * 2,
        fitHeight: 0.65,
        solid: false,
        pickable: true,
      }).then((drop) => {
        if (!drop) return;
        drop.flight = {
          vx: Math.sin(dir) * 1.8,
          vy: 3.2,
          vz: Math.cos(dir) * 1.8,
          restY: 0,
          harmless: true,
        };
      });
    }
    return;
  }
  // Knock back a little and flinch.
  const dx = item.obj.position.x - fromX;
  const dz = item.obj.position.z - fromZ;
  const d = Math.hypot(dx, dz) || 1;
  item.obj.position.x += (dx / d) * 0.35;
  item.obj.position.z += (dz / d) * 0.35;
  r.state = 'hit';
  r.t = 0;
  r.cooldown = Math.max(r.cooldown, 0.5); // a stagger costs them their next swing
  play(item, 'hit', true);
  // Being hit makes anyone hostile — except swimmers, who flee. A clownfish
  // that takes up arms and chases you up the beach is the wrong kind of funny.
  if (isSwimmer(item)) {
    if (!item.entry.npc) item.entry.npc = {};
    item.entry.npc.faction = 'neutral';
    item.entry.npc.behavior = 'flee';
    return;
  }
  r.provoked = true;
}

function hurtPlayer(amount: number, fromX: number, fromZ: number, px: number, pz: number) {
  if (playerHurtT > 0) return;
  playerHp = Math.max(0, playerHp - amount);
  playerHurtT = 0.6;
  if (playerHp > 0) playerHitHook?.();
  renderHud();
  const dx = px - fromX;
  const dz = pz - fromZ;
  const d = Math.hypot(dx, dz) || 1;
  knock = { x: (dx / d) * KNOCK_SPEED, z: (dz / d) * KNOCK_SPEED, t: KNOCK_TIME };
  if (playerHp <= 0 && !playerDead) {
    // Stay down. Respawning on a timer takes the decision away from the
    // player; the run ends when they say it ends.
    knock.t = 0;
    playerDead = true;
    deathAnimT = 0;
    playerDeathHook?.(true);
    endTalk();
  }
}

/* ------------------------------------------------------------- update --- */

/**
 * Accept a bare loot name as well as a full path.
 *
 * The field used to demand "/models/quaternius-pirate/Coins.glb"; typing
 * "Coins" produced a silent no-drop, which is indistinguishable from loot
 * being broken. Anything without a slash is looked up in the treasure kit.
 */
export function resolveLoot(loot?: string, faction?: string): string | undefined {
  const trimmed = loot?.trim();
  // Never configured + hostile: drop coins. Beating something and getting
  // nothing reads as broken, and "you must first fill in a model path" is a
  // bad answer. 'none' is the explicit opt-out.
  if (trimmed === undefined || trimmed === '') {
    return faction === 'hostile' ? '/models/quaternius-pirate/Coins.glb' : undefined;
  }
  if (trimmed === 'none') return undefined;
  if (trimmed.includes('/')) return trimmed;
  return `/models/quaternius-pirate/${trimmed.replace(/\.glb$/i, '')}.glb`;
}

/**
 * Where a swing should point.
 *
 * Getting hit shoves the player sideways, and after one knockback the enemy
 * standing right beside you is outside the swing's cone — measured: three
 * punches landed, then two whiffed at a range of 1.66m. Real action games
 * nudge the attacker toward the target rather than demanding pixel aim, so a
 * swing looks for anything living within reach in a wide arc and returns the
 * heading that faces it.
 */
export function aimAt(px: number, pz: number, fx: number, fz: number, reach: number) {
  let best: PlacedItem | null = null;
  let bestD = reach + 0.6;
  for (const item of placed) {
    if (!ensureAlive(item) || npcRuntime(item).state === 'dead') continue;
    const dx = item.obj.position.x - px;
    const dz = item.obj.position.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > bestD || d < 1e-3) continue;
    if ((dx / d) * fx + (dz / d) * fz < -0.2) continue; // roughly ahead
    best = item;
    bestD = d;
  }
  if (!best) return null;
  return Math.atan2(-(best.obj.position.x - px), -(best.obj.position.z - pz));
}

/**
 * Melee: hit every living NPC inside a short cone in front of the player.
 * Returns how many connected, so callers can tell a real hit from a whiff.
 */
/**
 * Anything with an animation rig counts as alive.
 *
 * Damage used to require an explicit npc config, so a character dropped from
 * the palette was invulnerable scenery until you set a Role — which reads as
 * "hits only land on hostiles". Living things now get a neutral config the
 * first time something tries to hurt them, and neutral means exactly that:
 * it won't start a fight, but it can be in one.
 */
function ensureAlive(item: PlacedItem): boolean {
  if (item.entry.npc) return true;
  if ((item.clips?.length ?? 0) === 0) return false; // a rock is not alive
  item.entry.npc = { faction: 'neutral' };
  return true;
}

export function playerMelee(
  state: State,
  px: number,
  py: number,
  pz: number,
  fx: number,
  fz: number,
  blade: { damage: number; reach: number } = FISTS
) {
  const { damage, reach } = blade;
  let hits = 0;
  for (const item of placed) {
    if (!ensureAlive(item)) continue;
    const r = npcRuntime(item);
    if (r.state === 'dead') continue;
    const dx = item.obj.position.x - px;
    const dz = item.obj.position.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist > reach || dist < 1e-3) continue;
    if (Math.abs(item.obj.position.y - py) > REACH_HEIGHT) continue; // out of reach above/below
    // In front of you, not behind — roughly a 60-degree half-angle.
    if ((dx / dist) * fx + (dz / dist) * fz < 0.5) continue;
    damageNpc(state, item, damage, px, pz);
    hits++;
  }
  return hits;
}

export function isNpc(item: PlacedItem) {
  return !!item.entry.npc || (item.clips?.length ?? 0) > 0;
}

/**
 * Drive every NPC one frame. `active` is false in build mode, which freezes
 * brains as well as animation so a patrolling fish stays clickable.
 */
export function updateNpcs(
  state: State,
  dt: number,
  playerPos: THREE.Vector3 | undefined,
  active: boolean
) {
  ensureUi();
  setHudVisible(active);
  setLootTrayVisible(active);
  if (!active || !playerPos) return;

  playerHurtT = Math.max(0, playerHurtT - dt);

  if (playerDead) {
    // Let the death animation play out before offering the way back.
    deathAnimT += dt;
    if (deathAnimT > 1.1) showBanner('You died', 'Press R to restart');
    renderHud();
    return; // nothing attacks a corpse
  }

  // Bleed out any knockback from a recent hit.
  if (knock.t > 0) {
    const step = Math.min(dt, knock.t);
    pushPlayer?.(knock.x * step, knock.z * step);
    knock.t -= dt;
  }

  let prompt: string | null = null;

  // Thrown props hurt anything alive, configured or not — checked before the
  // brain loop so a character with no Role can still be knocked about.
  // Bombs that have been thrown, so a landing can be told from a bomb that
  // has simply been sitting on the ground since the level loaded.
  for (const proj of [...placed]) {
    if (armedBombs.has(proj) && !proj.flight) {
      // It came to rest without hitting anything. Still a bomb.
      armedBombs.delete(proj);
      detonate(state, proj, playerPos);
      continue;
    }
    if (!proj.flight || proj.flight.harmless) continue;
    if (isBomb(proj)) armedBombs.add(proj);
    const bomb = isBomb(proj);
    let struck = false;
    for (const target of placed) {
      if (target === proj || !ensureAlive(target)) continue;
      if (npcRuntime(target).state === 'dead') continue;
      const d = Math.hypot(
        proj.obj.position.x - target.obj.position.x,
        proj.obj.position.z - target.obj.position.z
      );
      if (d < 1.1 && Math.abs(proj.obj.position.y - target.obj.position.y) < 2) {
        struck = true;
        if (!bomb) {
          proj.flight = undefined;
          damageNpc(state, target, 12, proj.obj.position.x, proj.obj.position.z);
        }
        break;
      }
    }
    // A bomb is not a rock: it goes off where it stops, whether that is a
    // body or the ground, and it takes the neighbourhood with it.
    if (bomb && struck) {
      armedBombs.delete(proj);
      detonate(state, proj, playerPos);
    }
  }

  // Boards are props, not NPCs — the loop below skips anything without an
  // npc block, so their prompt has to be raised here.
  const boardNear = nearbyBoard(playerPos);
  if (boardNear) prompt = `<b>E</b>&nbsp; read the quest board`;
  for (const item of placed) {
    const o = item.entry.objective;
    if (!o || o.kind !== 'activate' || isTriggered(item)) continue;
    const d = Math.hypot(item.obj.position.x - playerPos.x, item.obj.position.z - playerPos.z);
    if (d < 3.2 && Math.abs(item.obj.position.y - playerPos.y) < REACH_HEIGHT) {
      prompt = `<b>E</b>&nbsp; ${o.text}`;
    }
  }

  for (const item of placed) {
    const cfg = item.entry.npc;
    if (!cfg) continue;
    const r = npcRuntime(item);
    const speed = cfg.speed ?? DEFAULTS.speed;
    const aggro = cfg.aggroRadius ?? DEFAULTS.aggroRadius;
    const reach = cfg.attackRadius ?? DEFAULTS.attackRadius;
    const p = item.obj.position;
    const toPlayer = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    const heightGap = Math.abs(playerPos.y - p.y);
    const canReach = heightGap < REACH_HEIGHT;
    const canNotice = heightGap < NOTICE_HEIGHT;
    // A completed quest hands its gold "!" back for a plain coral one.
    if (item.bangStyle === 'gold' && cfg.delivered) syncMarker(state, item);
    // Conversation is a ceasefire: nothing presses an attack while a dialog
    // is open, and blows already in flight are called off.
    if (talking && (r.state === 'chase' || r.state === 'attack')) {
      r.state = 'idle';
      r.swing = 0;
    }
    // Assume path-walking owns the transform unless a state below takes over.
    item.npcDriving = false;
    r.t += dt;
    r.cooldown = Math.max(0, r.cooldown - dt);
    if (r.swing > 0) {
      r.swing = Math.max(0, r.swing - dt);
      if (r.swing === 0 && r.state !== 'dead' && toPlayer <= reach + 0.4 && canReach && !talking) {
        hurtPlayer(cfg.damage ?? DEFAULTS.damage, p.x, p.z, playerPos.x, playerPos.z);
      }
    }

    if (r.state === 'dead') {
      // Hold the transform. npcDriving was cleared above, and without taking
      // it back level.ts resumes walking the patrol route — so the corpse
      // slides along its old beat, which is what "dead things sliding around"
      // was.
      item.npcDriving = true;
      // The sea buries its own: after the death clip has played out, a dead
      // swimmer settles slowly below the surface and out of sight.
      if (isSwimmer(item) && r.t > 1.2 && item.obj.position.y > -1.6) {
        item.obj.position.y -= dt * 0.25;
      }
      drawHealthBar(item);
      continue;
    }
    if (r.state === 'hit') {
      if (r.t > 0.45) {
        r.state = cfg.faction === 'hostile' ? 'chase' : 'idle';
        r.t = 0;
      }
      drawHealthBar(item);
      continue;
    }

    // Conversation freezes the speaker so they don't wander off mid-sentence.
    if (talking?.item === item) {
      item.npcDriving = true;
      play(item, 'idle');
      item.obj.rotation.y = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
      drawHealthBar(item);
      continue;
    }

    // Offer a chat when close enough.
    if (
      linesOf(item).length && toPlayer < 3 && canReach && cfg.faction !== 'hostile' &&
      (!boardNear || toPlayer <= boardNear.d)
    ) {
      prompt = `<b>E</b>&nbsp; talk to ${nameOf(item)}`;
    }

    if (r.following) r.state = 'follow';
    else if (r.guiding) r.state = 'guide';
    else if ((cfg.faction === 'hostile' || r.provoked) && toPlayer < aggro && canNotice && !talking)
      r.state = toPlayer <= reach && canReach ? 'attack' : 'chase';
    else if (r.parked) r.state = 'idle';
    else if (cfg.behavior === 'flee' && toPlayer < aggro && canNotice) r.state = 'flee';
    else if (r.state === 'chase' || r.state === 'attack' || r.state === 'flee') r.state = 'idle';
    else if (cfg.behavior === 'wander') r.state = 'wander';
    else if (item.entry.path?.length) r.state = 'patrol';
    else r.state = 'idle';

    if (
      r.state === 'chase' || r.state === 'attack' || r.state === 'flee' ||
      r.state === 'follow' || r.state === 'guide' || r.state === 'wander' ||
      (r.parked && r.state === 'idle')
    ) {
      item.npcDriving = true;
    }

    switch (r.state) {
      case 'chase':
        play(item, 'run');
        faceAndStep(item, playerPos.x, playerPos.z, speed * 1.35, dt);
        break;

      case 'attack':
        item.obj.rotation.y = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
        if (r.cooldown === 0) {
          // Wind up now, connect partway through the animation. Damage on the
          // first frame of a swing reads as being hit before the arm moves.
          play(item, 'attack', true);
          r.cooldown = 1.1;
          r.swing = SWING_CONTACT;
        }
        break;

      case 'flee': {
        play(item, 'run');
        const away = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        faceAndStep(item, p.x + Math.sin(away) * 4, p.z + Math.cos(away) * 4, speed * 1.2, dt);
        break;
      }

      case 'follow': {
        const gap = 2.6;
        if (toPlayer > gap) {
          play(item, toPlayer > gap * 2 ? 'run' : 'walk');
          faceAndStep(item, playerPos.x, playerPos.z, speed * (toPlayer > gap * 2 ? 1.4 : 1), dt);
        } else {
          play(item, 'idle');
          item.obj.rotation.y = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
        }
        break;
      }

      case 'guide': {
        const dest = cfg.guideTo!;
        const left = Math.hypot(dest[0] - p.x, dest[1] - p.z);
        if (left < 1.2) {
          r.guiding = false;
          r.parked = true; // stay at the destination rather than walk home
          r.state = 'idle';
          play(item, 'idle');
          if (cfg.arriveLine) {
            item.entry.npc = { ...cfg, lines: [cfg.arriveLine] };
            showDialog(item, 0);
          }
        } else if (toPlayer > 6) {
          // Wait for a player who has fallen behind.
          play(item, 'idle');
        } else {
          play(item, 'walk');
          faceAndStep(item, dest[0], dest[1], speed, dt);
        }
        break;
      }

      case 'wander': {
        if (!r.wanderTarget || Math.hypot(r.wanderTarget.x - p.x, r.wanderTarget.z - p.z) < 0.6) {
          const a = Math.random() * Math.PI * 2;
          const rad = 2 + Math.random() * 4;
          r.wanderTarget = new THREE.Vector3(
            r.home.x + Math.sin(a) * rad,
            p.y,
            r.home.z + Math.cos(a) * rad
          );
        }
        play(item, 'walk');
        faceAndStep(item, r.wanderTarget.x, r.wanderTarget.z, speed * 0.6, dt);
        break;
      }

      case 'patrol':
        // Path walking lives in level.ts (it owns the waypoint maths); just
        // make sure the legs are moving.
        play(item, 'walk');
        break;

      default:
        play(item, 'idle');
    }

    drawHealthBar(item);
  }

  if (promptEl) {
    if (prompt && !talking) {
      promptEl.innerHTML = prompt;
      promptEl.style.display = 'block';
    } else {
      promptEl.style.display = 'none';
    }
  }
  renderHud();
}

/* -------------------------------------------------------------- input --- */

/**
 * The quest board. It doesn't STORE quests — it reads them off the NPCs
 * standing around it, so posting a job means giving someone a wantsItem and
 * nothing else. A board that had its own list would drift from the world the
 * moment anyone edited an NPC.
 */
function questBoardText(): string {
  const open: string[] = [];
  const done: string[] = [];
  for (const item of placed) {
    const n = item.entry.npc;
    if (!n?.wantsItem) continue;
    const line = `<b>${nameOf(item)}</b> wants a <b>${n.wantsItem}</b>` +
      (n.reward ? ` — pays a ${n.reward}` : '');
    (n.delivered ? done : open).push(line);
  }
  if (!open.length && !done.length) return 'The board is empty. Quiet season.';
  const parts = [];
  if (open.length) parts.push(`<b>WANTED</b><br>${open.join('<br>')}`);
  if (done.length) parts.push(`<span style="opacity:.55">Settled: ${done.length}</span>`);
  return parts.join('<br><br>');
}

/** The nearest quest board within reading distance, with its distance. */
function nearbyBoard(playerPos: THREE.Vector3): { item: PlacedItem; d: number } | null {
  let best: { item: PlacedItem; d: number } | null = null;
  for (const item of placed) {
    if (!item.entry.questBoard) continue;
    const d = Math.hypot(item.obj.position.x - playerPos.x, item.obj.position.z - playerPos.z);
    if (d > 3.2 || Math.abs(item.obj.position.y - playerPos.y) > REACH_HEIGHT) continue;
    if (!best || d < best.d) best = { item, d };
  }
  return best;
}

/** Thrown bombs still in the air; a landing is a detonation. */
const armedBombs = new Set<PlacedItem>();

function detonate(state: State, proj: PlacedItem, playerPos: THREE.Vector3) {
  const { x, y, z } = proj.obj.position;
  const scene = getScene(state);
  if (scene) blastFlash(scene, x, y, z);
  explode(
    state, x, y, z,
    (target, amount, fx, fz) => damageNpc(state, target, amount, fx, fz),
    (amount, fx, fz) => hurtPlayer(amount, fx, fz, playerPos.x, playerPos.z),
    playerPos
  );
  removeItem(state, proj);
}

/** True when the key was consumed by conversation. */
export function npcKey(code: string, playerPos: THREE.Vector3 | undefined): boolean {
  // Dead players only have one verb.
  if (playerDead) {
    if (code === 'KeyR') respawnPlayer();
    return true;
  }
  if (!playerPos) return false;

  if (talking) {
    const item = talking.item;
    const cfg = item.entry.npc ?? {};
    const r = npcRuntime(item);
    const lines = linesOf(item);
    const last = talking.index === lines.length - 1;

    if (code === 'KeyF' && last && cfg.canFollow) {
      r.following = !r.following;
      // Stopping means standing right here; starting means moving again.
      r.parked = !r.following;
      r.guiding = false;
      endTalk();
      return true;
    }
    if (code === 'KeyG' && last && cfg.guideTo) {
      r.guiding = true;
      r.following = false;
      r.parked = false;
      endTalk();
      return true;
    }
    if (code === 'KeyE' || code === 'Space' || code === 'Enter') {
      if (last) endTalk();
      else showDialog(item, talking.index + 1);
      return true;
    }
    if (code === 'Escape') {
      endTalk();
      return true;
    }
    return true; // conversation swallows other keys
  }

  if (code === 'KeyE') {
    // Something you can switch on, ring, or pull. Nearest wins, like talking.
    let act: PlacedItem | null = null;
    let actD = 3.2;
    for (const item of placed) {
      const o = item.entry.objective;
      if (!o || o.kind !== 'activate' || isTriggered(item)) continue;
      const d = Math.hypot(item.obj.position.x - playerPos.x, item.obj.position.z - playerPos.z);
      if (d < actD && Math.abs(item.obj.position.y - playerPos.y) < REACH_HEIGHT) {
        act = item; actD = d;
      }
    }
    if (act) {
      markTriggered(act);
      showBanner(act.entry.objective!.done ?? 'Done', null as unknown as string);
      setTimeout(() => showBanner(null), 1800);
      return true;
    }
    const board = nearbyBoard(playerPos);
    // Nearest talkable NPC wins over picking things up.
    let best: PlacedItem | null = null;
    let bestD = 3;
    for (const item of placed) {
      if (!linesOf(item).length && !item.entry.npc?.wantsItem) continue;
      if (item.entry.npc?.faction === 'hostile') continue;
      if (npcRuntime(item).state === 'dead') continue;
      if (Math.abs(item.obj.position.y - playerPos.y) > REACH_HEIGHT) continue;
      const d = Math.hypot(item.obj.position.x - playerPos.x, item.obj.position.z - playerPos.z);
      if (d < bestD) {
        best = item;
        bestD = d;
      }
    }
    // A board in a town square sits within arm's reach of everyone; if it
    // always won, none of them could be spoken to. Nearest thing wins.
    if (board && (!best || board.d <= bestD)) {
      ensureUi();
      if (dialogEl) {
        talking = { item: board.item, index: Number.MAX_SAFE_INTEGER };
        dialogEl.innerHTML =
          `<div class="who">Quest board</div>` +
          `<div class="line">${questBoardText()}</div>` +
          `<div class="opts"><span class="opt">[E] Done</span></div>`;
        dialogEl.style.display = 'block';
      }
      return true;
    }
    if (best) {
      const r = npcRuntime(best);
      r.spokeTo = true;
      if (best.entry.objective?.kind === 'talk') markTriggered(best);
      const cfg = best.entry.npc ?? {};
      // Fetch quest: if they want something and you're holding it, delivery
      // IS the conversation — hand it over, take the reward, hear the thanks.
      if (cfg.wantsItem && !cfg.delivered && spendLoot(cfg.wantsItem)) {
        r.rewarded = true;
        cfg.delivered = true; // survives saves: a paid quest stays paid
        persist();
        if (cfg.reward) grantLoot(cfg.reward);
        ensureUi();
        if (dialogEl) {
          talking = { item: best, index: Number.MAX_SAFE_INTEGER };
          dialogEl.innerHTML =
            `<div class="who">${nameOf(best)}</div>` +
            `<div class="line">${cfg.thanksLine ?? 'Exactly what I needed! Take this.'}` +
            `${cfg.reward ? ` <b>(+1 ${cfg.reward})</b>` : ''}</div>` +
            `<div class="opts"><span class="opt">[E] Goodbye</span></div>`;
          dialogEl.style.display = 'block';
        }
        return true;
      }
      showDialog(best, 0);
      return true;
    }
  }
  return false;
}

export function isTalking() {
  return !!talking;
}
