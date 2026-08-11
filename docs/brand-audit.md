# Brand Audit — What Griddle Actually Ships

Pulled from source on 2026-08-11, at the start of logo work. This is a record of
the current state, not a proposal. Nothing here has been changed; the point is to
have one place that tells the truth before anyone redraws anything.

The same audit is laid out visually in Figma, on the **Logo Ideation** page, in the
section `Claude | Brand foundations | Iteration 1`. The colours there are bound to
a real variable collection (`Griddle · Color`, Light/Dark modes), so the swatches
are live rather than pasted hexes.

## The headline finding

Griddle ships **six different accent colours across four surfaces**, plus a seventh
in the app icon. No two agree. There is no shared token layer — each surface
declares its own CSS custom properties from scratch, and the values drifted.

| Accent | Surface | Source |
|---|---|---|
| `#5B5BD6` | Marketing site, light | `site/demo/index.html` |
| `#8C8CF5` | Marketing site, dark | `site/demo/index.html` |
| `#AA3BFF` | Desktop app shell, light | `apps/desktop/src/app.css` |
| `#C084FC` | Desktop app shell, dark | `apps/desktop/src/app.css` |
| `#8B7CF6` | Settings window | `apps/desktop/src/routes/settings/settings.css` |
| `#B44DFF` | Drag overlay | `apps/desktop/src/routes/overlay/Overlay.svelte` |
| `#C86BF5` → `#7B3FE0` | App icon tiles | `apps/desktop/src-tauri/icons/` |

The site is indigo. The app is magenta-violet. The settings window is periwinkle.
The overlay is a fourth violet. The icon is a gradient related to none of them.
Choosing one is the first decision the logo work depends on.

## 01 · Marketing site — the canonical palette

`site/demo/index.html`. The most deliberate of the three: a full neutral ramp, a
paired light/dark accent, and separate soft/line accent variants. If any palette
becomes the system of record, it should be this one — which is why it is the one
mirrored into Figma variables.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ground` | `#FBFBFC` | `#09090D` | page behind everything |
| `--panel` | `#F1F1F5` | `#121218` | recessed wells |
| `--surface` | `#FFFFFF` | `#1A1A22` | cards, tiles |
| `--surface-2` | `#FAFAFC` | `#15151C` | nested surface |
| `--ink` | `#0B0B12` | `#F3F3F7` | primary text |
| `--muted` | `#6E6E7A` | `#9B9BA9` | secondary text |
| `--faint` | `#9C9CA8` | `#6E6E7E` | metadata, labels |
| `--line` | `#E3E3EA` | `#282833` | card borders |
| `--line-soft` | `#EDEDF2` | `#1F1F28` | inner dividers |
| `--accent` | `#5B5BD6` | `#8C8CF5` | links, eyebrows, focus |
| `--accent-soft` | accent @ 10% | accent @ 14% | accent fills |
| `--accent-line` | accent @ 45% | accent @ 50% | accent borders |

Radius is a single `--card-radius: 10px`. Two shadow steps, `--shadow-lo` and
`--shadow-hi`.

## 02 · Desktop app shell

`apps/desktop/src/app.css`. Its own neutrals, unrelated to 01 — and a warm
`--code-bg` (`#f4f3ec`) that is the only non-neutral background anywhere in the
product.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FFFFFF` | `#16171D` |
| `--text-h` | `#08060D` | `#F3F4F6` |
| `--text` | `#6B6375` | `#9CA3AF` |
| `--border` | `#E5E4E7` | `#2E303A` |
| `--code-bg` | `#F4F3EC` | `#1F2028` |
| `--accent` | `#AA3BFF` | `#C084FC` |
| `--social-bg` | `#F4F3EC` @ 50% | `#2F303A` @ 50% |

## 03 · Settings window and drag overlay

`routes/settings/settings.css` is dark-only and shares no value with either palette
above: `--bg #0F1116`, `--card #171A21`, `--well #10131A`, `--border #262B36`,
`--text-strong #EEF0F4`, `--text #C6CCD6`, `--text-dim #828B9A`, `--accent #8B7CF6`.

`routes/overlay/Overlay.svelte` declares a single `--ov-accent: #B44DFF` for the
drag-target cell highlight.

## 04 · The mark, and the icon that disagrees with it

There are two marks, and they express different ideas of the product.

**The site mark** is CSS-only — no SVG file exists. From `.mark` in
`site/demo/index.html`: a 16×16 box (`box-sizing: border-box`) with a 1.7px inset
stroke and 4px radius, containing a 5.5×5.5 filled square at 3.1, 3.1 with a 1.5px
radius. It inherits `--ink`, so it is monochrome and theme-aware: one outlined
cell, occupied. It has been rebuilt to these exact numbers in Figma.

**The app icon** (`src-tauri/icons/`) is three gradient tiles on a dark rounded
square — one tall tile left, two stacked right, faint grid lines behind. It is
loud, fixed-colour, and does not survive being scaled to 16px.

Neither references the other. Choosing between them — or drawing something that
subsumes both — is the actual logo brief.

## 05 · Type

Griddle ships no webfont; everything is a system stack.

| Role | Stack | Notes |
|---|---|---|
| Display / headings | `--sans` — "Segoe UI Variable Display", "Segoe UI", `-apple-system`, `system-ui` | site headlines at weight 800, −4.2% tracking |
| Body | `--text` — "Segoe UI Variable Text", "Segoe UI", `-apple-system`, `system-ui` | running copy |
| Mono | `--mono` — "Cascadia Code", "Cascadia Mono", Consolas | eyebrows, metadata, control labels |
| App shell | `system-ui`, "Segoe UI", Roboto | a fourth stack, `app.css` |

The settings window uses "Segoe UI Variable Text" with "Cascadia Mono" — close
enough to the site stack to read as accidental rather than intentional.

In Figma the specimens are set in **Inter** as a stand-in, since Segoe UI Variable
does not render reliably there. The real stack is printed under every specimen.

## What this does not cover

Motion (`--ease: cubic-bezier(.22,1,.36,1)`, `--dur: 820ms` on the site; a
different `--ease-out` in the overlay), spacing, and the app-tile demo colours in
the site's fake windows — those are illustration, not brand.
