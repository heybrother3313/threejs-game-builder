# Roadmap

What we're building toward, roughly ordered. Items graduate off the top.

## Terrain & world feel
- [x] **Non-flat ground exists.** `entry.groundMesh` samples a model's surface
      on a 1.5-unit grid and lays one thin box collider per cell — the engine
      only exposes cuboid/ball/capsule (no Rapier heightfield or trimesh), so a
      rolling mesh can't be its own collider. `woods/Woods Ground.glb` is the
      first floor built this way: measured 2.3m of relief, median step between
      cells 0.13m (walkable; engine autostep is 0.3m).
- [x] **A basic rolling floor exists**: `terrain/Ground Rolling.glb` (Meshy,
      9.8k tris) at fitMaxDim 26, y -0.4, groundMesh, flatten 0.3 — 1.18m of
      relief, p90 step 0.29m (just under autostep). `entry.flatten` squashes
      terrain height without touching its footprint, which is the knob that
      turns a mountain into a meadow.
- [ ] Trim `Ground Rolling` textures: 4x 2048² maps = 7MB. 1024² and dropping
      metalness (meaningless for dirt) should cut it ~75%.
- [ ] Meshy licence check — commercial-safe export needs a paid tier.
- [ ] **More ground pieces** in varied biomes (sand, grass, rock).
- [ ] Blend the ground piece into the island skirt/shoreline so the seam is hidden.
- [x] Objects, path-walkers and chasing NPCs follow the ground surface.
      `entry.y` now means height ABOVE THE GROUND, so saves survive the
      terrain changing under them. Terrain hides painted tiles (flat quads
      hovering over relief look worse than no paint).
- [ ] Starters should ship with terrain instead of a flat slab.
- [ ] Blend the terrain edge into the shoreline skirt — the seam still shows.
- [ ] Terraced paint tiles were tried and rejected — square hills, wrong shape
      for this world. Don't revisit.
- [ ] Textured/varied ground so paint isn't flat color (per-tile tone jitter,
      maybe subtle noise normal).
- [ ] Irregular island coastline (jittered skirt outline instead of rectangles).

## World structure
- [ ] **Main town island** — the hub. NPCs give out quests posted on boards
      (quest board = interactable that lists fetch quests from town NPCs).
- [ ] **Cut scenes between islands** — play authored AI videos (boat pulling
      away, spaceship to the Mars level, etc.) during travel instead of the
      instant swap. Travel already goes through one code path (`worlds.travelTo`),
      so this is a hook, not a rewrite.
- [ ] More destination islands; portals already support any world id.

## Gameplay systems
- [ ] **Weapons** — handheld melee (sword/axe pickups that change punch damage
      and animation) and bombs that actually explode (area damage + knockback;
      bombs exist as throwables today but only bonk).
- [ ] **Fishing** — the survival kit ships a Fishing Stand and Fish props;
      fish stocks live in the lagoon already. Cast → wait → catch → inventory.
- [ ] **Gardening** — plant seeds, wait (real time or steps), harvest into
      inventory. Survival kit has the Tool Hoe.
- [ ] Quest boards (see main town island) and multi-step quest chains.

## Builder & library
- [ ] **Re-sort and consolidate the asset library** into categories and
      subcategories:
      - nature → trees, bushes, flowers, grass…
      - terrain → rocks, mountains, hills…
      - characters → people, monsters, animals, fish
      Palette UI needs nested groups (or filter chips) to match.
- [ ] Run the collider analyzer over the new packs (`kenney-survival`,
      `terrain`) so their colliders are fitted, not bounding boxes.
- [ ] Palette category icons.
- [ ] "Build your character" creator.
- [ ] **Better border/collider detection pipeline.** Current: vertex-quantile
      core bounds → oriented boxes → slab decomposition, tuned per-pack by
      hand. Wanted: something that gets a good collider for an unseen model
      without hand-holding (and knows terrain from props).
- [ ] **Click-to-drag in the build editor** — dragging currently needs the
      arm/select dance; direct grab-and-move would be quicker.

## Model / API connections
- [ ] **OpenAI API** connection alongside local Ollama — pick per request
      (local for cheap edits, hosted for hard scene composition).
- [ ] **MUAPI** connection for generation: images (textures, UI art), 3D models
      (fill gaps in the library), and video (the island cut scenes).
- [ ] Key handling: keys stay out of the repo and out of level JSON.

## AI assistant
- [ ] Verify pass: after applying a patch, re-read the request and check
      nothing was forgotten (the witch-camp test forgot the gem it described).
- [ ] Let the assistant see asset *appearance* (thumbnails), not just names.

## Known texture/polish debt
- [ ] Per-model character girth for collision (one constant today).
- [ ] Sound.

## Asset sourcing rules
CC0 first (Quaternius, Kenney, KayKit); CC-BY is fine with a line in the
pack's CREDITS.txt (terrain/Hill.glb is CC-BY, Poly by Google). No Unity
Asset Store packs — the license doesn't cover non-Unity engines and the
formats don't survive conversion.
