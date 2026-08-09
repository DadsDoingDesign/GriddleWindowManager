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

## Task 5 findings (2026-08-08)

- **`absolute` tiles confirmed sufficient for overlay mode** — the plan's
  fallback (brain-local out-of-flow tile tracking) was NOT needed. With
  `enablePositioning: true` + `pinUnits: 'cells'`, overlay-mode tiles live in
  the Grid as `position: 'absolute'` with `pinned {x: col, y: row}`:
  they overlap freely, `tilesIn` ignores them, and `setTilePinned` moves them
  without touching the rules engine. `setTilePosition(id, 'absolute',
  {pinned})` converts a collision grid to overlay strictly in place (zero
  geometry changes), and `setTilePosition` back to `'static'` was not even
  required — overlay→collision re-adds tiles anyway to run displacement.
- **No resize API for out-of-flow tiles.** `resizeTile` runs the in-flow
  rules engine and `setTilePinned` only updates coordinates; there is no
  documented way to change an absolute tile's `w`/`h` in place. Workaround
  (harmless, since absolute tiles never collide): `removeTile` + `addTile`
  with the new footprint. A `setTileSize(id, {w,h})` for out-of-flow tiles
  would be cleaner.
- **No z-order in the engine.** Overlay stacking ("top-most last") has no
  Griddle representation — absolute tiles have no z/stacking field — so the
  brain tracks a recency counter per hwnd and sorts overlay snapshots itself.
  Reasonable scope cut for a layout engine, but a `z?: number` field on
  out-of-flow tiles would have saved the bookkeeping.
## Task 6 findings (2026-08-08)

- **`Grid.reflow` cannot change row count.** The plan's `applyTemplate` says
  "template with different cols/rows → grid `reflow` first", but
  `ReflowOptions` is `{ cols, strategy: 'griddle-v1', placements? }` — columns
  only, no `rows`, and unit sizes must be adjusted separately via
  `updateConfig`. Adaptation: since every tile is re-placed at a template
  slot immediately afterwards anyway, the brain rebuilds the Grid at the
  template's dims (`new Grid({cols, rows, unitWidth, unitHeight, ...})`)
  instead of reflowing — observable behavior is identical. A
  `reflow({cols, rows})` overload (or `rows` in `ReflowOptions`) would let
  consumers restructure without a rebuild.

- **`addTileWithDisplacement` ordering nuance for "most recent wins".** The
  method displaces the *sitting* tiles and fails (returning false, grid
  unchanged) when a victim cannot be re-placed — so re-adding tiles
  newest-last does NOT guarantee the newest keeps its slot on a crowded grid
  (its own add is the one that fails). The brain instead re-adds newest
  *first* (it claims its slot outright) and places older tiles via
  own-slot-if-free → first-fit → displacement → floating.

## Task 7 findings (2026-08-08)

- **`Grid.loadJSON`/`fromJSON` throw on corrupt snapshots** (unsupported
  version, invalid layout), which is wrong for rehydrating from a possibly
  hand-edited or damaged config.json. The brain therefore validates stored
  `Grid.toJSON()` blobs itself (`persist.ts: extractLayoutTiles`) and re-adds
  tiles one by one instead of calling `fromJSON` on untrusted data — corrupt
  or missing entries just mean the grid starts empty. A non-throwing
  `Grid.tryFromJSON(): Grid | null` (or a documented validation helper)
  would make snapshot restore ergonomic.
- **`setTilePinned` accepts out-of-bounds pins.** Pinning an absolute tile
  near the right/bottom edge can leave `pinned.x + w > cols` with no error
  and no clamping — the fuzz suite caught the brain doing exactly that
  (a 5×6 absolute tile pinned at col 4 of an 8-col grid after a drag).
  The brain now clamps pins against the tile's footprint itself; a
  `clampToBounds` option (or documented behavior statement) on
  `setTilePinned` would prevent this class of bug for consumers.

## Task 17 findings (2026-08-09)

- **No way to mark cells as blocked/unusable.** Spanning grids need the dead
  space of an L-shaped monitor union excluded from layout, but Griddle has no
  "blocked cell" or immovable-obstacle concept: sentinel tiles won't work
  because the displacement engine happily pushes any in-flow tile (there is
  no `locked` flag), and `moveTile`/`resizeTile`/`addTileWithDisplacement`
  can shove victims into cells the consumer considers dead. Workaround: the
  brain keeps its own dead-cell mask, screens all direct placements against
  it, and runs every rules-engine op on a `Grid.fromJSON(grid.toJSON())`
  clone first, committing only when no in-flow tile lands on a dead cell
  (`runEngineOp` in brain.ts). A `blockedCells: CellPos[]` config option (or
  a `Tile.locked` the engine treats as terrain) would make this first-class.
- The clone-first pattern from Task 4 generalized nicely: the same
  clone+verify covers preview ghosts and commit validation, so preview and
  commit can never disagree about a rejected displacement.

## Task 13 findings (2026-08-08)

- **`<GriddleGrid>` works well as a mirror of external state**, with one
  caveat: the component commits drops into `api.grid` itself (via its
  internal `DragController` / `moveTile`), so a consumer whose source of
  truth lives elsewhere (our brain) must reconcile the editor grid against
  every authoritative snapshot after the `dragEnd` event. A "controlled"
  mode — preview locally, emit the proposed move, let the consumer commit —
  would avoid the transient divergence window.
- **`dragEnd`/`resizeEnd` payloads `{tileId, committed}` are exactly right**
  for commit-on-drop editors, but they are typed `CustomEvent<any>`
  (reiterating the Task 1 note) — the settings editor needs a cast to read
  them. Exporting the payload interfaces would fix this.
- **Dark themes need `:global` CSS surgery.** `.grid-bg` grid lines and the
  drop indicator use hardcoded light-theme rgba colors; the editor overrides
  them via `:global(.grid-bg)` etc. Exposing them as CSS custom properties
  (like `--griddle-tile-radius` already is) would make theming first-class.
- **Absolute-tile drags land unclamped.** The component's pin-drag path
  calls `setTilePinned` with whatever `pixelsToPin` rounds to, so a tile
  dropped past the right edge ends with `pinned.x + w > cols` (same
  unclamped-pin behavior as the Task 7 note, now reproduced through the
  Svelte adapter). The editor clamps before forwarding to the brain.
