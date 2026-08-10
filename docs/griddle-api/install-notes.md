# Griddle install notes — actual API surface (authoritative: node_modules .d.ts)

Installed versions (2026-08-08):

- `@griddle/core` **0.1.11** — entry `dist/index.d.ts`
- `@griddle/svelte` **0.1.10** — entry `dist/index.d.ts`

These notes list the symbols that actually exist in the installed packages.
Where the plan/spec assumes an API, check here first.

## Key findings vs. the plan

- `absolute` tiles **exist**: `Tile.position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky'`
  plus `Tile.pinned {x,y}` (units per `GridConfig.pinUnits: 'pixels' | 'subcell' | 'cells'`).
  Requires `GridConfig.enablePositioning: true`, otherwise adapters render everything in flow.
- There is **no `updateTile`**. Use `Grid.resizeTile(id, {w,h})` for footprint changes,
  `Grid.moveTile(id, {col,row})` for in-flow moves, `Grid.setTilePinned(id, {x,y})` for
  out-of-flow moves, and `Grid.setTilePosition(id, position, opts)` to switch modes.
- `moveTile` is a **no-op for absolute/fixed tiles** (returns without engine run) — use
  `setTilePinned` for those (documented on `Grid.moveTile`).
- `addTileWithDisplacement(tile): boolean` exists; returns `false` and leaves the grid
  unchanged if the origin is out of bounds or any victim cannot be placed (no throw).
- Clone-for-simulation is supported: `grid.toJSON(): GridSnapshot` +
  `Grid.fromJSON(snap)` / `grid.loadJSON(snap)` (atomic, single `'load'` event), and also
  `snapshotTiles()` / `restoreTiles(snap)` for tiles-only rollback.
- `reflow(options: ReflowOptions): boolean` exists on both `Grid` and `GriddleApi`.
- `tilesIn(rect, exclude?)` skips out-of-flow tiles — overlay-mode tiles will not
  participate in collision queries, which matches our overlay-mode semantics.

## `@griddle/core` 0.1.11 — exported symbols (from `dist/index.d.ts`)

### Classes / values

| Symbol | From | Notes |
|---|---|---|
| `Grid` | grid.js | The engine. See method list below. |
| `reflowTiles` | reflow.js | Standalone reflow of a tile array. |
| `DEFAULT_ANIMATION_CONFIG`, `resolveAnimationConfig` | animation.js | |
| `DEFAULT_AUTO_SCROLL_CONFIG`, `resolveAutoScrollConfig`, `edgeScrollVelocity`, `edgeScrollDelta` | autoscroll.js | |
| `rectsOverlap`, `rectsAdjacent`, `rectContains`, `rectEquals`, `priorityDirections`, `faceClosestToOrigin`, `oppositeFace`, `classifyOrigin`, `translateRect`, `offsetRect`, `directionStep`, `tileRect`, `footprintEquals` | geometry.js | Pure cell-rect helpers; `tileRect(tile)` → `CellRect`. |
| `visibleRange`, `visibleTiles`, `gridContentSize` | virtualize.js | |
| `loopEnabled`, `loopInteraction`, `assertLoopable`, `wrapValue`, `wrapCell`, `loopBounds`, `loopPeriod`, `loopShift`, `loopInstances`, `resolveLoop` | loop.js | Loop mode (unused by Griddle Window Manager). |
| `PanController` | pan.js | |
| `Emitter` | events.js | `grid.changes` is an `Emitter<GridChangeEvent>`. |
| `DragController`, `GroupDragController` | drag.js / group-drag.js | Pointer-drag state machines (browser-side). |
| `isInFlow`, `isOutOfFlow`, `pinnedToPixels`, `pixelsToPin`, `offsetToPixels`, `pixelsToOffset`, `computeTileLayout`, `resolveStickyStacking` | positioning.js | CSS-like positioning helpers. |

### Types

`ReflowOptions`, `ReflowStrategy`, `AutoScrollConfig`, `CellPos`, `CellRect`, `Corner`,
`Direction8`, `Face`, `Footprint`, `Gravity`, `GridChangeEvent`, `GridAnimationConfig`,
`GridConfig`, `GridSnapshot`, `LoopConfig`, `LoopPhysicsConfig`, `StickyConfig`,
`StickyEdge`, `Tile`, `TilePosition`, `ResolvedGridAnimationConfig`, `EdgeBounds`,
`ScrollVelocity`, `ResolvedAutoScrollConfig`, `Viewport`, `VisibleRange`, `LoopBounds`,
`LoopPattern`, `LoopTileInstance`, `ResolvedLoop`, `CameraState`, `PanPhysicsOptions`,
`DragUpdateResult`, `GroupDragUpdateResult`, `TileLayout`, `TileLayoutInput`, `MoveOptions`
(movement.d.ts, not re-exported from index).

### `Grid` methods (grid.d.ts)

```
constructor(config: GridConfig, initialTiles?: Tile[])
updateConfig(patch: Partial<GridConfig>): void
reflow(options: ReflowOptions): boolean
get tiles(): Tile[]
getTile(id: string): Tile | undefined
tilesIn(rect: CellRect, exclude?: ReadonlySet<string>): Tile[]   // skips absolute/fixed
rectInBounds(rect: CellRect): boolean
addTile(tile: Tile): void
addTileWithDisplacement(tile: Tile): boolean                      // false = rejected, grid unchanged
removeTile(id: string): void
moveTile(id: string, target: CellPos): boolean                    // in-flow only; rules 1-6 + BFS
moveGroup(ids: string[], delta: {dcol, drow}): boolean
setTilePinned(id: string, pinned: {x, y}): boolean                // absolute/fixed only
setTilePosition(id, position, opts?: {pinned?, offset?, sticky?}): boolean
resizeTile(id: string, size: Footprint): boolean
snapshotTiles(): Map<string, Tile>
restoreTiles(snap: Map<string, Tile>): void
compactAll(): void
pack(): boolean
toJSON(): GridSnapshot
loadJSON(snap: GridSnapshot): void                                // atomic; rejects invalid snapshots
static fromJSON(snap: GridSnapshot): Grid
changes: Emitter<GridChangeEvent>
```

### Key type shapes (types.d.ts)

- `Tile extends CellPos, Footprint`: `id`, `data?`, `resizeHandles?`, `draggable?`,
  `resizable?`, `minW/minH/maxW/maxH?`, `position?: TilePosition`, `pinned? {x,y}`,
  `offset? {x,y}`, `sticky?: StickyConfig`.
- `GridConfig`: `cols`, `rows` (Infinity allowed), `unitWidth`, `unitHeight`,
  `infiniteX?`, `infiniteY?`, `gap?`, `gravity? ('none' default)`, `resizeHandles?`,
  `snapDuringDrag?`, `maxRepackHops? (64)`, `tileRadius?`, `enablePositioning?` (must be
  `true` for absolute tiles), `pinUnits?`, `relativeUnits?`, `dragIgnoreFrom?`,
  `scroll? ('container' | 'none')`, `autoScroll?`, `interactive?`, `animation?`, `loop?`.
- `GridSnapshot`: `{ version: 1; config: GridConfig; tiles: Tile[] }`.

### Other dist entry points (per-module summary)

| File | Contents |
|---|---|
| `animation.d.ts` | `DEFAULT_ANIMATION_CONFIG`, `resolveAnimationConfig`, `ResolvedGridAnimationConfig` |
| `autoscroll.d.ts` | Auto-scroll config resolution + edge velocity math |
| `compaction.d.ts` | Gravity compaction internals (`compactTiles` etc., not in index) |
| `drag.d.ts` | `DragController`, `DragUpdateResult` |
| `events.d.ts` | `Emitter<T>` (subscribe/emit) |
| `geometry.d.ts` | Cell-rect math listed above |
| `grid.d.ts` | `Grid` class |
| `group-drag.d.ts` | `GroupDragController` |
| `loop.d.ts` | Loop-mode math |
| `movement.d.ts` | `moveTile`, `displaceResizeOverlaps`, `MoveOptions` (engine internals; index re-exports only via `Grid`) |
| `packing.d.ts` / `repack.d.ts` | Dense packing + 0-1 BFS repack solver internals |
| `pan.d.ts` | `PanController`, `CameraState` |
| `positioning.d.ts` | in/out-of-flow helpers, pin/offset unit conversion, `computeTileLayout` |
| `reflow.d.ts` | `reflowTiles`, `ReflowOptions`, `ReflowStrategy` |
| `types.d.ts` | All shared types |
| `virtualize.d.ts` | Viewport culling helpers |

## `@griddle/svelte` 0.1.10 — exported symbols (from `dist/index.d.ts`)

| Symbol | Kind | Notes |
|---|---|---|
| `GriddleGrid` | Svelte component | Props: `api: GriddleApi`, `height?: number\|string`, `showGrid?: boolean`. Events: `dragStart`, `dragEnd`, `resizeStart`, `resizeEnd`, `cameraChange: CustomEvent<CameraState>`. Slot: `tile` with `{ tile: Tile }`. |
| `GriddleLoopGrid` | Svelte component | Loop-mode variant (`LoopGrid.svelte`). |
| `createGriddle` | function | `(init: UseGriddleInit) => GriddleApi`. |
| `GriddleApi` | type | `{ grid: Grid; tiles: Readable<Tile[]>; config: Readable<GridConfig>; version: Readable<number>; moveTile(id, {col,row}): boolean; resizeTile(id, {w,h}): boolean; addTile(t): void; removeTile(id): void; reflow(options): boolean; updateConfig(patch): void; toJSON(): GridSnapshot; loadJSON(snap): void; destroy(): void }` |
| `UseGriddleInit` | type | `{ config: GridConfig; tiles?: Tile[] }` |

`dist` entry points: `index.d.ts`, `griddleStore.d.ts` (`createGriddle`/`GriddleApi`/`UseGriddleInit`),
`GriddleGrid.svelte.d.ts`, `LoopGrid.svelte.d.ts`, `animation.d.ts` (adapter-side animation glue).

Peer deps (`@griddle/svelte` package.json): `svelte ^4 || ^5`, `@griddle/core`.
Both packages ship `src/` TypeScript alongside `dist/`, so implementation details
(e.g. movement rules) can be read offline under `node_modules/@griddle/core/src/`.
