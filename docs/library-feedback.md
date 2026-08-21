# @griddle/* library feedback

Discrepancies between what the Griddle Window Manager plan/spec assumed and what the
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

## App-rules UI findings (2026-08-09, spec v0.2 §2)

- **`onTilePointerDown` ignores `e.button`**: `<GriddleGrid>` starts a tile
  drag (and calls `setPointerCapture`) for *any* pointer button, so a
  right-click meant for a context menu also picks the tile up. The settings
  editor works around it with a bubble-phase `pointerdown` handler on the
  slot content that `stopPropagation()`s every non-primary button before it
  reaches the library's handler. Suggestion: bail out of
  `onTilePointerDown` when `e.button !== 0` (matching how native drag
  interactions behave everywhere else).
- Related: `config.dragIgnoreFrom` (default `'a, button, input, …'`) only
  filters by *target selector*, not by button, so it cannot express "let
  right-clicks through" — a `dragButton`/button filter option would make
  custom context menus first-class.

## Placement-mode findings (2026-08-10, reflow mode)

- **No public "install this exact arrangement" op.** Reflow mode computes a
  whole-board arrangement with our own `solveMinimalMoves` and then has to get
  it into the `Grid`. Every mutator either runs the rules engine
  (`moveTile`/`resizeTile`/`addTileWithDisplacement` — they would second-guess
  a solution that is already collision-free) or is order-sensitive
  (`removeTile` + `addTile` per tile, which needs a manual lift-then-lay-down
  pass and reshuffles tile order). We settled on `snapshotTiles()` → mutate the
  returned `Map` → `restoreTiles()`, which is atomic, order-preserving and
  side-effect free — but it is documented as a snapshot/rollback pair, not as a
  bulk-apply API, and it skips `assertValidLayout`. A public
  `Grid.applyArrangement(moves, {validate: true})` (or simply documenting
  `restoreTiles` as the supported bulk path, with validation) would make this
  first-class instead of inferred.
- **`_setTilePos` / `_setTileRect` are exported in the `.d.ts`.** They are the
  obvious primitives for the above and are visible to consumers, but the
  leading underscore says "internal". Either hide them from the public types or
  bless one of them; right now a consumer has to guess.
- Not a gap, just a note: `isInFlow(tile)` is exactly the predicate the brain
  needed to decide which tiles a solve may move, and it being exported saved us
  from re-deriving the `absolute`/`fixed`/`sticky` rules. Keep it public.

## Minimap pop-out findings (2026-08-20)

- **`GridConfig.scroll` fails open, not closed.** `GriddleGrid.svelte` decides
  containment with `contained = cfg.scroll !== 'none'`. Because an omitted
  `scroll` is `undefined`, and `undefined !== 'none'`, leaving the option out
  silently opts the grid *into* an `overflow: auto` scroll box with
  `touch-action: none` and a fixed `height`. The library's own comment two
  lines above frames `'none'` as the mode where "the grid sizes to content and
  lets the host page own scrolling", which reads like the neutral default —
  but you only get it by asking for it by name.

  This cost us a visible defect: the settings grid editor sizes itself to the
  exact pixel from the monitor's aspect ratio and clips at its own border, so
  the inherited scroll box contributed nothing but a pair of Chromium
  scrollbars drawn over the map. Fixed app-side in `GridEditor.svelte` by
  passing `scroll: 'none'` explicitly.

  Suggested library fix: default the field (`cfg.scroll ?? 'none'`) so the
  neutral behaviour is what you get by not choosing, and make containment the
  thing a host opts into. If containment must stay the default for
  compatibility, the type should make `scroll` required rather than optional
  so the choice is at least deliberate at the call site.

  **Follow-up, same day:** taking `scroll: 'none'` also takes the `height`
  prop with it. `GriddleGrid` applies `style:height={contained ? heightCss :
  'auto'}`, so an uncontained grid ignores the `height` it was passed, and
  because its tiles are absolutely positioned it then has no content height
  either. In a flex column that box is free to be stretched — which made the
  editor's aspect ratio a function of the window's height rather than the
  monitor's, the one thing a minimap must never be. Worked around by pinning
  the height on our own wrapper with `flex: 0 0 auto`.

  Suggested fix: honour `height` in both modes. Containment is about who owns
  the scrolling; it should not also decide whether an explicit height means
  anything.

  **Retracted, same day.** Both of the above were my error, not the library's,
  and the record should say so. `scroll: 'none'` is not a scrollbar switch: it
  is the mode flag for the whole layout contract, and `contained` gates the
  explicit height, the clipping *and* the box the tile layout resolves
  against. Setting it to suppress two stray scrollbars took the tile
  positioning with it — tiles rendered off their cell boundaries at rest and
  drags looked askew. Reverted to the default contained mode; the scrollbars,
  which were a 1-2px overflow inside a wrapper that already clips, are hidden
  in CSS where a presentational problem belongs.

  The one fair note that survives: `scroll` reads like a display preference
  at the call site and is really a layout mode. A name closer to
  `containment` / `sizing`, or a doc line saying what else it governs, would
  make the trap visible. Nothing to fix in the code.

## FLIP origin ignores `pinned` (2026-08-20)

`GriddleGrid.svelte`'s `runFlip` computes every tile's origin in grid-flow
space:

```js
const x = t.col * colSize + halfGap;
const y = t.row * rowSize + halfGap;
```

But a tile with `position: 'absolute'` is *rendered* from `pinnedToPixels`
(`computeTileLayout`), which reads `tile.pinned`, not `tile.col/row`. Out-of-flow
tiles keep their `col/row` fields by design — `positioning.ts` says so
explicitly, "so they can fall back to in-flow if the user toggles position
back" — so for any absolute tile whose `pinned` has diverged from its
`col/row`, FLIP measures a delta against a position the tile was never drawn
at and animates it in from a bogus offset.

Reproduced in the settings grid editor, which mirrors overlapping snapshot
tiles as `absolute` (a non-resizable window the brain keeps pinned). After a
drag, the pinned tile slid in from roughly half a cell away while every
in-flow tile animated correctly. It settles at the right place — the resting
layout is exact — so it presents as "the tiles are offset after dragging"
rather than as a permanent misplacement, which made it hard to pin down.

Suggested fix: `runFlip` should use the same layout the renderer uses. Either
call `computeTileLayout` per tile, or branch on `isOutOfFlow(tile)` and read
`pinnedToPixels(tile.pinned, cfg)` for those. `prevRects` should store
whichever space the tile is actually drawn in.

**Correction after measuring.** I first blamed this for the "tiles are offset
after dragging" report and turned the reposition animation off. That did not
fix it — the offset persisted with `repositionDurationMs: 0` in the shipped
bundle. The FLIP-origin mismatch above is real as a *reading* of the source,
but I never confirmed it empirically, so treat it as unverified.

## Gesture offsets are cleared only by the next reposition (2026-08-20)

This is the one that was actually biting, measured rather than reasoned.

Tiles are positioned by `left`/`top` in whole cells, which is always correct.
On top of that the adapter layers pixel-space inline styles for gestures —
`style:transform` for the live drag, `node.style.translate` for FLIP. Both are
cleared only by the *next* reposition: `runFlip` skips `animateReposition`
entirely when a tile's delta computes to zero, and skips the dragger
unconditionally.

So after a drop there is no next reposition until something else moves, and
the tile keeps its gesture offset until then. In the settings editor that gap
is the round trip out to the window manager and back — the tile sat visibly
off-cell for 0-450ms after every drop.

Measured with a frame burst after a synthetic drag. Vertical tile edges
immediately after drop:

```
t=0..390ms   39, 110, 158, 229, 279, 398     <- two tiles +71px off-cell
t=520ms      39, 158, 278, 398               <- snapshot lands, corrected
```

A second drag with a different grab point and distance produced +46px instead
of +71px, confirming the offset tracks the gesture rather than the grid.

Suggested fix: clear the pixel-space styles unconditionally when a gesture
ends, rather than relying on a subsequent reposition to do it — the tile's
`left`/`top` is already correct at that point, so there is nothing to animate
from.

Worked around app-side by clearing `transform`/`translate` on
`[data-griddle-tile]` after `dragEnd`/`resizeEnd`.

## The adapter does not resync its tile list when a gesture ends (2026-08-20)

The one that actually produced "the windows look right but not the grid".

`GriddleGrid.svelte` keeps a local `tilesAll` copy for rendering. During a
drag it refreshes that copy from the engine explicitly, and says why:

```js
// restoreTiles() doesn't emit change events, so force-sync the local
// tile list so FLIP picks up displaced tile resets (e.g. drag back to
// the pickup cell).
if (result.changed) tilesAll = api.grid.tiles;
```

`onPointerUp` has no equivalent. It calls `dragController.end()` — which
repacks the engine, and on a rejected move calls `grid.restoreTiles(snapshot)`,
the very method the comment above notes is silent — and then dispatches
`dragEnd` without ever re-reading `api.grid.tiles`.

So once a gesture finishes, the rendered arrangement can be one repack behind
the engine. Observed in the settings grid editor as two tiles drawn stacked in
one cell with the neighbouring cell empty, while the real desktop was laid out
correctly. It resolves only when something else mutates the grid; in this app
that is the next snapshot from the window manager, measured at well over a
second.

Suggested fix: resync in `onPointerUp` the same way `onPointerMove` does,
after `dragController.end()` and before dispatching `dragEnd` — for the resize
branch too, which commits through `api.moveTile`/`api.resizeTile` and has the
same exposure.

Worked around app-side by rebuilding the tiles through `api` when a gesture
ends, which emits the change events the adapter does listen for.
