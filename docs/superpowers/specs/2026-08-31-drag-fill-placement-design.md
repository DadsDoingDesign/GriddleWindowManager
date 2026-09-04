# Drag fill placement — Design Spec

**Date:** 2026-08-31
**Status:** Approved (user chose: snap-to-open-space on occupied hover; cross-grid
counts as new; largest-open-fit as the only fill strategy; global settings)

## 1. The gesture

Dragging a window onto a grid today gives it a footprint cut from its
physical size, wherever the cursor happens to be. As of this spec a window
that is **new to a grid** — a floating window taken in, or a tile crossing
from another grid — instead **fills the largest open rectangle** of free
cells, and the preview **snaps to that space** rather than tracking the
cursor cell-by-cell:

- Cursor over a **free** region: the largest open rectangle **containing
  the cursor's cell** wins — hovering a different open region retargets.
- Cursor over **occupied** cells (or anywhere else over the grid): the
  largest open rectangle **overall** wins. While the grid has usable open
  space, a drag can never displace tiles.
- Ties break by distance from the cursor's cell to the rectangle's center,
  then top-left (row, then col).
- The footprint never drops below the window's OS-minimum cells
  (`minCellsFor`) and never exceeds the grid.

**No open rectangle fits the window's minimum** → exactly the full-grid
flow that exists today: refusal message plus the Make-room / Swap bands,
with the victim still picked by cursor aim (the cursor-anchored footprint
computes as before for that path).

**Same-grid moves keep the tile's span** — the behavior that already ships
(`d.startSlot`). With the setting flipped to fill, a same-grid move fills
too; the dragged tile's own cells count as free (picking it up vacates its
slot), matching how `placementRefused` already ignores the dragged hwnd.

**Unchanged:** resize drags (rect snap), stack grids (overlap makes "open
space" meaningless), non-resizable windows (cannot be grown), app rules,
views, the reflow/push commit machinery, `placeWindow` auto-placement on
window-appear.

## 2. WYSIWYG

The policy lives inside `dragFootprint` — the one slot function preview and
commit already share — so the previewed slot and the committed slot cannot
disagree. No change to the preview/commit call sites' contract.

## 3. Settings (global, Preferences tab)

A "Placement" group with two rows:

- **Dropping a window onto a grid**: *Fill the open space* (default) /
  *Keep the window's size* (the pre-spec behavior).
- **Moving a tile within its grid**: *Keep the tile's size* (default) /
  *Fill the open space*.

## 4. Config

v8 adds two fields, both spelled as the two-value unions they are so a
future strategy has somewhere to live:

- `dropPlacement: 'fill' | 'size'` — default `'fill'`.
- `movePlacement: 'size' | 'fill'` — default `'size'`.

`persist.ts` defaults absent fields on load; the Rust `ipc.rs` mirror gains
the fields with serde defaults. Upgrading changes drop behavior by default —
that is the feature, and the setting is the escape hatch.

## 5. Structure

- New pure module `packages/brain/src/openspace.ts`: maximal-free-rectangle
  finder over a cell mask, plus the candidate-selection rule (cursor-region
  first, area, cursor distance, top-left). No brain imports beyond types.
- `dragFootprint` branches on drag kind (same-grid vs new-to-grid) and the
  two settings; everything downstream is untouched.

## 6. Tests (vitest, brain)

- openspace: masks → expected rectangles; cursor-in-region selection;
  min-size filtering; tie-breaks; full and empty grids.
- Behavior matrix over (intake / cross-grid / same-grid) ×
  (`dropPlacement`, `movePlacement`) × (cursor over free / occupied / full):
  footprint is the expected rectangle.
- Min-size floor respected; no-candidate falls through to refusal + bands.
- Stack grids and non-resizable windows keep the pre-spec footprint.
- Preview footprint equals commit slot for the new paths.
