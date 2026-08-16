# Roadmap

What we're building toward, roughly ordered. Items graduate off the top.

## Terrain & world feel
- [ ] **Rolling hills that aren't square.** Terraced paint tiles were tried and
      rejected (blocky). Two candidate paths, likely both:
      1. *Asset-based relief* — hills/mountains/platform pieces placed like any
         other model (`terrain/` and `kenney-survival/` packs are in the
         library now; colliders come from the slab pipeline).
      2. *Smooth heightfield ground* — a displaced island mesh with matching
         physics. Needs engine support beyond box colliders (heightfield or
         trimesh in Rapier) — investigate what vibegame exposes before building.
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

## AI assistant
- [ ] Verify pass: after applying a patch, re-read the request and check
      nothing was forgotten (the witch-camp test forgot the gem it described).
- [ ] Let the assistant see asset *appearance* (thumbnails), not just names.

## Known texture/polish debt
- [ ] NPC paths don't follow raised ground (walkers keep authored height).
- [ ] Per-model character girth for collision (one constant today).
- [ ] Sound.

## Asset sourcing rules
CC0 first (Quaternius, Kenney, KayKit); CC-BY is fine with a line in the
pack's CREDITS.txt (terrain/Hill.glb is CC-BY, Poly by Google). No Unity
Asset Store packs — the license doesn't cover non-Unity engines and the
formats don't survive conversion.
