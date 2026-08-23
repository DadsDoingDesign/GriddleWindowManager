# Griddle — design system & token inventory

The settings pop-out is the whole of Griddle's visible surface. Everything
else it draws is an overlay on someone else's window, so this document is the
design system: one panel, two themes, no pages.

Source of truth is split deliberately. **Hue lives in Figma** — the
`Griddle · Color` collection, Light and Dark modes — and is copied into
`apps/desktop/src/routes/settings/settings.css` value for value. **Structure
lives in the code**: spacing, type scale, radii, motion, layering and focus
are defined once here and never re-derived in a component.

Architecture follows the Fieldwatch system (`GameDev/TowerDefense/docs/
DESIGN_SYSTEM.md`) — the same categories and the same rule that a token is
named for what it *means*, not what it looks like. The values are Griddle's.

---

## 1. The shape of the thing

The panel is a **table of bands**. Every setting is one full-width row of
`--row-h`, with a hairline under it; the label cell takes the slack and
carries the vertical rule; each control sits in its own `--cell-w` square
pinned to the right edge. The controls therefore line up in a single column
down the whole widget regardless of how long the labels are.

That is not decoration. Griddle configures a grid, and the widget is built
out of the same idea — fixed cells, one rule between them.

The window is **fixed size and never scrolls**. The map absorbs the slack:
it takes its size from the band it sits in and letterboxes to keep the
display's proportions, so one window size works on any monitor.

---

## 2. Tokens

All in `settings.css`. Colour is the only axis that changes with the theme;
everything below the colour block is theme-independent, which is what stops a
component drifting between modes.

### Grounds & surfaces

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--bg` | `#09090d` | `#fbfbfc` | the ground behind the panel |
| `--panel` | `#121218` | `#f1f1f5` | chrome: the brand row |
| `--surface` | `#1a1a22` | `#ffffff` | content: the settings table |
| `--surface-2` | `#15151c` | `#fafafc` | recessed: tab band, wells, inputs |
| `--line` | `#282833` | `#e3e3ea` | every rule and border |
| `--line-soft` | `#1f1f28` | `#ededf2` | dividers *inside* a group |

Four levels, not three. An earlier palette had ground and surface-2 within one
step of each other (`#0f1116` against `#10131a`) and the banded rows read as
flat — the tones have to be far enough apart to do the work the rules are not
doing.

### Text

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--text` | `#f3f3f7` | `#0b0b12` | primary — headings, values |
| `--muted` | `#9b9ba9` | `#6e6e7a` | secondary — row labels |
| `--faint` | `#6e6e7e` | `#9c9ca8` | tertiary — hints, units, disabled |

### Accent & semantic

`--accent`, `--accent-soft` (tinted fills), `--accent-line` (tinted borders),
`--on-accent` (text on a filled accent), and `--good` / `--warn` / `--bad`.

Accent carries one meaning: **this is selected or applied**. The selected tab
is a solid `--accent` block; the "Grid applied" checkbox fills with it; map
tiles are `--accent-soft` on `--accent-line`. It is never used for emphasis.

### Spacing (4px base)

`--sp-px` (2px, hairline nudges only), then `--sp-1` … `--sp-6` = 4, 8, 12,
16, 24, 32.

### Structure

`--row-h` (32px, one band) and `--cell-w` (32px, one control cell). These two
are why the panel lines up; a component that hardcodes 32 has opted out of
the system.

### Typography

`--font-body`, `--font-mono`; sizes `--fs-h1` 16 / `--fs-h2` 13 /
`--fs-body` 12.5 / `--fs-sm` 12 / `--fs-xs` 11; `--lh-tight` and `--lh-body`;
weights `--fw-regular` / `--fw-medium` / `--fw-bold`; `--tracking-label` for
uppercase tabs.

### Shape, elevation, motion, layering, focus

- `--radius-sm` 4, `--radius` 8, `--radius-lg` 10, `--radius-pill`
- `--shadow-1` (resting), `--shadow-2` (popovers) — theme-aware
- `--dur-fast` 80ms, `--dur` 120ms, `--dur-slow` 220ms, `--ease`
- `--z-base` / `--z-raised` / `--z-sticky` / `--z-popover`
- `--focus-ring` + `--focus-offset`
- `--hit-min` 32px — pointer-only app, so one band is the floor

---

## 3. Checklist for a new control

1. **Live in a band.** `--row-h` tall, a label cell that takes the slack, and
   controls in `--cell-w` squares. Do not invent a layout.
2. **Nothing moves on interaction.** Focus and hover may change colour and
   outline, never size. A flex item defaults to `min-width: auto`, so pin the
   cell and let the control fill it — this is exactly how the number fields
   once shoved the minus button sideways mid-edit.
3. **Label in `--muted`, value in `--text`.** Units and hints in `--faint`,
   parenthesised on the label rather than appended to the number.
4. **Numbers get `font-variant-numeric: tabular-nums`** so a row does not
   reflow as a value changes width.
5. **Accent means selected or applied.** Nothing else.
6. **State needs form as well as colour** — the applied grid gets a checkbox,
   not just a tint.
7. **Focus is visible on everything interactive**, via `--focus-ring`.
8. **Motion is `--dur` on colour and opacity.** Never on layout, and never on
   anything that maps live desktop state: the grid map deliberately has no
   reposition animation, because a map that slides disagrees with the desktop
   for the length of the slide.
9. **Both themes, every time.** Use tokens only; if a literal is needed the
   token set is missing something — add it in both modes.

---

## 4. Known gaps

- The **overlay** window (drag previews, refusal messages) has its own
  `--ov-*` colours and does not consume this token set. It is a separate,
  click-through surface with different constraints, but the two palettes can
  drift and nothing catches it.
- **No contrast audit** has been run on either theme.
- `--good` / `--warn` / `--bad` are defined but only lightly used; they have
  not been checked at body size on either ground.
- The **brain and first-run** surfaces predate the band table and still use
  card-style layout, so the checklist above describes the settings table
  rather than the whole file.
