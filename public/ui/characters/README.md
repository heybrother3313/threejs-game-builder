# Character portraits

Drop the rendered character art here. Filenames are matched to models by the
character-select screen, so they must be exactly:

    frog.png        dino.png        monkroose.png
    alien.png       fish.png        yeti.png

Plus, optionally:

    all.png         the group shot, for a title/menu screen

PNG or JPG both work (the loader tries .png then .jpg). Any resolution —
they're fitted with CSS `object-fit: cover`, so roughly square or 4:3 crops
work best. Portrait-oriented art gets cropped top and bottom.

The names map to these models:

| file          | model                                        |
|---------------|----------------------------------------------|
| frog          | ultimate-monsters/Frog.glb                   |
| dino          | ultimate-monsters/Dino.glb                   |
| monkroose     | ultimate-monsters/Monkroose.glb              |
| alien         | ultimate-monsters/Alien-RRliSQBP7r.glb       |
| fish          | ultimate-monsters/Fish-ypEYhCImAB.glb        |
| yeti          | ultimate-monsters/Yeti-ceRHrn8HHE.glb        |

Anything missing falls back to a rendered thumbnail of the model, so a partial
set is fine — the screen won't break if only some are present.
