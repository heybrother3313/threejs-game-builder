---
version: alpha
name: Plinth
description: A clean, minimal light system organized around a tactile press motif. Components rest on a dark outlined base with an offset top face that lifts on hover and presses on active.
theme: light

colors:
  primary: "#fd9b9b"
  primary-soft: "#ffe2db"
  secondary: "#faf7f2"
  tertiary: "#ebe6dd"
  neutral: "#5a5a5a"
  surface: "#ffffff"
  surface-face: "#faf7f2"
  on-surface: "#111111"
  on-surface-muted: "#5a5a5a"
  border: "#111111"
  border-quiet: "#ebe6dd"
  focus: "#fd9b9b"
  error: "#c0392b"

typography:
  font-display: "Space Grotesk, system-ui, sans-serif"
  font-body: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
  display-xl:
    fontFamily: "{typography.font-display}"
    fontSize: "4rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  display-lg:
    fontFamily: "{typography.font-display}"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline-lg:
    fontFamily: "{typography.font-display}"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline-md:
    fontFamily: "{typography.font-display}"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
  title-md:
    fontFamily: "{typography.font-display}"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body-lg:
    fontFamily: "{typography.font-body}"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  body-md:
    fontFamily: "{typography.font-body}"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "{typography.font-body}"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  label-sm:
    fontFamily: "{typography.font-body}"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.08em"
    textTransform: "uppercase"

rounded:
  none: "0"
  sm: "6px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  full: "999px"

spacing:
  2xs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "3rem"
  3xl: "4.5rem"
  layout-max: "1180px"
  layout-gutter: "1.5rem"

borders:
  width-hair: "1px"
  width-strong: "2px"
  width-focus: "3px"

depth:
  press-rest: "4px"
  press-hover: "6px"
  press-active: "0px"
  ease: "cubic-bezier(0.2, 0.7, 0.2, 1)"
  duration-press: "120ms"
  duration-base: "180ms"

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "0.85em 1.6em"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    baseColor: "{colors.border}"
    pressOffset: "{depth.press-rest}"
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    pressOffset: "{depth.press-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary}"
    pressOffset: "{depth.press-active}"
  button-secondary:
    backgroundColor: "{colors.surface-face}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "0.85em 1.6em"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    baseColor: "{colors.border}"
    pressOffset: "{depth.press-rest}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "0.85em 1.6em"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    pressOffset: "0px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "0.85em 1em"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
  input-field-focus:
    borderColor: "{colors.border}"
    focusRingColor: "{colors.focus}"
    focusRingWidth: "{borders.width-focus}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    baseColor: "{colors.border}"
    pressOffset: "{depth.press-rest}"
  card-paper:
    backgroundColor: "{colors.surface-face}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
  card-accent:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
  checkbox:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    size: "1.35em"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    baseColor: "{colors.border}"
    pressOffset: "{depth.press-rest}"
  checkbox-checked:
    backgroundColor: "{colors.primary}"
    checkColor: "{colors.on-surface}"
  tabs:
    backgroundColor: "{colors.border}"
    textColor: "{colors.surface-face}"
    rounded: "{rounded.md}"
    padding: "4px"
    typography: "{typography.body-sm}"
  tabs-active:
    backgroundColor: "{colors.surface-face}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    pressOffset: "{depth.press-rest}"
  press-tile:
    backgroundColor: "{colors.surface-face}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-strong}"
    baseColor: "{colors.border}"
    pressOffset: "{depth.press-rest}"
  press-tile-accent:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-surface}"
  press-tile-inverse:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-surface}"
  badge:
    backgroundColor: "{colors.surface-face}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
    padding: "0.35em 0.7em"
    typography: "{typography.label-sm}"
    borderColor: "{colors.border}"
    borderWidth: "{borders.width-hair}"
  badge-accent:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
---

## Overview

Plinth is a calm, light-mode design system built around a single, unmistakable idea: every interactive surface is a tile that you press. There are no soft shadows, no gradients, and no decorative glow. Depth is expressed structurally — a hard ink base layer sits behind a paper top-face, and that top-face translates upward when at rest, lifts a touch on hover, and snaps flush on press.

The page itself stays out of the way. A pure white canvas (`#ffffff`) lets the components carry the personality, while a warm coral accent (`#fd9b9b`) — borrowed from the brief — sits sparingly on primary actions, focus rings, checked states, and feature surfaces. The result is a system that reads as minimal at first glance and tactile the moment you interact with it.

The hero is intentionally centered and uncluttered. A short eyebrow label, a confident display headline, a single supporting paragraph, and a press-button pair invite engagement; below, a row of "press tiles" demonstrates the signature element. The system is framework-agnostic and ships as a single CSS file with semantic HTML hooks.

## Colors

The palette is anchored by a white canvas and a small set of warm neutrals. The coral accent is the only chromatic note and is reserved for moments that need emphasis.

| Token | Hex | Role |
| --- | --- | --- |
| `surface` | `#ffffff` | Primary page background and clear surfaces. |
| `surface-face` | `#faf7f2` | Resting top-face for pressable components and quiet panels. |
| `on-surface` | `#111111` | Primary text, outlines, and the dark base layer behind every press. |
| `on-surface-muted` | `#5a5a5a` | Secondary text, captions, and metadata. |
| `border-quiet` | `#ebe6dd` | Dividers and hairline frames where 2px ink would be too loud. |
| `primary` | `#fd9b9b` | Primary action fill, checked state, focus ring color. |
| `primary-soft` | `#ffe2db` | Tinted highlights, accent tile backgrounds, badge fills. |

Usage rules:

- The white canvas always leads. Paper (`#faf7f2`) is for resting faces and quiet panels, never the page.
- Ink (`#111111`) carries every component outline at 2px, plus all primary text.
- Coral is an accent, not a surface. Use it for one primary action per region, the focus ring, the checked checkbox, and selective press-tile highlights. Avoid blocks of coral that compete with the press motif.
- Maintain at least 4.5:1 contrast for body text and 3:1 for large display text. The ink-on-canvas and ink-on-coral pairs both clear AA.

## Typography

Two families do the work. Space Grotesk handles every display moment with slightly tightened tracking and a confident geometric feel. Inter handles body, UI, labels, and the eyebrow micro-type.

- **Display** — Space Grotesk 700, `-0.02em` tracking, line-height `1.1`. Used for hero headlines and the press-tile metric.
- **Headlines** — Space Grotesk 600, tight tracking, used for section titles and card titles.
- **Body** — Inter 400 at 16px and 17px with line-height `1.55` for comfortable reading; Inter 500–600 for UI labels and emphasis.
- **Eyebrow / Label** — Inter 600 at 12px, `+0.08em` tracking, uppercase. Used above hero headlines and inside press tiles.

Pair rules:

- Never set a display heading in Inter or a body paragraph in Space Grotesk.
- Keep paragraph measure between 55–75 characters for body content.
- Eyebrow labels should be short — three words or fewer.

## Layout

Plinth uses a fluid, centered layout with generous breathing room.

- Max container width: `1180px`, with `1.5rem` gutters that collapse responsively.
- Vertical rhythm follows the spacing scale (`xs` → `3xl`). Hero sections favor `2xl`–`3xl` vertical padding; cards favor `lg`.
- The hero is centered: a stacked column of eyebrow, headline, paragraph, action row, and supporting press-tile grid. There is no off-canvas illustration or decorative split.
- Component grids use 2, 3, or 4 columns above 820px and collapse gracefully to one column on narrow screens.
- Density is medium-low. Buttons feel substantial (`0.85em 1.6em` padding). Cards and tiles use `1.5rem` interior padding.
- All interactive components keep a minimum of 44px tap target via padding, even at the small size.

## Elevation & Depth

There are no `box-shadow` glows in Plinth. Depth is a stacked structure:

1. A dark **base layer** (`on-surface`, `#111111`) sits at the component's footprint with the same border radius.
2. A **top-face** sits on top with a 2px ink border and translates upward to reveal the base.

The translate distance is the only thing that changes between states:

- **Rest** — `translateY(-4px)`
- **Hover** — `translateY(-6px)` (a 2px lift cue)
- **Active / Pressed** — `translateY(0)` (snaps onto the base)

Transitions are 120ms with a custom ease (`cubic-bezier(0.2, 0.7, 0.2, 1)`) on the translate axis, and 180ms on color changes. The motion is intentionally short so the press feels mechanical rather than animated.

Implementation pattern (used by `.btn`, `.card`, `.press-tile`, `.check__box`, and the active tab pill):

```css
.component {
  background: var(--color-ink);          /* base layer */
  border-radius: var(--radius-md);
}
.component__face {
  background: var(--surface-face);       /* top face */
  border: var(--border-w) solid var(--border-strong);
  border-radius: var(--radius-md);
  transform: translateY(calc(-1 * var(--press-rest)));
  transition: transform var(--dur-press) var(--ease-press);
}
.component:hover .component__face { transform: translateY(calc(-1 * var(--press-hover))); }
.component:active .component__face { transform: translateY(var(--press-active)); }
```

## Shapes

The system has a single dominant radius and a small support scale.

- **Primary radius** — `12px` (`rounded.md`). Carried across buttons, inputs, cards, tabs container, press tiles, and the checkbox is a slightly smaller `6px`.
- **Pill** — `999px`, reserved for badges and dot indicators.
- **Border weights** — `2px` ink outline for every framed component, `1px` hairline for quiet dividers and small badges.
- **Icon stroke** — `2px` to match component outlines, sized to roughly match cap height (`1.05em`–`1.1em`).
- **Corners are crisp** — never rounded so far that the press base disappears. The 12px radius keeps the offset visible on every component size.

## Components

### Button

The flagship of the system. Built from an ink base (`<button class="btn">`) and a paper top-face (`<span class="btn__face">`). Three variants and three sizes share the press motif.

- `btn--primary` — coral face on an ink base. Used for the single primary action in a region.
- `btn--secondary` — paper face on an ink base. Default tactile choice.
- `btn--ghost` — flat outlined button with no translate; used for tertiary or destructive secondaries.
- Sizes `btn--sm`, default, `btn--lg` adjust padding and font-size while preserving the press offset.

Markup pattern:

```html
<button class="btn btn--primary">
  <span class="btn__face">Get started</span>
</button>
```

### Input

Outlined field on canvas with a quiet inner pad and a coral **focus ring** (a `3px` outset `box-shadow`) instead of a soft glow. Hover gently tints the field to paper. Supports an optional inline icon via `.input--with-icon`.

```html
<label class="field">
  <span class="field__label">Email</span>
  <input class="input" type="email" placeholder="you@studio.com" />
  <span class="field__hint">We only use this for delivery updates.</span>
</label>
```

### Card

Mirrors the button anatomy at a larger scale. Static cards use `.card__face` without interactivity; `card--interactive` enables the hover lift and active press. `card--paper` and `card--accent` swap the face surface to warm neutral or coral-soft for emphasis.

### Checkbox

A square ink-outlined box with the same press structure. Selected state fills the face with coral and reveals an ink check via a CSS-drawn corner. The label is fully clickable; the underlying `<input>` is visually hidden but keyboard accessible, with the focus ring forwarded to the visible box.

### Tabs

A segmented control framed in ink. Inactive tabs sit on the dark frame in muted paper text. The active tab is its own miniature press: a paper face with a 2px outline, lifted by the same 4px rest offset to read as the chosen surface. Use `aria-selected="true"` for the active tab.

### Press Tile (signature element)

A stacked, pressable feature/stat tile. Each tile pairs a small uppercase label, an outlined icon chip, a large display value, and an optional caption. Three variants (default paper, `--accent` coral-soft, `--inverse` coral) let a row of tiles establish hierarchy without leaving the system language. Tiles double as hero supporting content, dashboard KPIs, and clickable feature cards.

### Badge

A small pill for tagging and inline status. Hairline border keeps it quiet next to 2px components. `badge--accent` and `badge--dot` add an indicator without breaking rhythm.

### Iconography

The system uses [Lucide](https://lucide.dev/) (ISC). Icons render at `1.05em`–`1.1em` with a `2px` stroke that matches the component outline weight, and inherit color via `currentColor`. The preview loads the official browser script (`https://unpkg.com/lucide@latest`) and uses `<i data-lucide="…">` markup. Do not mix Lucide with another library inside this system.

## Do's and Don'ts

**Do**

- Keep one primary coral action per section; rely on paper and ghost variants elsewhere.
- Pair every press component (`.btn`, `.card`, `.press-tile`, `.check__box`, active tab) with its dark base layer so the press depth reads correctly.
- Reuse the press offset tokens (`--press-rest`, `--press-hover`, `--press-active`) for any new pressable surface.
- Honor `prefers-reduced-motion`; the system already collapses translate transitions to instantaneous.
- Use Lucide icons sized to match the surrounding type and inherit `currentColor`.

**Don't**

- Don't add soft `box-shadow` glows or drop shadows; depth is structural in this system.
- Don't tint the page background with coral or paper — those tones belong to faces and accents, never the canvas.
- Don't replace the 2px ink outline with a colored or thinner border on press components; it carries the system's voice.
- Don't mix icon libraries or introduce custom SVG paths that drift from the 2px stroke language.
- Don't stack two press components inside each other (e.g., a `.btn` inside a `.card__face` that is itself interactive); pick the outermost surface to carry the press.
