import type { LevelEntry } from './level';

/**
 * Starter levels.
 *
 * Designing a world from an empty beach is a different skill from designing
 * gameplay, and demanding both is how people bounce off a level editor. These
 * hand the builder a populated place to start: terrain painted, scenery
 * dressed, a few characters already doing something. Delete what you don't
 * want — every piece is an ordinary entry, nothing here is privileged.
 *
 * They're generated rather than stored as fixtures so the layouts stay
 * readable and tunable, but the randomness is SEEDED: the same starter always
 * produces the same world, so "load Fishing village" means one specific place
 * everybody can talk about.
 */

/**
 * Fit flat models by their LONGEST dimension, not their height.
 *
 * A sawmill is 2.07 wide and 0.59 tall; asking for "4 metres tall" scales it
 * 6.7x and you get a fourteen-metre slab lying across the map. Anything
 * wider than it is tall wants fitMaxDim — the rule of thumb is
 * max(width, depth) / height > 1.6.
 */
const P = (n: string) => `/models/quaternius-pirate/${n}.glb`;
const N = (n: string) => `/models/stylized-nature-megakit/${n}.glb`;
const M = (n: string) => `/models/ultimate-monsters/${n}.glb`;
const W = (n: string) => `/models/animated-women-pack/${n}.glb`;
const MEN = (n: string) => `/models/animated-men-pack/${n}.glb`;

/**
 * A tiny LCG. Math.random would make every load of "Jungle outpost" a
 * different place, which is worse than it sounds: you couldn't tell someone
 * where the chest is, and a starter you can't describe isn't a starter.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The playable beach, in world units — everything is placed inside this. */
const BOUNDS = { x: 12.5, z: 8.5 };

/** Paint a rectangle of ground tiles on the 2-unit grid. */
function paintRect(
  paint: string,
  x0: number,
  z0: number,
  x1: number,
  z1: number
): LevelEntry[] {
  const out: LevelEntry[] = [];
  for (let x = Math.ceil(x0 / 2) * 2; x <= x1; x += 2) {
    for (let z = Math.ceil(z0 / 2) * 2; z <= z1; z += 2) {
      out.push({ src: 'paint', paint, x, y: 0, z, rotY: 0 });
    }
  }
  return out;
}

/** Paint a rough disc — islands and clearings aren't rectangles. */
function paintBlob(
  paint: string,
  cx: number,
  cz: number,
  radius: number,
  rand: () => number
): LevelEntry[] {
  const out: LevelEntry[] = [];
  for (let x = -radius - 2; x <= radius + 2; x += 2) {
    for (let z = -radius - 2; z <= radius + 2; z += 2) {
      const d = Math.hypot(x, z);
      if (d > radius + rand() * 1.6 - 0.8) continue;
      const px = Math.round((cx + x) / 2) * 2;
      const pz = Math.round((cz + z) / 2) * 2;
      if (Math.abs(px) > BOUNDS.x + 1 || Math.abs(pz) > BOUNDS.z + 3) continue;
      out.push({ src: 'paint', paint, x: px, y: 0, z: pz, rotY: 0 });
    }
  }
  return out;
}

/**
 * Scatter scenery without stacking it on top of anything already placed or on
 * the player's spawn. A starter whose first impression is two trees growing
 * through each other doesn't read as a designed place.
 */
function scatter(
  kinds: { src: string; height: [number, number]; solid?: boolean }[],
  count: number,
  rand: () => number,
  taken: { x: number; z: number; r: number }[],
  area = BOUNDS
): LevelEntry[] {
  const out: LevelEntry[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const x = (rand() * 2 - 1) * area.x;
    const z = (rand() * 2 - 1) * area.z;
    const r = kind.solid ? 1.1 : 0.5;
    if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r)) continue;
    taken.push({ x, z, r });
    out.push({
      src: kind.src,
      x: +x.toFixed(2),
      y: 0,
      z: +z.toFixed(2),
      rotY: +(rand() * Math.PI * 2).toFixed(3),
      fitHeight: +(kind.height[0] + rand() * (kind.height[1] - kind.height[0])).toFixed(2),
      solid: kind.solid ?? false,
    });
  }
  return out;
}

/** Keep the spawn point clear so you don't start inside a tree. */
const spawnClear = () => [{ x: 0, z: 0, r: 3 }];

function pirateCove(): LevelEntry[] {
  const rand = rng(1337);
  // Structures claim their ground first, or scatter grows a palm through the dock.
  const taken = [...spawnClear(), { x: 1.5, z: -9, r: 3.5 }, { x: -7.5, z: -11, r: 5 },
    { x: 9, z: -5.5, r: 3 }];
  return [
    ...paintBlob('sand', 0, 0, 11, rand),
    ...paintRect('water', -12, 9, 12, 9),
    { src: P('Dock'), x: 1.5, y: -3.4, z: -10, rotY: 10.9956, scale: 1.494, solid: true },
    { src: P('Ship'), x: -7.5, y: -1.2, z: -12.5, rotY: 0.5, fitHeight: 9, solid: true },
    { src: P('Rock'), x: 5.5, y: 0, z: -4.5, rotY: 0.4, fitHeight: 1.4, solid: true, trimTop: 0.15 },
    { src: P('Rocks'), x: -8, y: 0, z: 4, rotY: 0.3, fitHeight: 2.6, solid: true, trimTop: 0.15 },
    { src: P('Palm Tree'), x: -6, y: 0, z: -2, rotY: 1.2, fitHeight: 5.5, solid: true, colliderXZ: 0.5 },
    { src: P('Palm Tree'), x: 8.5, y: 0, z: 3.5, rotY: 3.4, fitHeight: 4.8, solid: true, colliderXZ: 0.5 },
    { src: P('House'), x: 9, y: 0, z: -5.5, rotY: 3.6, fitHeight: 4.2, solid: true },
    { src: P('Barrel'), x: 2.2, y: 0, z: -2.4, rotY: 0.6, fitHeight: 0.9, pickable: true },
    { src: P('Barrel'), x: 3.1, y: 0, z: -1.6, rotY: 2.2, fitHeight: 0.9, pickable: true },
    { src: P('Chest Gold'), x: -3.5, y: 0, z: -6, rotY: 0.9, fitHeight: 0.8, solid: true },
    { src: P('Cannon'), x: 6.5, y: 0, z: -7, rotY: 2.6, fitHeight: 1.3, solid: true },
    {
      src: P('Pirate Captain'), x: -2, y: 0, z: -3.5, rotY: 0.4, fitHeight: 1.7,
      clip: 'Idle', solid: false,
      npc: {
        faction: 'friendly', behavior: 'idle', speed: 1.6,
        lines: [
          'Ahoy! You look like someone who needs work.',
          'Rocks to the east, wreck to the west. Mind the crabs.',
          'Bring me back something shiny and we will talk.',
        ],
        canFollow: true,
      },
    },
    ...scatter(
      // Beach dressing only: the nature kit's Bush is autumn red, which reads
      // as a shrub that wandered in from another biome.
      [
        { src: N('Grass Wispy'), height: [0.3, 0.55] },
        { src: N('Grass'), height: [0.3, 0.5] },
        { src: N('Pebble Round'), height: [0.15, 0.3] },
        { src: N('Pebble Square'), height: [0.15, 0.3] },
      ],
      24, rand, taken
    ),
  ];
}

function jungleOutpost(): LevelEntry[] {
  const rand = rng(90210);
  const taken = [...spawnClear(), { x: -7, z: -5, r: 3.5 }];
  return [
    ...paintBlob('jungle', 0, -1, 12, rand),
    ...paintBlob('grass', 2, 3, 6, rand),
    ...paintRect('road', -1, -8, 1, 6),
    { src: P('House'), x: -7, y: 0, z: -5, rotY: 0.7, fitHeight: 4.4, solid: true },
    { src: P('Sawmill'), x: 7.5, y: 0, z: -5.5, rotY: 4.1, fitMaxDim: 4.5, solid: true },
    { src: P('Post'), x: 0, y: 0, z: -7.5, rotY: 0, fitHeight: 2.4, solid: true },
    { src: P('Wood'), x: -5, y: 0, z: -1.5, rotY: 1.1, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: -5.9, y: 0, z: -0.8, rotY: 0.2, fitHeight: 0.9, pickable: true },
    { src: P('Bomb'), x: 4.5, y: 0, z: 1.2, rotY: 0, fitHeight: 0.5, pickable: true },
    {
      src: MEN('Man'), x: -4.5, y: 0, z: -4, rotY: 2.2, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: [
          'Camp is safe. The treeline is not.',
          'Something has been taking the crates at night.',
        ],
        guideTo: [7.5, -4], arriveLine: 'This is the mill. Whatever it is, it started here.',
      },
    },
    {
      src: M('Orc'), x: 8, y: 0, z: 5.5, rotY: 3.1, fitHeight: 1.8, clip: 'Idle',
      speed: 1.4, path: [[8, 5.5], [3, 7], [-2, 6], [3, 7]],
      npc: {
        faction: 'hostile', behavior: 'patrol', health: 40, damage: 9,
        speed: 1.8, aggroRadius: 8, loot: '/models/quaternius-pirate/Gold Bag.glb',
      },
    },
    {
      src: M('Mushnub'), x: -8.5, y: 0, z: 5, rotY: 1.4, fitHeight: 1.2, clip: 'Idle',
      speed: 1.1,
      npc: { faction: 'neutral', behavior: 'wander', health: 20, speed: 1.1 },
    },
    ...scatter(
      [
        { src: N('Tree'), height: [3.5, 5.5], solid: true },
        { src: N('Pine'), height: [3, 5], solid: true },
        { src: N('Twisted Tree'), height: [3, 4.5], solid: true },
      ],
      14, rand, taken
    ),
    ...scatter(
      [
        { src: N('Fern'), height: [0.5, 0.9] },
        { src: N('Plant Big'), height: [0.5, 0.8] },
        { src: N('Tall Grass'), height: [0.4, 0.7] },
        { src: N('Mushroom'), height: [0.25, 0.5] },
        { src: N('Bush with Flowers'), height: [0.5, 0.9] },
      ],
      34, rand, taken
    ),
  ];
}

function fishingVillage(): LevelEntry[] {
  const rand = rng(24601);
  const taken = [...spawnClear(), { x: -6, z: -4, r: 3 }, { x: 6, z: -4, r: 3 },
    { x: 0, z: -9, r: 3.5 }, { x: 8, z: -8.5, r: 3 }, { x: -9.5, z: -10, r: 4 }];
  // A reef you can watch from the dock. Fish are non-solid and swim a loop.
  const REEF = ['Clownfish', 'Blue Tang', 'Butterfly Fish', 'Cardinal Fish', 'Cowfish', 'Coral Grouper'];
  const fish: LevelEntry[] = REEF.map((name, i) => {
    const x = +(-9 + i * 3.6).toFixed(2);
    const z = +(11 + rand() * 3).toFixed(2);
    return {
      src: `/models/animated-fish-bundle/${name}.glb`,
      x, y: 0.4, z, rotY: +(rand() * Math.PI * 2).toFixed(3), fitHeight: 0.5, solid: false,
      clip: 'Swimming_Normal', speed: 1.2,
      path: [[x, z], [x + 3, z + 1.5], [x, z + 3], [x - 3, z + 1.5]] as [number, number][],
    };
  });
  return [
    ...paintBlob('sand', 0, -2, 10, rand),
    ...paintRect('water', -12, 8, 12, 16),
    ...paintRect('road', -8, -6, 8, -6),
    { src: P('Dock'), x: 0, y: -3.4, z: -10, rotY: 10.9956, scale: 1.494, solid: true },
    { src: P('Dock Broken'), x: 8, y: -3.4, z: -9.5, rotY: 10.9956, scale: 1.2, solid: true },
    { src: P('House'), x: -6, y: 0, z: -4, rotY: 0.2, fitHeight: 4.2, solid: true },
    { src: P('House'), x: 6, y: 0, z: -4, rotY: 3.3, fitHeight: 3.8, solid: true },
    { src: P('Small Ship'), x: -9.5, y: -0.6, z: -11, rotY: 1.9, fitMaxDim: 5.5, solid: true },
    { src: P('Bucket of Fish'), x: -1.4, y: 0, z: -6.2, rotY: 0.5, fitHeight: 0.5, pickable: true },
    { src: P('Bucket'), x: 1.6, y: 0, z: -6.4, rotY: 2.5, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: 2.6, y: 0, z: -5.6, rotY: 1.2, fitHeight: 0.9, pickable: true },
    { src: P('Anchor'), x: -3.2, y: 0, z: -7.5, rotY: 0.8, fitMaxDim: 1.3, solid: false },
    {
      src: W('Woman Casual'), x: -2.5, y: 0, z: -3, rotY: 0.6, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: ['Morning. Catch is thin this week.', 'Try the far reef, past the broken dock.'],
        guideTo: [8, -8], arriveLine: 'Here. Careful, the boards give.',
      },
    },
    {
      src: MEN('Man'), x: 3, y: 0, z: -2.4, rotY: 4.1, fitHeight: 1.75, clip: 'Idle',
      speed: 1.3, path: [[3, -2.4], [3, -6], [-3, -6], [-3, -2.4]],
      npc: { faction: 'friendly', behavior: 'patrol', speed: 1.3, lines: ['Nets first, questions later.'], canFollow: true },
    },
    {
      src: M('Glub'), x: 9, y: 0, z: 4, rotY: 2.2, fitHeight: 1.3, clip: 'Idle',
      npc: { faction: 'neutral', behavior: 'wander', health: 24, speed: 1.2, loot: 'Gem Blue' },
    },
    ...fish,
    ...scatter(
      [
        { src: P('Palm Tree'), height: [4, 6], solid: true },
        { src: N('Grass Wispy'), height: [0.3, 0.6] },
        { src: N('Pebble Square'), height: [0.15, 0.3] },
        { src: N('Rock Medium'), height: [0.5, 1.1] },
      ],
      20, rand, taken
    ),
  ];
}

function monsterArena(): LevelEntry[] {
  const rand = rng(555);
  const ring: LevelEntry[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ring.push({
      src: P('Rocks'), x: +(Math.cos(a) * 11).toFixed(2), y: 0,
      z: +(Math.sin(a) * 7.5).toFixed(2), rotY: a, fitHeight: 2.2 + rand() * 1.2,
      solid: true, trimTop: 0.15,
    });
  }
  // Goleling is 4.9 wide and 1.7 tall — a winged sprawl. Sized by height it
  // becomes a five-metre creature, so wide models get fitMaxDim (see above).
  const foes: LevelEntry[] = [
    { name: 'Orc', hp: 40, dmg: 9, loot: 'Coins', size: 1.9 },
    { name: 'Blue Demon', hp: 55, dmg: 12, loot: 'Gem Blue', size: 1.8 },
    { name: 'Yeti', hp: 70, dmg: 14, loot: 'Gold Bag', size: 2 },
    { name: 'Goleling', hp: 30, dmg: 7, loot: 'Gold ore', size: 2.2, wide: true },
  ].map((f, i) => {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    return {
      src: M(f.name), x: +(Math.cos(a) * 7).toFixed(2), y: 0,
      z: +(Math.sin(a) * 5).toFixed(2), rotY: a + Math.PI, clip: 'Idle',
      ...(f.wide ? { fitMaxDim: f.size } : { fitHeight: f.size }),
      npc: {
        faction: 'hostile' as const, behavior: 'guard' as const,
        health: f.hp, damage: f.dmg, speed: 2, aggroRadius: 9, loot: f.loot,
      },
    };
  });
  // Ammunition, within reach of the spawn — the arena is the tutorial for F.
  const ammo: LevelEntry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ammo.push({
      src: P(i % 2 ? 'Barrel' : 'Bomb'), x: +(Math.cos(a) * 2.2).toFixed(2), y: 0,
      z: +(Math.sin(a) * 2.2).toFixed(2), rotY: a, fitHeight: i % 2 ? 0.9 : 0.5,
      pickable: true,
    });
  }
  return [
    ...paintBlob('rock', 0, 0, 10, rand),
    ...paintBlob('sand', 0, 0, 4, rand),
    ...ring, ...foes, ...ammo,
  ];
}

function blankSands(): LevelEntry[] {
  const rand = rng(7);
  return paintBlob('sand', 0, 0, 12, rand);
}

export type Starter = {
  id: string;
  name: string;
  blurb: string;
  build: () => LevelEntry[];
};

export const STARTERS: Starter[] = [
  {
    id: 'pirate-cove',
    name: 'Pirate cove',
    blurb: 'Beach, dock and a wreck. A captain with work to offer.',
    build: pirateCove,
  },
  {
    id: 'jungle-outpost',
    name: 'Jungle outpost',
    blurb: 'Dense treeline, a camp, and something patrolling it.',
    build: jungleOutpost,
  },
  {
    id: 'fishing-village',
    name: 'Fishing village',
    blurb: 'Two huts, two docks, a reef. Friendly, with an escort to follow.',
    build: fishingVillage,
  },
  {
    id: 'monster-arena',
    name: 'Monster arena',
    blurb: 'A rock ring, four enemies, and crates to throw at them.',
    build: monsterArena,
  },
  {
    id: 'blank-sands',
    name: 'Blank sands',
    blurb: 'Bare sand. Nothing placed — start from scratch.',
    build: blankSands,
  },
];
