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
const V = (n: string) => `/models/medieval-village/${n}.glb`;

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

/** The playable ground, in world units — everything is placed inside this. */
const BOUNDS = { x: 12.5, z: 8.5 };
/** Widen scatter/paint bounds when a starter builds a bigger island. */
function useBounds(x: number, z: number) {
  BOUNDS.x = x - 0.5;
  BOUNDS.z = z - 0.5;
}

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
      // Stay on the slab: a tile past the island edge floats over open sea.
      if (Math.abs(px) > BOUNDS.x + 0.5 || Math.abs(pz) > BOUNDS.z + 0.5) continue;
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

/** The draggable green flag marking where the player starts and respawns. */
const spawnFlag = (x = 0, z = 0): LevelEntry => ({ src: 'spawn', x, y: 0, z, rotY: 0 });

function pirateCove(): LevelEntry[] {
  const rand = rng(1337);
  // Structures claim their ground first, or scatter grows a palm through the dock.
  const taken = [...spawnClear(), { x: 1.5, z: -9, r: 3.5 }, { x: -7.5, z: -11, r: 5 },
    { x: 9, z: -5.5, r: 3 }, { x: 8, z: 3, r: 5 }, { x: -8, z: 4, r: 4 }];
  // The island's reason to exist: a rock climb up to the treasure the captain
  // asks about. Heights step by ~0.7 — proven jumpable in the original course.
  const climb: LevelEntry[] = [
    { src: P('Rock'), x: 4.5, y: 0, z: 2, rotY: 0.4, fitHeight: 1.3, solid: true, trimTop: 0.15 },
    { src: P('Rock-4vHWF8XUBn'), x: 6.5, y: 0, z: 3.6, rotY: 2.1, fitHeight: 2.0, solid: true, trimTop: 0.15 },
    { src: P('Rocks-38eDa0gjwZ'), x: 8.6, y: 0, z: 5, rotY: 5.0, fitHeight: 2.7, solid: true, trimTop: 0.15 },
    { src: P('Rocks'), x: 10.5, y: 0, z: 6.8, rotY: 0.9, fitHeight: 3.4, solid: true, trimTop: 0.2 },
    // The prize on the summit; y is tuned to the trimmed rock top.
    { src: P('Chest Gold'), x: 10.5, y: 2.7, z: 6.8, rotY: 2.2, fitHeight: 0.8, solid: false, pickable: true },
    { src: P('Gem Pink'), x: 8.6, y: 2.15, z: 5, rotY: 1, fitHeight: 0.35, solid: false, pickable: true },
  ];
  return [
    spawnFlag(0, -1),
    ...paintBlob('sand', 0, 0, 11, rand),
    { src: P('Dock'), x: 1.5, y: -3.4, z: -10, rotY: 10.9956, scale: 1.494, solid: true },
    // The ship is the way off the island — stand by it and press E.
    { src: P('Ship'), x: -7.5, y: -1.2, z: -12.5, rotY: 0.5, fitHeight: 9, solid: true,
      exitTo: 'town-island', exitLabel: 'Sail back to Ketch Harbour' },
    ...climb,
    // "Bones" guards the climb — the captain's job has a catch. (The pirate
    // kit's own Skeleton binds lying in a heap, axe on the ground; fitting it
    // by height inflates the pile. The monsters pack rigs its dead standing.)
    {
      src: M('Ghost Skull'), x: 4.2, y: 0, z: 0.2, rotY: 3.5, fitHeight: 1.7, clip: 'Idle',
      npc: { faction: 'hostile', behavior: 'guard', health: 35, damage: 9, aggroRadius: 6, loot: 'Coins' },
    },
    // Palm grove west, with shade clutter.
    { src: P('Palm Tree'), x: -6, y: 0, z: -2, rotY: 1.2, fitHeight: 5.5, solid: true, colliderXZ: 0.5 },
    { src: P('Palm Tree'), x: -8.2, y: 0, z: 0.5, rotY: 3.4, fitHeight: 4.6, solid: true, colliderXZ: 0.5 },
    { src: P('Palm Tree'), x: -4.6, y: 0, z: 1.4, rotY: 5.1, fitHeight: 5, solid: true, colliderXZ: 0.5 },
    { src: P('Rocks'), x: -8, y: 0, z: 4, rotY: 0.3, fitHeight: 2.6, solid: true, trimTop: 0.15 },
    // The camp: house, cannon aimed at the sea, powder and provisions.
    { src: P('House'), x: 9, y: 0, z: -5.5, rotY: 3.6, fitHeight: 4.2, solid: true },
    { src: P('Cannon'), x: 6.3, y: 0, z: -7.2, rotY: 2.9, fitHeight: 1.3, solid: true },
    { src: P('Bomb'), x: 5.4, y: 0, z: -6.4, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Bomb'), x: 5.9, y: 0, z: -5.8, rotY: 1, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: 2.2, y: 0, z: -2.4, rotY: 0.6, fitHeight: 0.9, pickable: true },
    { src: P('Barrel'), x: 3.1, y: 0, z: -1.6, rotY: 2.2, fitHeight: 0.9, pickable: true },
    { src: P('Bucket of Fish'), x: 2.7, y: 0, z: -3.3, rotY: 4, fitHeight: 0.5, pickable: true },
    { src: P('Wood'), x: 7.6, y: 0, z: -3.8, rotY: 1.4, fitHeight: 0.5, pickable: true },
    {
      src: P('Pirate Captain'), x: -2, y: 0, z: -3.5, rotY: 0.4, fitHeight: 1.7,
      clip: 'Idle', solid: false,
      npc: {
        faction: 'friendly', behavior: 'idle', speed: 1.6,
        lines: [
          'Ahoy! You look like someone who needs work.',
          'There is a chest atop the east rocks. Bones guards the path.',
          'Bring it to ME, mind — and the reward is yours.',
        ],
        canFollow: true,
        // The island's loop: climb past Bones, scoop the chest, deliver it.
        wantsItem: 'Chest Gold',
        thanksLine: 'HA! The chest itself! A bag of gold, as promised — the ship sails where you point it.',
        reward: 'Gold Bag',
      },
    },
    // Anne works the beach on a loop; the place breathes even if you idle.
    {
      src: P('Anne'), x: -3, y: 0, z: 2, rotY: 0, fitHeight: 1.65, clip: 'Walk',
      speed: 1.1, path: [[-3, 2], [1, 4], [-1, 6], [-6, 5]],
      npc: { faction: 'friendly', behavior: 'patrol', speed: 1.1,
        lines: ['The captain talks big. The skeleton is real though.'] },
    },
    { src: P('Bird'), x: 1, y: 0, z: -8.4, rotY: 2, fitHeight: 0.35, clip: 'Idle', solid: false },
    ...scatter(
      // Beach dressing only: the nature kit's Bush is autumn red, which reads
      // as a shrub that wandered in from another biome.
      [
        { src: N('Grass Wispy'), height: [0.3, 0.55] },
        { src: N('Grass'), height: [0.3, 0.5] },
        { src: N('Pebble Round'), height: [0.15, 0.3] },
        { src: N('Pebble Square'), height: [0.15, 0.3] },
        { src: N('Clover'), height: [0.15, 0.3] },
      ],
      40, rand, taken
    ),
  ];
}

function jungleOutpost(): LevelEntry[] {
  const rand = rng(90210);
  const taken = [...spawnClear(), { x: -7, z: -5, r: 3.5 }, { x: 7.5, z: -5.5, r: 3 },
    // Keep the road itself clear of trees.
    ...Array.from({ length: 8 }, (_, i) => ({ x: 0, z: -8 + i * 2, r: 1.8 })),
    { x: 9.5, z: 6.5, r: 3 },
    // Reserve the loose props. Undergrowth is placed last and will happily
    // grow a fern straight over a bomb, which is how the bomb "disappeared".
    { x: -5, z: -1.5, r: 1.6 }, { x: -4.4, z: -2.2, r: 1.6 },
    { x: -5.9, z: -0.8, r: 1.6 }, { x: -5.2, z: -3, r: 1.6 },
    { x: 4.5, z: 1.2, r: 2 },
    { x: 9.5, z: 6.5, r: 2 }, { x: 10.3, z: 5.8, r: 2 }, { x: 8.8, z: 7.2, r: 2 }];
  return [
    spawnFlag(0, -7),
    ...paintBlob('jungle', 0, -1, 12, rand),
    ...paintBlob('grass', 2, 3, 6, rand),
    ...paintRect('road', -1, -8, 1, 6),
    // Gateposts pace the road; passing the second one means you left safety.
    { src: P('Post'), x: -1.4, y: 0, z: -7.5, rotY: 0, fitHeight: 2.4, solid: true },
    { src: P('Small Ship'), x: 4, y: -0.6, z: -11, rotY: 3.1, fitMaxDim: 5, solid: true,
      exitTo: 'town-island', exitLabel: 'Sail back to Ketch Harbour' },
    { src: P('Post'), x: 1.4, y: 0, z: -7.5, rotY: 0, fitHeight: 2.4, solid: true },
    { src: P('Post'), x: -1.4, y: 0, z: -1, rotY: 0.2, fitHeight: 2.2, solid: true },
    { src: P('Post'), x: 1.4, y: 0, z: -1, rotY: 6, fitHeight: 2.2, solid: true },
    // The camp is a composed cluster, not sprinkles: house, woodpile, stores.
    { src: P('House'), x: -7, y: 0, z: -5, rotY: 0.7, fitHeight: 4.4, solid: true },
    { src: P('Sawmill'), x: 7.5, y: 0, z: -5.5, rotY: 4.1, fitMaxDim: 4.5, solid: true },
    { src: P('Wood'), x: -5, y: 0, z: -1.5, rotY: 1.1, fitHeight: 0.5, pickable: true },
    { src: P('Wood'), x: -4.4, y: 0, z: -2.2, rotY: 2.6, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: -5.9, y: 0, z: -0.8, rotY: 0.2, fitHeight: 0.9, pickable: true },
    { src: P('Bucket'), x: -5.2, y: 0, z: -3, rotY: 1, fitHeight: 0.5, pickable: true },
    { src: P('Bomb'), x: 4.5, y: 0, z: 1.2, rotY: 0, fitHeight: 0.5, pickable: true },
    // The cache: gems in the far clearing, and the thing that owns them.
    { src: P('Gem Green'), x: 9.5, y: 0, z: 6.5, rotY: 0.4, fitHeight: 0.4, pickable: true },
    { src: P('Gem Blue'), x: 10.3, y: 0, z: 5.8, rotY: 2, fitHeight: 0.4, pickable: true },
    { src: P('Gem Pink'), x: 8.8, y: 0, z: 7.2, rotY: 4, fitHeight: 0.4, pickable: true },
    { src: P('Large Bone'), x: 9.9, y: 0, z: 7.4, rotY: 1.2, fitHeight: 0.4, solid: false },
    {
      src: M('Yeti'), x: 9.8, y: 0, z: 5, rotY: 3.6, fitHeight: 2.1, clip: 'Idle',
      npc: { faction: 'hostile', behavior: 'guard', health: 80, damage: 14,
        speed: 2.2, aggroRadius: 6, attackRadius: 1.9, loot: 'Chest Gold' },
    },
    {
      src: MEN('Man'), x: -4.5, y: 0, z: -4, rotY: 2.2, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: [
          'Camp is safe. The treeline is not.',
          'Gems in the east clearing — and the thing that collects them.',
          'Take bombs. Do not be brave with your hands.',
        ],
        guideTo: [7.5, 4], arriveLine: 'Hear that breathing? Good luck.',
      },
    },
    // Two patrols whose loops CROSS the road at different points, so walking
    // it means timing them rather than fighting everything at once.
    {
      src: M('Orc'), x: 8, y: 0, z: 5.5, rotY: 3.1, fitHeight: 1.8, clip: 'Walk',
      speed: 1.4, path: [[8, 3], [3, 4.5], [-3, 3.5], [3, 4.5]],
      npc: { faction: 'hostile', behavior: 'patrol', health: 40, damage: 9,
        speed: 1.8, aggroRadius: 5, loot: 'Gold Bag' },
    },
    {
      src: M('Orc Enemy'), x: -6, y: 0, z: 2, rotY: 1, fitHeight: 1.8, clip: 'Walk',
      speed: 1.2, path: [[-6, 2], [-2, 0.5], [3, -0.5], [-2, 0.5]],
      npc: { faction: 'hostile', behavior: 'patrol', health: 40, damage: 9,
        speed: 1.8, aggroRadius: 5, loot: 'Coins' },
    },
    {
      src: M('Mushnub'), x: -8.5, y: 0, z: 5, rotY: 1.4, fitHeight: 1.2, clip: 'Idle',
      speed: 1.1,
      npc: { faction: 'neutral', behavior: 'wander', health: 20, speed: 1.1, loot: 'Gem Green' },
    },
    { src: M('Monkroose'), x: 5, y: 0, z: -3, rotY: 2.5, fitHeight: 1.3, clip: 'Idle',
      npc: { faction: 'neutral', behavior: 'wander', health: 18, speed: 1.4 } },
    // A dense treeline is what makes it a jungle and not a lawn.
    ...scatter(
      [
        { src: N('Tree'), height: [3.5, 5.5], solid: true },
        { src: N('Pine'), height: [3, 5], solid: true },
        { src: N('Twisted Tree'), height: [3, 4.5], solid: true },
        { src: N('Dead Tree'), height: [2.5, 3.5], solid: true },
      ],
      26, rand, taken
    ),
    ...scatter(
      [
        { src: N('Fern'), height: [0.5, 0.9] },
        { src: N('Plant Big'), height: [0.5, 0.8] },
        { src: N('Tall Grass'), height: [0.4, 0.7] },
        { src: N('Mushroom'), height: [0.25, 0.5] },
        { src: N('Mushroom Laetiporus'), height: [0.3, 0.5] },
        { src: N('Bush with Flowers'), height: [0.5, 0.9] },
        { src: N('Flower Group'), height: [0.3, 0.5] },
      ],
      55, rand, taken
    ),
  ];
}

function fishingVillage(): LevelEntry[] {
  const rand = rng(24601);
  const taken = [...spawnClear(), { x: -6, z: -4, r: 3 }, { x: 6, z: -4, r: 3 },
    { x: 0.5, z: 2.6, r: 3 },
    { x: 0, z: -9, r: 3.5 }, { x: 8, z: -8.5, r: 3 }, { x: -9.5, z: -10, r: 4 }];
  // A reef you can watch from the dock. Fish are non-solid and swim a loop.
  const REEF = ['Clownfish', 'Blue Tang', 'Butterfly Fish', 'Cardinal Fish', 'Cowfish', 'Coral Grouper'];
  const fish: LevelEntry[] = REEF.map((name, i) => {
    const x = +(-9 + i * 3.6).toFixed(2);
    const z = +(11 + rand() * 3).toFixed(2);
    return {
      src: `/models/animated-fish-bundle/${name}.glb`,
      // Mostly afloat: waterline is -0.3, so a 0.5-tall fish based at -0.45
      // shows its back and fin above the surface.
      x, y: -0.45, z, rotY: +(rand() * Math.PI * 2).toFixed(3), fitHeight: 0.5, solid: false,
      clip: 'Swimming_Normal', speed: 1.2,
      path: [[x, z], [x + 3, z + 1.5], [x, z + 3], [x - 3, z + 1.5]] as [number, number][],
    };
  });
  // A market stall is a barrel with produce ON it plus a bucket beside it —
  // composition sells the place; the same props scattered read as litter.
  const stall = (x: number, z: number, produce: string): LevelEntry[] => [
    { src: P('Barrel'), x, y: 0, z, rotY: rand() * 6, fitHeight: 0.9, solid: true },
    { src: P(produce), x, y: 0.9, z, rotY: rand() * 6, fitHeight: 0.4, pickable: true },
    { src: P('Bucket'), x: x + 0.8, y: 0, z: z + 0.3, rotY: rand() * 6, fitHeight: 0.5, pickable: true },
  ];
  return [
    spawnFlag(0, -1),
    ...paintBlob('sand', 0, -2, 10, rand),
    ...paintRect('road', -8, -6, 8, -6),
    { src: P('Dock'), x: 0, y: -3.4, z: -10, rotY: 10.9956, scale: 1.494, solid: true },
    { src: P('Dock Broken'), x: 8, y: -3.4, z: -9.5, rotY: 10.9956, scale: 1.2, solid: true },
    // Three houses facing the waterfront road, not two lost in space.
    { src: P('House'), x: -6, y: 0, z: -4, rotY: 0.2, fitHeight: 4.2, solid: true },
    { src: P('House'), x: 6, y: 0, z: -4, rotY: 3.3, fitHeight: 3.8, solid: true },
    // Behind the spawn, so starting the level reads as stepping out your door.
    { src: P('House'), x: 0.5, y: 0, z: 2.6, rotY: 3.2, fitHeight: 3.6, solid: true },
    // The way back: island hopping is a loop, not a one-way trip.
    { src: P('Small Ship'), x: -9.5, y: -0.6, z: -11, rotY: 1.9, fitMaxDim: 5.5, solid: true,
      exitTo: 'town-island', exitLabel: 'Sail back to Ketch Harbour' },
    // The fish market along the road.
    ...stall(-2.2, -6.2, 'Fish Tuna'),
    ...stall(2.4, -6.3, 'Fish Mackerel'),
    { src: P('Bucket of Fish'), x: 0.2, y: 0, z: -6.6, rotY: 0.5, fitHeight: 0.5, pickable: true },
    { src: P('Anchor'), x: -3.2, y: 0, z: -7.5, rotY: 0.8, fitMaxDim: 1.3, solid: false },
    { src: P('Lute'), x: 4.2, y: 0, z: -5.7, rotY: 2, fitHeight: 0.7, pickable: true },
    // Offshore drama: a shark works the bay, a tentacle marks the deep end.
    {
      src: P('Shark'), x: -4, y: -0.65, z: 12, rotY: 1, fitHeight: 0.9, solid: false, clip: 'Idle',
      speed: 2.2, path: [[-4, 12], [4, 13.5], [9, 11.5], [0, 10.5]],
    },
    { src: P('Tentacle'), x: 11, y: -0.6, z: 14.5, rotY: 0.7, fitHeight: 3.2, solid: false, clip: 'Idle' },
    {
      src: W('Woman Casual'), x: -2.5, y: 0, z: -3.5, rotY: 0.6, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: ['Morning. Catch is thin this week.',
          'See the fin out there? That is why.',
          'Try the far reef, past the broken dock.'],
        guideTo: [8, -8], arriveLine: 'Here. Careful, the boards give.',
      },
    },
    {
      src: MEN('Man'), x: 3, y: 0, z: -3, rotY: 4.1, fitHeight: 1.75, clip: 'Walk',
      speed: 1.3, path: [[3, -3], [3, -6], [-3, -6], [-3, -3]],
      npc: { faction: 'friendly', behavior: 'patrol', speed: 1.3,
        lines: ['Nets first, questions later.'], canFollow: true },
    },
    {
      src: P('Henry'), x: 0.8, y: 0, z: -5.4, rotY: 3.2, fitHeight: 1.65, clip: 'Idle',
      npc: { faction: 'friendly', behavior: 'idle',
        lines: ['Fresh tuna! Mackerel! Mind the shark got the rest.',
          'The lute? Not for sale. Unless you are taking it.'] },
    },
    {
      src: M('Glub'), x: 9, y: 0, z: 4, rotY: 2.2, fitHeight: 1.3, clip: 'Idle',
      npc: { faction: 'neutral', behavior: 'wander', health: 24, speed: 1.2, loot: 'Gem Blue' },
    },
    { src: P('Bird'), x: -0.5, y: 0, z: -9.6, rotY: 3, fitHeight: 0.35, clip: 'Idle', solid: false },
    ...fish,
    ...scatter(
      [
        { src: P('Palm Tree'), height: [4, 6], solid: true },
        { src: N('Grass Wispy'), height: [0.3, 0.6] },
        { src: N('Grass'), height: [0.3, 0.5] },
        { src: N('Pebble Square'), height: [0.15, 0.3] },
        { src: N('Rock Medium'), height: [0.5, 1.1] },
        { src: N('Flower Single'), height: [0.25, 0.4] },
      ],
      34, rand, taken
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
    { name: 'Orc', hp: 35, dmg: 9, loot: 'Coins', size: 1.9 },
    { name: 'Blue Demon', hp: 50, dmg: 12, loot: 'Gem Blue', size: 1.8 },
    { name: 'Goleling', hp: 30, dmg: 7, loot: 'Gold ore', size: 2.2, wide: true },
  ].map((f, i) => {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    return {
      src: M(f.name), x: +(Math.cos(a) * 7).toFixed(2), y: 0,
      z: +(Math.sin(a) * 5).toFixed(2), rotY: a + Math.PI, clip: 'Idle',
      ...(f.wide ? { fitMaxDim: f.size } : { fitHeight: f.size }),
      npc: {
        // Short leashes: with the player spawning mid-ring, a 9-unit aggro
        // means the whole arena converges before the first input. Guards with
        // 4-unit tempers make it a gauntlet you pace yourself.
        faction: 'hostile' as const, behavior: 'guard' as const,
        health: f.hp, damage: f.dmg, speed: 2, aggroRadius: 4, loot: f.loot,
      },
    };
  });
  // The boss holds the middle; the vantage rocks let you fight from above —
  // combat is height-gated, so climbing IS the tactic the arena teaches.
  const centre: LevelEntry[] = [
    // North of spawn, so it's the first thing you see.
    {
      src: M('Dragon Evolved'), x: 0, y: 0, z: -4.5, rotY: 0, fitHeight: 2.6, clip: 'Idle',
      npc: { faction: 'hostile', behavior: 'guard', health: 120, damage: 16,
        speed: 2.4, aggroRadius: 5, attackRadius: 2, loot: 'Chest Gold' },
    },
    { src: P('Rock'), x: -4.5, y: 0, z: -1.5, rotY: 1.2, fitHeight: 1.3, solid: true, trimTop: 0.15 },
    { src: P('Rock-4vHWF8XUBn'), x: -5.8, y: 0, z: -3.2, rotY: 3.8, fitHeight: 2.0, solid: true, trimTop: 0.15 },
    { src: P('Rocks-38eDa0gjwZ'), x: -4.6, y: 0, z: -5.2, rotY: 0.6, fitHeight: 2.7, solid: true, trimTop: 0.15 },
    { src: P('Gem Pink'), x: -4.6, y: 2.15, z: -5.2, rotY: 2, fitHeight: 0.35, pickable: true },
    { src: P('Skull'), x: 2.5, y: 0, z: -1.8, rotY: 0.8, fitHeight: 0.45, solid: false },
    { src: P('Large Bone'), x: -1.8, y: 0, z: -2.6, rotY: 2.4, fitHeight: 0.4, solid: false },
    { src: P('Skull'), x: 1, y: 0, z: -6.8, rotY: 4, fitHeight: 0.45, solid: false },
  ];
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
    spawnFlag(),
    ...paintBlob('rock', 0, 0, 10, rand),
    ...paintBlob('sand', 0, 0, 4, rand),
    ...ring, ...foes, ...centre, ...ammo,
    { src: P('Red X'), x: 0, y: 0, z: 8, rotY: 0, fitMaxDim: 1.6, solid: false,
      exitTo: 'town-island', exitLabel: 'Step out to Ketch Harbour' },
  ];
}

function blankSands(): LevelEntry[] {
  const rand = rng(7);
  return [spawnFlag(), ...paintBlob('sand', 0, 0, 12, rand)];
}

/**
 * The hub. Everything else in the game is reachable or askable from here:
 * a board that posts what the townsfolk want, the people who want it, a
 * market, and berths for every island. Quests are not authored on the board —
 * it reads them off the NPCs, so posting a job is just giving someone a
 * wantsItem.
 */
function townIsland(): LevelEntry[] {
  const rand = rng(4242);
  useBounds(20, 14);
  // A town is a CLEARING. Scatter that wanders into the square puts a pine
  // through the middle of the market, so the whole plaza and both roads are
  // claimed before a single tree is placed.
  const taken = [
    ...spawnClear(),
    ...Array.from({ length: 8 }, (_, i) => ({ x: 0, z: -9 + i * 1.8, r: 3.2 })), // north road
    ...Array.from({ length: 7 }, (_, i) => ({ x: -8 + i * 2.7, z: -3, r: 2.8 })), // market row
    { x: -7, z: -4, r: 4 }, { x: 7, z: -4, r: 4 }, { x: 0, z: -7, r: 4 },
    { x: -9.5, z: 3, r: 3.5 }, { x: 9, z: 2.4, r: 3 }, { x: 6.5, z: 5, r: 3 },
    { x: 0, z: -9.5, r: 4.5 },   // the quay
    { x: 0, z: 2.6, r: 2.5 },    // the campfire
  ];
  const stall = (x: number, z: number, goods: string): LevelEntry[] => [
    { src: V('Market Stand'), x, y: 0, z, rotY: 3.14, fitMaxDim: 3, solid: true },
    { src: P(goods), x, y: 1.0, z: z + 0.3, rotY: rand() * 6, fitHeight: 0.4, pickable: true },
    { src: V('Crate'), x: x + 1.1, y: 0, z: z + 0.6, rotY: rand() * 6, fitMaxDim: 0.8, solid: true },
  ];
  return [
    spawnFlag(0, 1),
    ...paintRect('road', -1, -9, 1, 4),
    ...paintRect('road', -8, -3, 8, -3),

    // The board sits in the middle of the square, facing the spawn.
    {
      src: P('Post'), x: 0, y: 0, z: -1.5, rotY: 0, fitHeight: 2.4,
      solid: true, questBoard: true,
    },
    { src: P('Paper'), x: 0.42, y: 1.5, z: -1.5, rotY: 0, fitHeight: 0.5, solid: false },

    // A town made of buildings people live in, not beached pirate hulls.
    { src: V('Fantasy Inn'), x: -9, y: 0, z: -5, rotY: 0.3, fitHeight: 8.5, solid: true },
    { src: V('Fantasy House-BH2XHWUNmF'), x: 8.5, y: 0, z: -5, rotY: -0.35, fitHeight: 6.5, solid: true },
    { src: V('Fantasy House-dcPho4SUA3'), x: -14, y: 0, z: 1, rotY: 1.3, fitHeight: 6.5, solid: true },
    { src: V('Fantasy Barracks'), x: 14, y: 0, z: 1.5, rotY: -1.3, fitHeight: 7, solid: true },
    { src: V('Blacksmith'), x: 13, y: 0, z: -6.5, rotY: -0.8, fitHeight: 6, solid: true },
    { src: V('Fantasy Stable'), x: -14.5, y: 0, z: -6, rotY: 0.9, fitHeight: 5.5, solid: true },
    { src: V('Mill'), x: 0, y: 0, z: 9.5, rotY: 3.14, fitHeight: 12, solid: true },
    { src: V('Bell Tower'), x: 0, y: 0, z: -9, rotY: 0, fitHeight: 12, solid: true },
    { src: V('Well'), x: -3.5, y: 0, z: 2.5, rotY: 0.4, fitHeight: 2.2, solid: true },
    { src: V('Bonfire'), x: 3.5, y: 0, z: 2.5, rotY: 0, fitMaxDim: 1.6 },
    { src: V('Cart'), x: -6.5, y: 0, z: 4.5, rotY: 1.1, fitMaxDim: 2.6, solid: true },
    { src: V('Hay'), x: -11.5, y: 0, z: -2, rotY: 0.5, fitMaxDim: 1.8, solid: true },
    { src: V('Gazebo'), x: 9.5, y: 0, z: 5.5, rotY: 0.6, fitMaxDim: 4, solid: true },

    // The market: three stalls along the road.
    ...stall(-3.4, -3.2, 'Fish Tuna'),
    ...stall(-1.2, -3.2, 'Bucket of Fish'),
    ...stall(3.2, -3.2, 'Chicken Leg'),
    { src: P('Bucket'), x: -2.3, y: 0, z: -2.4, rotY: 1, fitHeight: 0.5, pickable: true },
    { src: P('Wood'), x: 4.4, y: 0, z: -2.6, rotY: 2, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: 5.2, y: 0, z: -3.4, rotY: 0.4, fitHeight: 0.9, pickable: true },

    // ---- the people, and what they want -------------------------------
    {
      src: P('Pirate Captain'), x: -2.2, y: 0, z: -0.8, rotY: 0.5, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: ['This is Ketch Harbour. Everything starts here.',
          'Read the board — folk post what they need.',
          'The ships at the quay will take you anywhere you like.'],
        wantsItem: 'Chest Gold', reward: 'Gold Bag',
        thanksLine: 'The chest! I knew you had it in you. Take this.',
        canFollow: true,
      },
    },
    {
      src: W('Woman Casual'), x: 2.4, y: 0, z: -1, rotY: -0.6, fitHeight: 1.7, clip: 'Idle',
      npc: {
        faction: 'friendly', behavior: 'idle',
        lines: ['The reef past the fishing village is thick with gems.',
          'Bring me a blue one and the bakery is yours for a day.'],
        wantsItem: 'Gem Blue', reward: 'Coins',
        thanksLine: 'Blue as deep water. Here, coin for your trouble.',
      },
    },
    {
      src: MEN('Man'), x: -5.5, y: 0, z: -1.6, rotY: 1.2, fitHeight: 1.75, clip: 'Walk',
      speed: 1.1, path: [[-5.5, -1.6], [-5.5, 3], [2, 3.4], [-2, 0]],
      npc: {
        faction: 'friendly', behavior: 'patrol', speed: 1.1,
        lines: ['Night watch. Nothing gets past me. Mostly.'],
        wantsItem: 'Skull', reward: 'Gem Green',
        thanksLine: 'A skull for the shrine. Take this stone, it is luckier than me.',
      },
    },
    {
      src: P('Henry'), x: 3.2, y: 0, z: -3.9, rotY: 3.2, fitHeight: 1.65, clip: 'Idle',
      npc: { faction: 'friendly', behavior: 'idle',
        lines: ['Fresh catch! Salt pork! Rope, if you are the tying kind.',
          'No credit. Not since the parrot incident.'] },
    },
    {
      src: M('Mushnub'), x: 8, y: 0, z: 5.5, rotY: 1.4, fitHeight: 1.2, clip: 'Idle',
      npc: { faction: 'neutral', behavior: 'wander', health: 20, speed: 1.1, loot: 'Gem Green' },
    },
    { src: P('Bird'), x: -1.4, y: 0, z: 4.2, rotY: 2, fitHeight: 0.35, clip: 'Idle', solid: false },

    // ---- the quay: a berth for every island ---------------------------
    { src: P('Dock'), x: 0, y: -3.4, z: -10, rotY: 10.9956, scale: 1.494, solid: true },
    { src: P('Ship'), x: -7.5, y: -1.2, z: -12.5, rotY: 0.45, fitHeight: 9, solid: true,
      exitTo: 'pirate-cove', exitLabel: 'Sail to the pirate cove' },
    { src: P('Small Ship'), x: 6.5, y: -0.6, z: -11.5, rotY: -0.5, fitMaxDim: 5.5, solid: true,
      exitTo: 'fishing-village', exitLabel: 'Sail to the fishing village' },
    { src: P('Dock Broken'), x: 10, y: -3.4, z: -9, rotY: 10.9956, scale: 1.2, solid: true,
      exitTo: 'jungle-outpost', exitLabel: 'Take the jungle boat' },
    { src: P('Red X'), x: -10.5, y: 0, z: -7.5, rotY: 0.6, fitMaxDim: 1.6, solid: false,
      exitTo: 'monster-arena', exitLabel: 'Step onto the marked stone' },

    ...scatter(
      [
        { src: N('Tree'), height: [3.5, 5], solid: true },
        { src: N('Pine'), height: [3, 4.5], solid: true },
        { src: N('Bush with Flowers'), height: [0.5, 0.9] },
        { src: N('Flower Group'), height: [0.3, 0.5] },
        { src: N('Grass'), height: [0.3, 0.5] },
        { src: N('Pebble Round'), height: [0.15, 0.3] },
      ],
      26, rand, taken
    ),
  ];
}

/**
 * Blackreef — the first island built as a GAME rather than a place.
 *
 * One arc, south to north, with the objective chain carrying it: land on the
 * beach, hear what happened, fight up the road, take the warden's key from the
 * orc holding the pass, climb the reef, kill what sits on top, ring the bell,
 * and the ship comes for you. Every step is a tracked objective, so the island
 * knows when you have finished it.
 *
 * Laid out on a 60x40 island: about fourteen seconds of walking end to end,
 * which is enough for the stages to feel separated rather than stacked.
 */
function blackreef(): LevelEntry[] {
  const rand = rng(90909);
  useBounds(30, 20);
  const taken = [
    { x: 0, z: 17, r: 6 },            // landing beach
    ...Array.from({ length: 14 }, (_, i) => ({ x: 0, z: 16 - i * 2.6, r: 3.4 })), // the road
    { x: 0, z: 2, r: 6 },             // the pass
    { x: 0, z: -12, r: 9 },           // the summit
    { x: -12, z: 8, r: 5 }, { x: 13, z: 6, r: 5 },
  ];
  const orc = (x: number, z: number, hp: number, loot?: string, weapon = 'Axe'): LevelEntry => ({
    src: M('Orc'), x, y: 0, z, rotY: Math.PI, fitHeight: 1.85, clip: 'Idle',
    npc: { faction: 'hostile', behavior: 'guard', health: hp, damage: 8,
      speed: 2, aggroRadius: 7, loot, weapon },
  });

  return [
    spawnFlag(0, 17),
    ...paintRect('road', -1, -14, 1, 16),
    ...paintBlob('sand', 0, 18, 9, rand),
    ...paintBlob('rock', 0, -13, 10, rand),

    // ---- 1. the beach: a survivor tells you what this island is ----
    { src: P('Small Ship'), x: -8, y: -0.6, z: 20.5, rotY: 0.6, fitMaxDim: 6, solid: true },
    { src: P('Dock Broken'), x: 6, y: -3.4, z: 19, rotY: 10.9956, scale: 1.2, solid: true },
    {
      src: W('Woman Casual'), x: 1.8, y: 0, z: 15.5, rotY: 3.3, fitHeight: 1.7, clip: 'Idle',
      objective: { step: 0, kind: 'talk', text: 'Find out what happened here',
        done: 'The bell is at the top of the reef' },
      npc: { faction: 'friendly', behavior: 'idle',
        lines: ['You came. Nobody comes to Blackreef.',
          'Orcs took the pass and the warden with it. He had the key.',
          'Ring the bell on the summit and the mainland will send a ship. Nothing else will.'] },
    },
    { src: V('Cart'), x: -3.5, y: 0, z: 14.5, rotY: 1.4, fitMaxDim: 2.6, solid: true },
    { src: P('Barrel'), x: 3.4, y: 0, z: 13.5, rotY: 0.4, fitHeight: 0.9, pickable: true },
    { src: P('Bomb'), x: 2.6, y: 0, z: 12.8, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Dagger'), x: -2.4, y: 0, z: 12.6, rotY: 1.2, fitHeight: 0.7, pickable: true },

    // ---- 2. the burned village: three orcs among the ruins ----
    { src: V('Fantasy House-BH2XHWUNmF'), x: -9, y: 0, z: 8, rotY: 0.5, fitHeight: 6.5, solid: true },
    { src: V('Fantasy House-dcPho4SUA3'), x: 9.5, y: 0, z: 9.5, rotY: -0.7, fitHeight: 6.5, solid: true },
    { src: V('Fantasy Stable'), x: -13, y: 0, z: 4, rotY: 1.1, fitHeight: 5.5, solid: true },
    { src: V('Bonfire'), x: 5, y: 0, z: 6.5, rotY: 0, fitMaxDim: 1.6 },
    { src: V('Crate'), x: -5.5, y: 0, z: 7, rotY: 0.8, fitMaxDim: 0.9, solid: true },
    { src: P('Bomb'), x: -6.4, y: 0, z: 6.2, rotY: 0, fitHeight: 0.5, pickable: true },
    { ...orc(-6, 9, 26, 'Coins'), objective: { step: 1, kind: 'defeat', text: 'Clear the burned village' } },
    { ...orc(7, 7.5, 26, 'Coins'), objective: { step: 1, kind: 'defeat', text: 'Clear the burned village' } },
    { ...orc(0.5, 5, 30, 'Gold ore'), objective: { step: 1, kind: 'defeat', text: 'Clear the burned village' } },
    // Ammunition where the fighting is. Two bombs for an island was a joke.
    { src: P('Bomb'), x: -7.5, y: 0, z: 10.5, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Bomb'), x: 8, y: 0, z: 6.2, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Barrel'), x: 4, y: 0, z: 9, rotY: 0.7, fitHeight: 0.9, pickable: true },
    { src: P('Barrel'), x: -4, y: 0, z: 6, rotY: 2.2, fitHeight: 0.9, pickable: true },

    // ---- 3. the pass: the warden's key, on the orc that took it ----
    { src: P('Post'), x: -2.2, y: 0, z: 2, rotY: 0, fitHeight: 2.6, solid: true },
    { src: P('Post'), x: 2.2, y: 0, z: 2, rotY: 0, fitHeight: 2.6, solid: true },
    { src: V('Fence'), x: -4.4, y: 0, z: 2, rotY: 0, fitMaxDim: 3, solid: true },
    { src: V('Fence'), x: 4.4, y: 0, z: 2, rotY: 0, fitMaxDim: 3, solid: true },
    {
      ...orc(0, 0.5, 90, 'Chest Gold'),
      npc: { faction: 'hostile', behavior: 'guard', health: 55, damage: 10,
        speed: 2.1, aggroRadius: 8, attackRadius: 1.9, loot: 'Chest Gold',
        weapon: 'Cutlass' },
    },
    {
      src: P('Red X'), x: 0, y: 0, z: 0.5, rotY: 0, fitMaxDim: 1.4, solid: false,
      objective: { step: 2, kind: 'collect', item: 'Chest Gold', count: 1,
        text: "Take the warden's strongbox from the pass",
        done: 'The pass is yours' },
    },

    // ---- 4. the climb: rocks up the reef ----
    { src: P('Rock'), x: -2, y: 0, z: -3, rotY: 0.4, fitHeight: 1.4, solid: true, trimTop: 0.15 },
    { src: P('Rock-4vHWF8XUBn'), x: 1.5, y: 0, z: -5.5, rotY: 2.1, fitHeight: 2.1, solid: true, trimTop: 0.15 },
    { src: P('Rocks-38eDa0gjwZ'), x: -1.5, y: 0, z: -8, rotY: 5, fitHeight: 2.8, solid: true, trimTop: 0.15 },
    { src: P('Rocks'), x: 2, y: 0, z: -10.5, rotY: 0.9, fitHeight: 3.4, solid: true, trimTop: 0.2 },
    { src: P('Gem Pink'), x: -1.5, y: 2.25, z: -8, rotY: 1, fitHeight: 0.4, pickable: true },

    // ---- 5. the summit: what has been sitting on the bell ----
    { src: V('Bell Tower'), x: 0, y: 0, z: -15, rotY: 0, fitHeight: 12, solid: true },
    {
      src: M('Dragon Evolved'), x: 0, y: 0, z: -12, rotY: 0, fitHeight: 2.8, clip: 'Idle',
      objective: { step: 3, kind: 'defeat', text: 'Kill whatever guards the bell',
        done: 'The summit is clear' },
      npc: { faction: 'hostile', behavior: 'guard', health: 95, damage: 14,
        speed: 2.4, aggroRadius: 9, attackRadius: 2, loot: 'Gold Bag' },
    },
    { src: P('Skull'), x: 2.5, y: 0, z: -13, rotY: 0.8, fitHeight: 0.45, solid: false },
    { src: P('Large Bone'), x: -2.4, y: 0, z: -13.5, rotY: 2.4, fitHeight: 0.4, solid: false },
    { src: P('Bomb'), x: 3.5, y: 0, z: -9, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Bomb'), x: -3.2, y: 0, z: -9.5, rotY: 0, fitHeight: 0.5, pickable: true },
    { src: P('Bomb'), x: 1.2, y: 0, z: -6.5, rotY: 0, fitHeight: 0.5, pickable: true },

    // ---- 6. ring it ----
    {
      src: V('Bell'), x: 0, y: 0, z: -16.5, rotY: 0, fitMaxDim: 1.6, solid: false,
      objective: { step: 4, kind: 'activate', text: 'Ring the bell',
        done: 'The bell carries. A ship is coming.',
        unlockExit: 'town-island', unlockLabel: 'Board the ship home' },
    },

    // ---- 7. the way home, on the beach you landed at ----
    { src: P('Ship'), x: 9, y: -1.2, z: 21, rotY: 0.4, fitHeight: 9, solid: true,
      exitTo: 'town-island', exitLabel: 'Sail home to Ketch Harbour' },

    ...scatter(
      [
        { src: N('Dead Tree'), height: [2.5, 3.6], solid: true },
        { src: N('Pine'), height: [3, 4.5], solid: true },
        { src: N('Rock Medium'), height: [0.6, 1.3] },
        { src: N('Grass Wispy'), height: [0.3, 0.55] },
        { src: N('Pebble Round'), height: [0.15, 0.3] },
      ],
      70, rand, taken
    ),
  ];
}

export type Starter = {
  id: string;
  name: string;
  blurb: string;
  /** Half-extents. Objective islands want room to travel; puzzle islands
   *  want to be crossed in seconds. Defaults to the classic 26x18. */
  size?: { x: number; z: number };
  build: () => LevelEntry[];
};

/** The island size a world should be built at. */
export function sizeFor(id: string) {
  return STARTERS.find((s) => s.id === id)?.size ?? { x: 13, z: 9 };
}

export const STARTERS: Starter[] = [
  {
    id: 'blackreef',
    name: 'Blackreef (adventure)',
    blurb: 'Land, fight up the road, take the pass, climb the reef, ring the bell.',
    size: { x: 30, z: 20 },
    build: blackreef,
  },
  {
    id: 'town-island',
    name: 'Ketch Harbour (town)',
    blurb: 'The hub: a quest board, folk who want things, and ships to everywhere.',
    size: { x: 20, z: 14 },
    build: townIsland,
  },
  {
    id: 'pirate-cove',
    name: 'Pirate cove',
    blurb: 'A treasure climb guarded by a skeleton; a ship to sail on.',
    build: pirateCove,
  },
  {
    id: 'jungle-outpost',
    name: 'Jungle outpost',
    blurb: 'A gated road through orc patrols; a yeti hoards gems.',
    build: jungleOutpost,
  },
  {
    id: 'fishing-village',
    name: 'Fishing village',
    blurb: 'A fish market, a shark in the bay, a ship back to the cove.',
    build: fishingVillage,
  },
  {
    id: 'monster-arena',
    name: 'Monster arena',
    blurb: 'A dragon and its minions. Climb the rocks; fight from above.',
    build: monsterArena,
  },
  {
    id: 'blank-sands',
    name: 'Blank sands',
    blurb: 'Bare sand. Nothing placed — start from scratch.',
    build: blankSands,
  },
];
