# @griddle/* library feedback

Discrepancies between what the Griddle WM plan/spec assumed and what the
installed packages (`@griddle/core` 0.1.11, `@griddle/svelte` 0.1.10) actually
export. Verified against `node_modules/@griddle/core/dist/*.d.ts` and
`node_modules/@griddle/svelte/dist/*.d.ts` (authoritative).

## Task 1 findings (2026-08-08)

- **`updateTile` does not exist.** Plan Task 4 says "tile resized
  (`updateTile`/remove+re-add with displacement)". The actual API is
  `Grid.resizeTile(id, {w,h}): boolean` (with cascade-push displacement built
  in) for footprint changes and `Grid.moveTile(id, {col,row})` for position.
  Adaptation: Task 4's resize path will use `resizeTile`, falling back to
  remove + `addTileWithDisplacement` only if `resizeTile` returns `false`.
- **`absolute` tiles DO exist** — plan risk note resolved. `Tile.position`
  supports `'absolute'`/`'fixed'` with `pinned {x,y}` coordinates, gated by
  `GridConfig.enablePositioning: true`. `pinUnits: 'cells'` lets overlay-mode
  tiles keep whole-cell coordinates. Note: `moveTile` is a documented no-op for
  out-of-flow tiles — overlay-mode moves must go through `setTilePinned`.
- **Displacement failures return `false`, they don't throw.** Plan Task 3
  says "if grid full (bounds error thrown by Griddle) → no apply". Reality:
  `addTileWithDisplacement`/`moveTile`/`resizeTile` return `false` and leave
  the grid unchanged. The brain should branch on the boolean, not catch.
- **Movement docs not vendored in the npm package.** `README.md` links to the
  repo's `docs/movement.md`; offline consumers only get the source comments
  (the package does ship `src/`, which mitigates this). Suggestion: include
  `docs/movement.md` in the published `files` list.
- Minor: `@griddle/svelte` `GriddleGrid.svelte.d.ts` types events as
  `CustomEvent<any>` for `dragStart`/`dragEnd`/`resizeStart`/`resizeEnd` —
  typed payloads would let the settings editor consume drop events without
  casting.

## Task 3 findings (2026-08-08)

- Confirmed in practice: the brain branches on `addTileWithDisplacement`'s
  boolean for the grid-full path (window marked floating, no apply) — no
  try/catch needed, as predicted above.
- `Grid.tilesIn` skipping out-of-flow tiles works well for the
  "non-resizable windows are always absolute" rule: in-flow first-fit
  placement transparently ignores them, no special-casing required.

## Task 4 findings (2026-08-08)

- **Clone-for-preview works as designed.** `Grid.fromJSON(grid.toJSON())`
  yields a fully independent clone (`toJSON` copies config and each tile), so
  running `moveTile`/`addTileWithDisplacement` on the clone and diffing slots
  gives drag ghosts without ever mutating the live grid. `loadJSON` was not
  needed — `fromJSON` is the more convenient cloning entry point.
- **Rule 2 (same-footprint swap) is a great fit for drag previews**: dragging
  a 1×1 tile onto an equal-size neighbor deterministically swaps, so the
  ghost preview and the commit agree exactly (asserted in tests).
- **Resize path**: as planned in Task 1 findings, `resizeTile` covers
  same-origin grows/shrinks; origin-changing resizes (top/left window edges)
  use remove + `addTileWithDisplacement`, restoring the original tile via
  `addTile` when displacement returns `false`. No `updateTile` needed.
- Minor: `Grid.removeTile(id)` on a missing id is a silent no-op (convenient
  for the cross-grid ghost simulation); worth documenting in the README.
