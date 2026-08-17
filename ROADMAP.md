# Roadmap

What we're building toward, roughly ordered. `[x]` means done and verified;
those stay for a while so the reasoning behind them isn't lost.

**The open question is the last section.** Everything else is a feature; how a
game gets out of this tool and in front of someone else decides what the tool
actually is.

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
- [x] Coast seam solved by construction: the generated floor fades to exactly
      0.000 at the island edge, so there is nothing to blend.
- [x] Objects, path-walkers and chasing NPCs follow the ground surface.
      `entry.y` now means height ABOVE THE GROUND, so saves survive the
      terrain changing under them. Terrain hides painted tiles (flat quads
      hovering over relief look worse than no paint).
- [ ] Starters could place *extra* terrain pieces (mountains, ground props) on
      top of the generated floor for silhouette variety.
- [x] REJECTED: terraced paint tiles. Square hills, wrong shape for this
      world. Don't revisit.
- [x] Ground carries its own colour and tone variation — sand at the
      waterline, dry grass on the rises, per-vertex jitter so flat ambient
      light doesn't read as linoleum. Redundant paint tiles are now deleted
      on load rather than hidden.
- [ ] Irregular island coastline (jittered skirt outline instead of rectangles).

## World structure
- [ ] **Go inside buildings.** The village pack's houses are solid shells, so
      this needs either interior models or a door that travels to a small
      "interior" world — which the travel system already does. The portal
      route is far cheaper and reuses everything; the cost is a load between
      outside and inside rather than walking through a doorway.
- [ ] **Tunnels and mines.** Same question in the other axis. The ground is a
      height function with a collider grid derived from it, so a hole means
      either punching a gap in that grid (the function would need to return
      "no floor here") or treating a mine as its own small world reached by a
      portal. Worth deciding both together, since a cave and a house interior
      are the same problem.
- [x] **Character select screen** — its own toolbar button and panel, a grid
      of the six playable characters. Falls back to rendered model thumbnails
      until art is dropped into public/ui/characters/.
- [x] **Main town island** — Ketch Harbour, with a quest board that reads open
      fetch quests off the townsfolk, and berths to all four islands.
      Travel is hub-and-spoke.
- [ ] **Starter updates don't reach saved worlds.** A world you've visited is
      banked in `sandbox-worlds-v1` and shadows the starter forever — editing a
      starter has no effect on anyone who has been there. Needs a "reset this
      island" action, or version-stamping starters.
- [ ] **Cut scenes between islands** — play authored AI videos (boat pulling
      away, spaceship to the Mars level, etc.) during travel instead of the
      instant swap. Travel already goes through one code path (`worlds.travelTo`),
      so this is a hook, not a rewrite.
- [ ] More destination islands; portals already support any world id.

## Gameplay systems
- [ ] **Health regeneration.** There is currently no way back to full health
      except dying, which makes exploring after a fight pointless. Three
      shapes, cheapest first: slow passive regen out of combat; sleeping at a
      tent or bedroll (the survival kit ships both, and a bed is an activate
      objective); food as a collectible that heals. Probably all three, gated
      differently — passive for chip damage, sleep for a full reset, food as
      the thing you spend an economy on.
- [ ] **Crafting.** Recorded because it keeps coming up, NOT scheduled — Ethan
      is explicit he doesn't want to build it. If it ever happens the honest
      version is small: a workbench (the survival kit has three) that turns
      N of one collectible into one of another, which is the economy with a
      different noun. Resist the recipe tree.
- [ ] **Economy.** Coins, gems and gold are collected and counted but buy
      nothing, so treasure is a score with no sink. Spend it on weapons, house
      upgrades, farm supplies and power-ups. The pieces exist — an inventory
      that persists across islands, spendLoot/grantLoot, and NPCs that already
      take an item and give one back — so a shopkeeper is a fetch quest with a
      price list rather than a new system.
- [ ] **Weather and day/night.** The sky, water and fog are all generated from
      constants in atmosphere.ts, so a time-of-day is those constants on a
      curve: sun angle and colour, sky gradient, fog density, water tint. Rain
      and storm are the same idea plus particles and a darker palette. Worth
      doing after the economy, since weather is atmosphere and the economy is
      a reason to keep playing.
- [x] **Objectives** — tracked steps (defeat / collect / reach / activate /
      talk) living on the thing they concern, with a HUD and a completion
      chain. Blackreef is the first island built around them.
- [x] **Enemies drop the weapon they fight with** (`npc.weapon`). Unlike loot
      it stays on the ground: a weapon is something you choose to pick up.
- [x] **Weapons live in the hand** — player and enemies both, attached to the
      left hand (the arm the Weapon clip swings). Killing something takes the
      weapon out of its hand and drops it where it fell. Fitting is done by
      eye in the Weapon fit bench rather than derived, after two failed
      attempts at deriving it.
- [ ] **An equipped-weapon slot separate from the carried item.** You can hold
      one thing, so taking a bomb means dropping your sword. That tension is
      interesting once, annoying thereafter.
- [ ] **Turn-based combat as a v2 MODE (Final Fantasy style).** Worth being
      clear-eyed: this is a fork, not a simplification. Its real appeal is
      that it decouples combat from animation timing, which has been the
      single richest source of bugs here — the aborted punch, the swing
      window, the flinch stealing the rig, walking read as falling. Turn-based
      makes all of those disappear because nothing depends on frames.
      Against it: the real-time feel is now built and working, and switching
      discards the camera, controller and combat tuning. Best shape is
      probably a per-encounter mode (boss battles resolve turn-based) rather
      than a global replacement — the island can declare which it uses, the
      same way it declares its size.
- [x] **Weapons** — blades change damage/reach when carried (F swings instead
      of throwing); bombs explode where they land with falloff damage, prop
      knockback and self-damage.
- [x] **Swing animation for blades** — armed swings play the rig's Weapon
      clip instead of Punch.
- [ ] **Fishing** — the survival kit ships a Fishing Stand and Fish props;
      fish stocks live in the lagoon already. Cast → wait → catch → inventory.
- [ ] **Gardening** — plant seeds, wait (real time or steps), harvest into
      inventory. Survival kit has the Tool Hoe.
- [x] Quest boards, fetch quests, and the objective chain (see above).

## Builder & library
- [x] **Library re-sorted** into groups/subgroups (Terrain/Nature/Characters/
      Structures/Items), generated from the pack manifests by rule so a new
      zip lands in the right drawer.
- [x] Collider analyzer run over the new packs (meta 71 → 132). Lookups key on
      full path now — several packs ship a Barrel/Rock/Tree and bare-name keys
      let one pack's collider describe another's.
- [ ] `Hill.glb` was removed: broken at source (2.3M-unit plane). Find a
      replacement hill asset.
- [ ] Palette category icons.
- [ ] "Build your character" creator.
- [ ] **Better border/collider detection pipeline.** Current: vertex-quantile
      core bounds → oriented boxes → slab decomposition, tuned per-pack by
      hand. Wanted: something that gets a good collider for an unseen model
      without hand-holding (and knows terrain from props).
- [ ] **Click-to-drag in the build editor** — dragging currently needs the
      arm/select dance; direct grab-and-move would be quicker.

## Saving, hosting, sharing
- [ ] **Save gameplay state, not just levels.** Levels persist; PROGRESS does
      not. Inventory, which objectives are cleared, which quests are settled
      and which world you are in live in scattered localStorage keys, and
      objective progress resets on reload. Needs one save object with a
      version stamp, and a decision about whether a save belongs to a player
      or to a game.
- [ ] **Publishing pipeline** — the open question, and the one that decides
      what this tool IS. A game here is data (level JSON, weapon fits,
      objectives) plus the shared engine and asset library. So "publish" could
      mean: (a) export a single JSON a friend imports into their own copy —
      trivial, no hosting, but they need the tool; (b) a static build per game
      — the engine and assets are the same for everyone, so a game is a few
      hundred KB of JSON against a shared bundle, and a URL could carry it;
      (c) a hosted gallery with accounts, which is a product rather than a
      feature. Worth deciding (a) vs (b) early: (b) only works if assets stay
      redistributable, which is why the CC0-first rule matters.
- [ ] Asset licensing audit before anything is published — every pack's
      CREDITS.txt is in place, but a shipped game needs one combined notice.

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
