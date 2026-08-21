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

**A pop-out is chrome, not dimensions.** The first pass read "small floating
pop-out" as a size plus an always-on-top flag, shipped exactly that, and the
user's verdict was immediate: *"its still a window for me... but the tabs are
there!"* Small and on top is still an application window while it keeps a
native title bar and a taskbar button. What actually makes it a pop-out:

- `decorations(false)` — no OS title bar. The slim brand row takes over as
  the drag handle via `data-tauri-drag-region`, which must be set on every
  element the pointer can land on (Tauri tests the event target, not its
  ancestors) and deliberately *not* on the pause switch.
- `skip_taskbar(true)` — it lives in the tray, so it should not also hold a
  taskbar slot as if it were an app you alt-tab between.
- `maximizable(false)` — Tauri drag regions maximize on double-click, and a
  maximized minimap covers the desktop it is a map of.
- Rounded corners via `DWMWA_WINDOW_CORNER_PREFERENCE`, matched by a radius
  on `html`/`body`. Windows 11 rounds decorated windows and leaves
  undecorated ones square; without both halves the page paints square
  corners inside a rounded mask and the window looks like it failed to draw.
  On Windows 10 the attribute is unknown and square corners are the fallback.
- A hairline border, because an always-on-top panel with no frame against a
  dark desktop reads as a hole rather than a window.

Removing the title bar removes the X, and leaving the taskbar removes the
right-click close, so **Esc dismisses** — the keyboard's equivalent of the
chevron. It is suppressed on the first-run welcome (a step to finish, not a
panel to flick away) and inside text fields (where Esc means "cancel this
edit").

Clipping `body` to the rounded frame moves the scroll one level in: `.page`
becomes the scroller, which also keeps the scrollbar inside the rounded
corners instead of riding over them.

### Panel, not page (second field round)

Three further corrections, all from the same observation — it still behaved
like a window that happened to be small:

- **It opened dead centre.** An always-on-top panel that lands over whatever
  you were reading is the worst possible default. It now opens at the
  bottom-right of the primary work area, by its own tray icon, where Windows
  puts its own transient panels; and it remembers where you drag it
  (`settingsWindowPos`, clamped back onto a live monitor at open time, since
  a pop-out with no taskbar button has no other recovery route).
- **Only the brand row could be grabbed.** A frameless window with one thin
  grab strip is worse to move than a titled one, so `data-tauri-drag-region`
  now sits on the page, the tab bar, the map card and the control rows.
  Every control stays clickable by being the event target itself.
- **The controls wrapped into ragged rows.** In a narrow panel they are a
  list: one setting per line, label left, control right — the shape the
  toggles already used. The map shrank to 360px wide to match.

### Snapping the pop-out is a setting, not a rule

The earlier field report — *"do not exclude any windows from the grid"* — was
right, and so is leaving this window out: both, about different windows. The
pop-out is a map of the grid, so tiling it makes it occupy one of the cells it
describes. That is a good default, not a law, so `manageSettingsWindow`
(config v6, default off) lets the user opt in.

The mechanism is a gate, not new machinery: `note_settings_hwnd` registers the
handle unconditionally and the tracker pairs it with the flag
(`own_window_is_managed`). Registering only when the flag was already on would
have made the toggle silently require a restart. When the flag is off the
WinEvent path drops own-process events exactly as early as `SKIPOWNPROCESS`
would, so the default costs nothing.

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
   *Shipped: 003d57b.*
2. **Tab shell** — tab bar, hide-to-tray, floating window, carve-out revert.
   *Shipped: d63ae1f.*
3. **Minimap-first display tab** — explanations to tooltips, one-line header,
   templates folded, editor as the hero. *Shipped: 4d11d44.*

### The file split, and why it is still outstanding

The plan above said stage 2 would also break `Settings.svelte` into
`DisplayTab` / `AddGridTab` / `PreferencesTab`. It did not, and the reason is
worth writing down rather than rediscovering.

Extracting the markup is the easy half — the tab gating already marks the
seams, and the prop surface is small (the tab components can call the global
`emitSettings*` helpers directly instead of taking handlers as props;
`AddGridTab` needs exactly one prop). The hard half is CSS: Svelte's
`<style>` is **component-scoped**, and `Settings.svelte`'s block is roughly
800 lines of class rules that the extracted markup depends on. Splitting the
markup without moving those rules silently unstyles every extracted section.

So the real job is: move the shared rules into `settings.css` (which today
holds only design tokens), keep the genuinely component-local rules with
their components, and verify each settings surface visually. That is a
mechanical but wide change with real visual-regression risk and no
user-visible benefit — worth doing deliberately, not as the tail of a long
feature session.

## Out of scope

- Reordering or renaming tabs at runtime.
- Persisting the selected tab across launches (it opens on the primary
  display's tab).
- Any change to how grids themselves behave: this is presentation plus the
  template-apply arithmetic, nothing more.
