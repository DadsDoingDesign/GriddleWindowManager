# Drag intake + spoken refusals — Design Spec

**Date:** 2026-08-20
**Status:** Approved (user chose "both" — intake and refusal messaging)

## 1. The core issue this fixes

Every complaint from the 2026-08-19/20 QA sessions is the same disease with a
different trigger:

| Report | Silent precondition that failed |
| --- | --- |
| "enabling a grid does nothing" | grid was on the windowless monitor |
| "dragging does nothing" | window was maximized |
| "some windows don't snap at all" | window elevated / never claimed |
| "I want a corner resize helper" | one tile had swallowed the whole grid |
| "I don't see any overlay now" | grids full → new windows float → floating drags ignored |

The drag gesture only responds when everything has already succeeded, so the
product's default failure mode is dead air. Two changes fix the root:

1. **Drag is an intake gesture.** Dragging *any* tracked window over a gridded
   monitor previews and, on drop, places it. Today `moveSizeStart` returns
   immediately unless the window already holds a tile (`brain.ts`), so a
   floating window can never re-enter a grid by dragging — the one gesture
   every user tries first.
2. **The overlay speaks on refusal.** When a drop cannot be placed (full
   push/reflow grid — the common case on a saturated desktop), the overlay
   says so at the drop point, in the moment. This applies to managed drags
   too, whose refused drops currently snap back without a word.

## 2. Scope

- **Brain (`packages/brain`)** — all logic. Rust is untouched: floating
  windows are already in the tracker's live eligible set, so
  `movesize-start` / `drag-pos` / `movesize-end` already flow; the brain
  currently discards them.
- **Overlay webview** — renders the new `refusal` field.
- **Brain host** — owns the refusal display timer (the brain stays clockless
  beyond its injected `now`).

## 3. Behaviour

### Intake drags

- `moveSizeStart(hwnd)` with no tile: if the brain knows the window (it is
  floating, or otherwise tracked-but-unmanaged), start a drag with
  `sourceGridId: null`. Unknown hwnds stay ignored.
- During the drag the overlay previews on whichever gridded monitor the
  cursor is over, exactly as managed cross-monitor drags already do. The
  footprint is the window's rect snapped to the grid's cells, cursor-anchored,
  so what is highlighted is what a drop commits (the existing WYSIWYG
  invariant).
- Drop on a gridded monitor: attempt placement under the grid's own mode —
  push displaces, reflow solves, stack always accepts. Success: the window
  becomes a tile (leaves `floating`), same flush/snapshot path as any
  placement. Refusal: the window stays floating exactly where dropped, and
  the overlay shows the refusal.
- Drop on an ungridded monitor or dead space: nothing happens, no message —
  the user did not aim at a grid.
- Excluded windows never reach the brain (the tracker filters them), so
  exclusions keep working with no special case.

### Refusals

- `PreviewState` gains `refusal: string | null`. The overlay renders it as a
  single centered line ("No room — this grid is full"). No buttons, no state.
- Emitted in two situations, for intake *and* managed drags alike:
  - live, while the previewed placement is impossible (footprint shown in the
    existing style, message alongside);
  - at a refused drop, after which the host hides the overlay on a ~1.5 s
    timer (cancelled by any newer preview event).

## 4. Implementation notes

- `DragState.sourceGridId` becomes `string | null`; `null` marks an intake
  drag. The commit path branches once: managed drops keep
  `commitSameGrid`/`commitTransfer`; intake drops run the same target/slot
  resolution and then the ordinary placement op (`addAtSlot` semantics per
  mode). No second placement implementation.
- The brain keeps a `WindowInfo` for floating windows (today `floating` maps
  hwnd → gridId only), maintained wherever `floating` is set/cleared, so an
  intake drop has real window metadata.
- Contract addition is one optional field on an existing event payload —
  no config-schema change, no new commands, no guard changes.

## 5. Tests (vitest, brain)

- Intake drag over a gridded monitor emits a visible preview.
- Intake drop on free cells: tile added, `floating` cleared, move applied.
- Intake drop on a full push grid: refused — still floating, `refusal`
  emitted, nothing moved.
- Stack mode accepts the same drop.
- Reflow with room places with minimal moves.
- Intake drop on an ungridded monitor: no-op, no refusal.
- Managed push drag whose drop is refused now carries `refusal` (previously
  silent snap-back).
- Existing drag suite stays green (regression gate).

## 6. Smoke additions

- Drag a floating window onto a gridded monitor: overlay appears, drop tiles
  it.
- Fill a push grid, drag another window onto it: overlay says the grid is
  full, window stays put where dropped.
