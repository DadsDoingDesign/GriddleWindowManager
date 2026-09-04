# Expand-on-maximize, auto-split, and the settings rows — Design Spec

**Date:** 2026-08-31 (second batch, same session as drag-fill placement)
**Status:** Approved (user chose: toggle expand; expand as default with pref;
auto-split with no aiming band, single victim, with pref; dropdowns for the
Preferences text rows; gear moves into the tab row)

## 1. Maximize becomes expand-in-grid

Double-clicking a title bar, the maximize button and Win+Up all raise the
same OS maximize — Griddle cannot tell them apart. Today the tracker
translates a maximize into "treat as minimized": the tile is released and
the window is left alone. As of this spec, for a **tiled, resizable,
in-flow** window with the preference at its default:

- The maximize is intercepted: the brain grows the tile to the **largest
  free rectangle containing its current cells** (its own cells count as
  free) and asks the shell to `SW_RESTORE` the window; the tracker's
  unmaximize event then re-tiles it at the remembered (grown) slot through
  the existing minimize/restore machinery — no new apply path.
- **Toggle:** the pre-expand slot is remembered (`expandedFrom`). The next
  maximize on an expanded tile returns it to that slot instead of growing.
  Any other commit that moves or resizes the tile (drag, editor, transfer)
  clears the memory — after a manual rearrangement the next maximize grows
  again rather than jumping to a stale slot.
- A tile that cannot grow (boxed in) and has no toggle memory simply
  un-maximizes back onto its own cells.
- Floating windows, absolute/non-resizable tiles, and the preference set to
  `windows` keep today's behavior exactly (release + leave alone).

Contract: new tracker event `window-maximized {hwnd}` (replacing the
maximize half of the zoom translation; unmaximize still emits
`window-restored`), new brain callback `onRestore` and Rust command
`restore_window` (brain-host-only, live-set verified, `ShowWindowAsync` —
the mirror of `minimize_window`).

## 2. Auto-split on a full grid

The drag-fill spec left a full grid answering "No room" with the opt-in
Make-room band. Field report (same day): dragging a full-grid tile onto
another full-grid tile refuses even though both can shrink. As of this
spec, when a **new-to-grid** drag (intake *or* managed cross-grid — the
2026-08-20 spec's deferred case) hits a refused placement and the pref is
at its default:

- The preview shows the outcome directly: the aimed tile's ghost shrinks to
  its kept half and the footprint becomes the donated half (the same
  `makeRoomPlan` the armed band used — victim under the cursor, longer axis
  split, min sizes respected on both sides). **No Make-room band**; the
  Swap band remains as the alternative gesture.
- Release anywhere (outside the Swap band) commits the split. Click safety
  stays: a drop with no drag samples commits nothing, and the grab preview
  shows the plain refusal until the first sample.
- Victim at its minimum (`atMin`) or unsplittable → the refusal stands as
  today. Same-grid moves are untouched.

## 3. Settings

- **Gear in the tab row:** the ⚙ moves from the brand row to the right end
  of the display-tab row, so leaving Preferences is the same gesture as
  entering any display. The brand row keeps the lockup and hide-to-tray.
- **Dropdowns:** the Preferences text choices — Appearance, the two
  drag-placement rows, and the two new rows below — become
  `PlacementPicker` dropdowns (the in-page listbox; native `<select>`
  popups land off-window in the undecorated pop-out). Pause stays a button.
- **New rows:** *Maximizing a tiled window* — `Expand in the grid`
  (default) / `Windows maximize`; *Dropping on a full grid* — `Make room
  automatically` (default) / `Just say no room`.

## 4. Config

v9 adds `maximizeBehavior: 'expand' | 'windows'` (default `'expand'`) and
`noRoomPlacement: 'split' | 'refuse'` (default `'split'`). Same loader
rules as v8: persist.ts and the brain constructor default junk, the Rust
mirror round-trips `Option<String>`, older files migrate in place.

## 5. Tests

- openspace: `cover` constraint (grow-in-place candidates must contain the
  tile's cells).
- brain: windowMaximized matrix — expand, toggle back, boxed-in no-op,
  floating / non-resizable / pref-off fallbacks, memory cleared by a drag
  commit; auto-split matrix — intake and cross-grid split preview + commit
  (the full-grid→full-grid repro), atMin refusal, pref `refuse` restores
  the banded behavior, click safety, same-grid untouched.
- Rust: v8 config migrates with both fields `None`; zoom sync emits
  `window-maximized`; `restore_window` guarded like `minimize_window`.
