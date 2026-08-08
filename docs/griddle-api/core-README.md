# @griddle/core

Headless grid/canvas engine — pure TypeScript, **zero runtime dependencies**.

`@griddle/core` is the logic half of [Griddle](https://github.com/Trustybits/griddle):
tile placement, movement, swap/push resolution, compaction (gravity),
virtualization, loop/infinite-canvas math, and serialization. It has no
rendering and no framework ties, so you can run it anywhere — in a browser, on a
server, or behind one of the framework adapters.

## Install

```sh
npm install @griddle/core
```

## Usage

```ts
import { Grid } from '@griddle/core';

const grid = new Grid({ cols: 12, rows: 12, unitWidth: 75, unitHeight: 75 });

grid.addTile({ id: 't1', col: 0, row: 0, w: 2, h: 2 });
grid.moveTile('t1', { col: 4, row: 4 }); // resolves collisions via rules 1–6

const json = grid.toJSON(); // serialize
grid.loadJSON(json);        // restore
```

## Layout invariant

Ordinary in-flow tiles must always use positive integer footprints, remain
fully inside the configured grid, and never overlap. The constructor,
`addTile()`, `updateConfig()`, `reflow()`, and `loadJSON()` reject illegal
geometry without partially mutating the grid. Use
`addTileWithDisplacement()` when adding at an occupied position and you want
Griddle to move neighboring tiles into legal slots.

`absolute` and `fixed` tiles are intentionally out of flow, so they remain
exempt from grid-cell collision and containment checks.

## Adapter animation configuration

Core stores and normalizes the animation settings shared by the React, Vue,
and Svelte adapters. It remains headless and never accesses the DOM itself.

```ts
const grid = new Grid({
  cols: 12,
  rows: 12,
  unitWidth: 75,
  unitHeight: 75,
  animation: {
    enabled: true,
    repositionDurationMs: 320,
    repositionEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    liftDurationMs: 160,
    liftEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    respectReducedMotion: true,
  },
});
```

Set `enabled: false` to disable all adapter animations, or set an individual
duration to `0` to disable only that transition.

## Concepts

- **Unit** — a fixed `unitWidth × unitHeight` cell.
- **Grid** — `cols × rows`; either axis can be `Infinity` for an infinite canvas.
- **Tile** — an object at `(col, row)` with a `w × h` footprint.
- **Repack** — after a move, tiles resolve collisions via a deterministic ruleset.
- **Compaction** — optional gravity that backfills gaps toward a chosen edge.
- **Loop** — optional infinite-gallery mode with drag-to-pan physics.

## Framework adapters

Thin presentation layers built on this core:

- [`@griddle/react`](https://www.npmjs.com/package/@griddle/react)
- [`@griddle/vue`](https://www.npmjs.com/package/@griddle/vue)
- [`@griddle/svelte`](https://www.npmjs.com/package/@griddle/svelte)

See the full [movement ruleset](https://github.com/Trustybits/griddle/blob/master/docs/movement.md)
and [loop mode](https://github.com/Trustybits/griddle/blob/master/docs/loop.md)
docs, or the [main repository](https://github.com/Trustybits/griddle).

## License

MIT © Trustybits
