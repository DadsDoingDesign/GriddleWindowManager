# Griddle movement rules — offline notes

Source: `node_modules/@griddle/core/src/movement.ts` header comment (v0.1.11).
The canonical doc lives at the library repo (`docs/movement.md`), which is not
vendored in the npm package; the engine source ships in the package and is the
ground truth here.

## Rules 1-6 (as implemented by `Grid.moveTile`)

The engine mutates the grid in place during attempts but snapshots at each rule
boundary so it can roll back on failure. If every rule rejects the move (and
the BFS fallback can't repack), the original grid is restored and `moveTile`
returns `false`.

1. **Empty target** — drop straight in.
2. **Same-footprint swap** — adjacent partner with identical w×h: swap them.
3.-5. **Single-step displace** — push each overlapping victim by enough cells
   along a priority direction to clear the dragger's full footprint. Each
   victim is placed independently; if any victim has no legal slot the rule
   rejects and falls through.
6. **Cascade push** — push the victim AND any blockers it runs into along a
   priority direction. On infinite axes this loops until the target rect is
   clear (tiles slide off into space). On fixed grids the cascade may run out
   of room — the move falls through to the 0-1 BFS repack solver
   (`repack.ts`, bounded by `GridConfig.maxRepackHops`, default 64) as a last
   resort.

## Related behaviors relevant to Griddle Window Manager

- **Resize** (`Grid.resizeTile` → `displaceResizeOverlaps`): resize grows in
  place; overlapping neighbors are cascade-pushed away from the grown
  footprint (first direction points from the resized rect toward the first
  victim). Rolls back and returns `false` if no direction works.
- **Add with displacement** (`Grid.addTileWithDisplacement`): same push logic
  as resize; trims a footprint that crosses a finite positive edge; returns
  `false` (grid unchanged) if the origin is out of bounds or any victim cannot
  be placed. It does not throw.
- **Out-of-flow tiles** (`position: 'absolute' | 'fixed'`): skipped by
  `tilesIn`, never displaced, never displace others; `moveTile` is a no-op for
  them — use `setTilePinned`. This is the mechanism for overlay mode and for
  non-resizable windows.
- **Simulation for drag previews**: `toJSON()` → `Grid.fromJSON()` → run
  `moveTile` on the clone → diff tile rects against the original. `loadJSON`
  is atomic and rejects invalid snapshots, so cloning is safe.
- **Determinism**: priority directions are computed from the geometry
  (`priorityDirections(fromRect, targetRect)`), so identical inputs give
  identical layouts — good for the fuzz suite.
