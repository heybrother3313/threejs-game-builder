import * as THREE from 'three';
import type { State } from 'vibegame';
import { findClip, instantiate, placed, type PlacedItem } from './level';

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
/** True once you've been beaten; stays true until you choose to restart. */
let playerDead = false;
/** Death animation plays for this long before the restart prompt appears. */
let deathAnimT = 0;

export function configurePlayerHooks(opts: {
  spawn?: THREE.Vector3;
  push?: (dx: number, dz: number) => void;
  teleport?: (x: number, y: number, z: number) => void;
  death?: (dying: boolean) => void;
}) {
  if (opts.spawn) spawn = opts.spawn.clone();
  if (opts.push) pushPlayer = opts.push;
  if (opts.teleport) teleportPlayer = opts.teleport;
  if (opts.death) playerDeathHook = opts.death;
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
  if (cfg?.lines?.length) return cfg.lines;
  return item.entry.dialog ? [item.entry.dialog] : [];
}

/* ------------------------------------------------------------ runtime --- */

export function npcRuntime(item: PlacedItem): Runtime {
  let r = rt.get(item);
  if (!r) {
    const cfg = item.entry.npc ?? {};
    r = {
      hp: cfg.health ?? DEFAULTS.health,
      maxHp: cfg.health ?? DEFAULTS.health,
      state: 'idle',
      t: 0,
      cooldown: 0,
      home: item.obj.position.clone(),
      following: false,
      guiding: false,
      parked: false,
      spokeTo: false,
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
  if (!item.mixer || !item.clips || r.actionName === action) return;
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

function faceAndStep(item: PlacedItem, tx: number, tz: number, speed: number, dt: number) {
  const p = item.obj.position;
  const dx = tx - p.x;
  const dz = tz - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return 0;
  const step = Math.min(speed * dt, dist);
  p.x += (dx / dist) * step;
  p.z += (dz / dist) * step;
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
    const loot = item.entry.npc?.loot;
    if (loot) {
      void instantiate(state, {
        src: loot,
        x: item.obj.position.x,
        y: 0,
        z: item.obj.position.z,
        rotY: Math.random() * Math.PI * 2,
        fitHeight: 0.5,
        solid: false,
        pickable: true,
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
  play(item, 'hit', true);
  // Being hit makes anyone hostile.
  if (item.entry.npc && item.entry.npc.faction !== 'hostile') {
    item.entry.npc.faction = 'hostile';
  }
}

function hurtPlayer(amount: number, fromX: number, fromZ: number, px: number, pz: number) {
  if (playerHurtT > 0) return;
  playerHp = Math.max(0, playerHp - amount);
  playerHurtT = 0.6;
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
 * Melee: hit every living NPC inside a short cone in front of the player.
 * Returns how many connected, so callers can tell a real hit from a whiff.
 */
export function playerMelee(
  state: State,
  px: number,
  pz: number,
  fx: number,
  fz: number,
  damage = 14,
  reach = 2.3
) {
  let hits = 0;
  for (const item of placed) {
    if (!item.entry.npc) continue;
    const r = npcRuntime(item);
    if (r.state === 'dead') continue;
    const dx = item.obj.position.x - px;
    const dz = item.obj.position.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist > reach || dist < 1e-3) continue;
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

  for (const item of placed) {
    const cfg = item.entry.npc;
    if (!cfg) continue;
    const r = npcRuntime(item);
    const speed = cfg.speed ?? DEFAULTS.speed;
    const aggro = cfg.aggroRadius ?? DEFAULTS.aggroRadius;
    const reach = cfg.attackRadius ?? DEFAULTS.attackRadius;
    const p = item.obj.position;
    const toPlayer = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    // Assume path-walking owns the transform unless a state below takes over.
    item.npcDriving = false;
    r.t += dt;
    r.cooldown = Math.max(0, r.cooldown - dt);

    // A thrown prop that reaches an NPC hurts it.
    for (const proj of placed) {
      if (!proj.flight) continue;
      const d = Math.hypot(proj.obj.position.x - p.x, proj.obj.position.z - p.z);
      if (d < 1.1 && Math.abs(proj.obj.position.y - p.y) < 2) {
        proj.flight = undefined;
        damageNpc(state, item, 12, proj.obj.position.x, proj.obj.position.z);
      }
    }

    if (r.state === 'dead') {
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
    if (linesOf(item).length && toPlayer < 3 && cfg.faction !== 'hostile') {
      prompt = `<b>E</b>&nbsp; talk to ${nameOf(item)}`;
    }

    if (r.following) r.state = 'follow';
    else if (r.guiding) r.state = 'guide';
    else if (cfg.faction === 'hostile' && toPlayer < aggro) r.state = toPlayer <= reach ? 'attack' : 'chase';
    else if (r.parked) r.state = 'idle';
    else if (cfg.behavior === 'flee' && toPlayer < aggro) r.state = 'flee';
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
        play(item, 'attack', true);
        item.obj.rotation.y = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
        if (r.cooldown === 0) {
          r.cooldown = 1.1;
          hurtPlayer(cfg.damage ?? DEFAULTS.damage, p.x, p.z, playerPos.x, playerPos.z);
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
    // Nearest talkable NPC wins over picking things up.
    let best: PlacedItem | null = null;
    let bestD = 3;
    for (const item of placed) {
      if (!linesOf(item).length) continue;
      if (item.entry.npc?.faction === 'hostile') continue;
      if (npcRuntime(item).state === 'dead') continue;
      const d = Math.hypot(item.obj.position.x - playerPos.x, item.obj.position.z - playerPos.z);
      if (d < bestD) {
        best = item;
        bestD = d;
      }
    }
    if (best) {
      npcRuntime(best).spokeTo = true;
      showDialog(best, 0);
      return true;
    }
  }
  return false;
}

export function isTalking() {
  return !!talking;
}
