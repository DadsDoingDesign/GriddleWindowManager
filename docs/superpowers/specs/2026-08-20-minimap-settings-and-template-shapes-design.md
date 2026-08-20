# Minimap Settings + template shapes — Design Spec

**Date:** 2026-08-20
**Status:** Approved (all four decisions taken by the user)

Two related pieces of the same complaint: the settings surface does not read
like what it configures. Template cards claim "12×6" for a two-column layout,
and the settings window is a 2854-line scrolling page when what the user wants
is a small map of their displays.

## Part 1 — Template shapes

### The problem, and the history

Every built-in template is authored on the 12×6 lattice, so "Two columns"
displays as `12×6 · 2 slots` and its thumbnail draws a 12×6 grid holding two
blocks. Conceptually it is a 2×1 layout and should say so.

The templates *were* originally 2×1/3×1/2×2/8×6/1×2. Critique round 3
re-authored them onto 12×6 because `applyTemplate` re-dimensions the grid to
the template's dims, so one Apply click silently collapsed a 12×6 grid and
destroyed the user's granularity (docs/deferred.md, "Critique round 3"). Any
fix must keep that protection.

### Decision

Show the shape; scale on apply.

- **`templateShape(tpl)`** — pure, in `templates.ts`. Divides `cols`, `rows`
  and every slot by the GCD of all of them, yielding the template's natural
  shape. Built-ins reduce (12×6 → 2×1); a captured layout reduces when it can
  and is returned unchanged when it cannot.
- **Cards and thumbnails** render the shape: "2×1 · 2 slots · built-in", and
  a 2×1 lattice, so the picture matches the name.
- **Apply is non-destructive when the arithmetic allows.** If the grid's dims
  are integer multiples of the shape's, the slots scale up by those factors
  and the grid keeps its dims — 12×6 with a 2×1 shape yields two 6×6 halves.
  Only when the dims do not divide does apply re-grid to the template's own
  dims, exactly as today, with the button disclosing it.

### Tests

`templateShape` on each built-in, on an already-minimal template, and on an
irregular capture that cannot reduce; scale-up placement on a divisible grid
(dims unchanged, slots multiplied); the non-divisible fallback still re-grids;
`activeTemplateId` bookkeeping unchanged.

## Part 2 — Settings as a minimap pop-out

### Shape

`Settings.svelte` becomes a thin tab host: it keeps the config/snapshot
subscriptions and the shared state it already owns, and renders a tab bar plus
one tab body. The 2854-line file splits along those seams.

| Tab | Contents | File |
| --- | --- | --- |
| One per enabled display | The live grid editor as the hero (this is the minimap), a compact control row above it (columns, rows, gap, padding, placement), templates below | `DisplayTab.svelte` |
| `+` | Spanning-grid creation and custom grids (today's "Span monitors" card) | `AddGridTab.svelte` |
| ⚙ | General (autostart, hotkey, edge-snap), Updates, App defaults, Views, Excluded apps, Floating windows | `PreferencesTab.svelte` |

`GridEditor`, `TemplateGallery`, `ContextMenu` and `NumberField` are reused
unchanged. The first-run welcome stays as a pre-tab overlay: it is a different
mode, not a tab.

### Window

Default ~720×560, minimum ~480×420, resizable. **Floating, not tiled**
(user decision): always-on-top, and Griddle no longer manages it.

A **hide control** sits in the tab bar (a chevron-down icon, right-aligned
beside the ⚙ tab) that returns the pop-out to the tray. It hides rather than
closes, so reopening via the tray, the hotkey or a second launch restores the
same window instead of rebuilding it — the cheap path, and the one
`open_settings` already takes when the window exists. Because the pop-out is
always-on-top, a one-click way out of the way is not a nicety: without it the
minimap sits over the very windows it maps.

That reverses the Settings eligibility carve-out added earlier today
(`shell::settings_hwnd` + the tracker's `allowed_own` parameter): a minimap
you drag windows *toward* must stay visible and must not occupy one of the
cells it is describing. The revert restores `WINEVENT_SKIPOWNPROCESS` on the
hooks and drops the own-process exception, and
`docs/window-eligibility.md` moves the Settings row from "managed" back to
"never managed", with this reason recorded. The `window-unmovable` event
from that same commit is independent and stays.

### Staging

Each stage builds, passes both suites, and is shippable on its own:

1. **Template shapes** — pure function, card/thumbnail, apply scaling, tests.
2. **Tab shell + file split** — content moved verbatim into the three tab
   components; no visual redesign yet, so a regression is obvious.
3. **Minimap-first display tab** — compact the control row, make the editor
   the hero, shrink and float the window, revert the tiling carve-out.

## Out of scope

- Reordering or renaming tabs at runtime.
- Persisting the selected tab across launches (it opens on the primary
  display's tab).
- Any change to how grids themselves behave: this is presentation plus the
  template-apply arithmetic, nothing more.
