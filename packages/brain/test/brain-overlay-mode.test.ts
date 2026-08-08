// Task 5 — overlay mode + toggle: overlay grids store tiles as Griddle
// `absolute` tiles (tiles may overlap, no displacement), drag previews have no
// ghosts, commits move only the dragged window, recency ordering puts the
// top-most window last in snapshots, and setMode converts between modes
// (overlay→collision re-adds by recency with displacement; collision→overlay
// converts in place with no moves).

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';
import { cellRect } from '../src/coords';

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const GRID_ID = `grid:${MON_ID}`;
const DIMS = { cols: 12, rows: 6 };

function makeMonitor(): MonitorInfo {
  return {
    id: MON_ID,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    workX: 0,
    workY: 48,
    workWidth: 1920,
    workHeight: 1032,
    dpi: 96,
    primary: true,
  };
}

// Default window: 500×400 at the work-area origin → 3×2 cells on a 12×6 grid.
function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 500,
    height: 400,
    monitorId: MON_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function makeGridSettings(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID_ID,
    monitorIds: [MON_ID],
    cols: 12,
    rows: 6,
    mode: 'overlay',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

interface Harness {
  brain: WindowManagerBrain;
  applies: ApplyLayout[];
  snapshots: StateSnapshot[];
  previews: PreviewState[];
  mon: MonitorInfo;
}

function harness(): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
  });
  const mon = makeMonitor();
  brain.setMonitors([mon]);
  return { brain, applies, snapshots, previews, mon };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function gridTiles(snap: StateSnapshot, gridId: string = GRID_ID) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return tiles!;
}

function slotsOverlap(a: { col: number; row: number; w: number; h: number }, b: typeof a): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

describe('overlay mode — placement', () => {
  it('places every window at its own snapped slot; overlapping windows both keep it', () => {
    const { brain, applies, snapshots, mon } = harness();
    // Both windows sit at the work-area origin → identical snapped slot.
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);

    expect(applies).toHaveLength(1);
    const rect = cellRect(mon, DIMS, { col: 0, row: 0, w: 3, h: 2 });
    expect(applies[0]!.moves).toEqual([
      { hwnd: 'A', ...rect },
      { hwnd: 'B', ...rect },
    ]);

    const tiles = gridTiles(last(snapshots));
    expect(tiles.map((t) => t.hwnd)).toEqual(['A', 'B']);
    expect(tiles[0]!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(tiles[1]!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 }); // overlap allowed
    expect(last(snapshots).floating).toEqual([]); // never floats — no "grid full"
  });

  it('windowAppeared over an occupied slot never displaces the sitting tenant', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    const appliesBefore = applies.length;

    brain.windowAppeared(makeWindow('B'));

    // one apply for B alone; A untouched
    expect(applies).toHaveLength(appliesBefore + 1);
    expect(last(applies).moves.map((m) => m.hwnd)).toEqual(['B']);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });
});

describe('overlay mode — drag pipeline', () => {
  it('previews the current slot on moveSizeStart and never emits ghosts while dragging', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);

    brain.moveSizeStart('A');
    expect(last(previews)).toEqual({
      gridId: GRID_ID,
      visible: true,
      footprint: { col: 0, row: 0, w: 3, h: 2 },
      ghosts: [],
    });

    // drag A right across B's cells — overlay mode: no reflow, no ghosts
    brain.dragMoved({ hwnd: 'A', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });
    const p = last(previews);
    expect(p.footprint).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    expect(p.ghosts).toEqual([]);
  });

  it('moveSizeEnd emits exactly one move: the dragged window snapped to cells', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    expect(applies).toHaveLength(1);

    brain.moveSizeStart('A');
    brain.moveSizeEnd('A', { x: 960, y: 392, width: 480, height: 344 });

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toEqual([
      { hwnd: 'A', ...cellRect(mon, DIMS, { col: 6, row: 2, w: 3, h: 2 }) },
    ]);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('dropping straight onto another tile overlaps it instead of displacing it', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('A'),
      makeWindow('B', { x: 480, y: 48 }), // slot (3,0,3,2)
    ]);
    expect(applies).toHaveLength(1);

    brain.moveSizeStart('A');
    brain.moveSizeEnd('A', { x: 480, y: 48, width: 480, height: 344 });

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toEqual([
      { hwnd: 'A', ...cellRect(mon, DIMS, { col: 3, row: 0, w: 3, h: 2 }) },
    ]);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 3, row: 0, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 3, row: 0, w: 3, h: 2 });
  });

  it('a resize drop snaps the tile footprint to cells (still one move)', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    expect(applies).toHaveLength(1);

    brain.moveSizeStart('A');
    // grow to 6×4 cells keeping the origin
    brain.moveSizeEnd('A', { x: 0, y: 48, width: 960, height: 688 });

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toEqual([
      { hwnd: 'A', ...cellRect(mon, DIMS, { col: 0, row: 0, w: 6, h: 4 }) },
    ]);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 6, h: 4 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('keeps a non-resizable window at its own size (position snap only)', () => {
    const { brain, applies } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('N', { resizable: false })]);

    const move = last(applies).moves.find((m) => m.hwnd === 'N')!;
    expect(move.width).toBe(500);
    expect(move.height).toBe(400);
    expect(move).toMatchObject({ x: 0, y: 48 });
  });
});

describe('overlay mode — recency ordering', () => {
  it('snapshot lists tiles bottom-to-top: the most recently interacted window last', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    expect(gridTiles(last(snapshots)).map((t) => t.hwnd)).toEqual(['A', 'B']);

    // dragging A brings it to the top → listed last
    brain.moveSizeStart('A');
    brain.moveSizeEnd('A', { x: 960, y: 392, width: 480, height: 344 });
    expect(gridTiles(last(snapshots)).map((t) => t.hwnd)).toEqual(['B', 'A']);

    // a new window is the newest of all
    brain.windowAppeared(makeWindow('C'));
    expect(gridTiles(last(snapshots)).map((t) => t.hwnd)).toEqual(['B', 'A', 'C']);
  });
});

describe("setMode('collision') on an overlay grid", () => {
  it('re-adds tiles by recency with displacement — most recent keeps its slot — in one apply', () => {
    const { brain, applies, snapshots } = harness();
    // A then B, both stacked on slot (0,0,3,2); B is more recent.
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    const appliesBefore = applies.length;

    brain.setMode(GRID_ID, 'collision');

    expect(applies).toHaveLength(appliesBefore + 1); // exactly one apply
    const tiles = gridTiles(last(snapshots));
    const a = tiles.find((t) => t.hwnd === 'A')!.slot;
    const b = tiles.find((t) => t.hwnd === 'B')!.slot;
    expect(b).toEqual({ col: 0, row: 0, w: 3, h: 2 }); // most recent kept its slot
    expect(slotsOverlap(a, b)).toBe(false);
    expect(a.col + a.w).toBeLessThanOrEqual(12);
    expect(a.row + a.h).toBeLessThanOrEqual(6);
    // only the displaced window needed a move
    expect(last(applies).moves.map((m) => m.hwnd)).toEqual(['A']);
    expect(last(snapshots).grids.find((g) => g.id === GRID_ID)!.mode).toBe('collision');
  });

  it('after conversion the grid behaves as collision: drags displace neighbors again', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    brain.setMode(GRID_ID, 'collision');

    // B holds (0,0,3,2); dragging A onto it must now produce a ghost
    brain.moveSizeStart('A');
    brain.dragMoved({ hwnd: 'A', cursorX: 240, cursorY: 220, x: 0, y: 48, width: 480, height: 344 });
    const p = last(previews);
    expect(p.footprint).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(p.ghosts.map((g) => g.hwnd)).toEqual(['B']);
  });

  it('marks windows floating when the collision grid cannot fit them all', () => {
    const { brain, snapshots } = harness();
    // 3×2 grid, three 3×2-cell windows stacked → collision mode fits only one.
    brain.enableGrid(makeGridSettings({ cols: 3, rows: 2 }), [
      makeWindow('A', { width: 1920, height: 1032 }),
      makeWindow('B', { width: 1920, height: 1032 }),
      makeWindow('C', { width: 1920, height: 1032 }),
    ]);

    brain.setMode(GRID_ID, 'collision');

    const snap = last(snapshots);
    const tiles = gridTiles(snap);
    expect(tiles.map((t) => t.hwnd)).toEqual(['C']); // most recent wins the slot
    expect(new Set(snap.floating.map((f) => f.hwnd))).toEqual(new Set(['A', 'B']));
  });
});

describe("setMode('overlay') on a collision grid", () => {
  it('converts in place: slots unchanged, zero moves emitted', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ mode: 'collision' }), [
      makeWindow('A'),
      makeWindow('B'), // first-fit → (3,0,3,2)
    ]);
    const appliesBefore = applies.length;

    brain.setMode(GRID_ID, 'overlay');

    expect(applies).toHaveLength(appliesBefore); // no moves
    const snap = last(snapshots);
    expect(snap.grids.find((g) => g.id === GRID_ID)!.mode).toBe('overlay');
    const tiles = gridTiles(snap);
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 3, row: 0, w: 3, h: 2 });
  });

  it('after conversion drags overlap freely: no ghosts, single-move commit', () => {
    const { brain, applies, previews, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings({ mode: 'collision' }), [makeWindow('A'), makeWindow('B')]);
    brain.setMode(GRID_ID, 'overlay');
    const appliesBefore = applies.length;

    // drag A onto B's slot (3,0,3,2)
    brain.moveSizeStart('A');
    brain.dragMoved({ hwnd: 'A', cursorX: 720, cursorY: 220, x: 480, y: 48, width: 480, height: 344 });
    expect(last(previews).ghosts).toEqual([]);
    brain.moveSizeEnd('A', { x: 480, y: 48, width: 480, height: 344 });

    expect(applies).toHaveLength(appliesBefore + 1);
    expect(last(applies).moves).toEqual([
      { hwnd: 'A', ...cellRect(mon, DIMS, { col: 3, row: 0, w: 3, h: 2 }) },
    ]);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 3, row: 0, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 3, row: 0, w: 3, h: 2 });
  });

  it('round-trips: overlay → collision → overlay keeps every window managed', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    brain.setMode(GRID_ID, 'collision');
    brain.setMode(GRID_ID, 'overlay');

    const snap = last(snapshots);
    expect(gridTiles(snap)).toHaveLength(2);
    expect(snap.floating).toEqual([]);
    expect(snap.grids.find((g) => g.id === GRID_ID)!.mode).toBe('overlay');
  });
});

describe('setMode — edges', () => {
  it('setting the current mode again is a no-op', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    const appliesBefore = applies.length;
    const snapsBefore = snapshots.length;

    brain.setMode(GRID_ID, 'overlay');

    expect(applies).toHaveLength(appliesBefore);
    expect(snapshots).toHaveLength(snapsBefore);
  });

  it('updates settings (and exportConfig) for a known but disabled grid without crashing', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.disableGrid(GRID_ID);

    brain.setMode(GRID_ID, 'collision');

    const cfg = brain.exportConfig();
    expect(cfg.grids.find((g) => g.id === GRID_ID)!.mode).toBe('collision');
  });

  it('ignores unknown grid ids', () => {
    const { brain, applies } = harness();
    brain.setMode('grid:nope', 'collision');
    expect(applies).toHaveLength(0);
  });

  it('cancels an in-progress drag on the converted grid', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.moveSizeStart('A');
    expect(last(previews).visible).toBe(true);

    brain.setMode(GRID_ID, 'collision');
    expect(previews.find((p) => !p.visible)).toBeDefined(); // preview hidden

    // the stale drag no longer commits anything
    const count = previews.length;
    brain.dragMoved({ hwnd: 'A', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });
    expect(previews).toHaveLength(count);
  });
});

describe('non-resizable windows in a collision grid (spec: always absolute)', () => {
  it('stays absolute and never appears in drag ghosts', () => {
    const { brain, previews, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ mode: 'collision' }), [
      makeWindow('R'), // in flow at (0,0,3,2)
      makeWindow('B', { x: 480, y: 48 }), // in flow at (3,0,3,2)
      makeWindow('N', { x: 480, y: 48, resizable: false }), // absolute over B
    ]);

    // drag R onto B/N's cells: B may ghost, N must not
    brain.moveSizeStart('R');
    brain.dragMoved({ hwnd: 'R', cursorX: 720, cursorY: 220, x: 480, y: 48, width: 480, height: 344 });
    const p = last(previews);
    expect(p.ghosts.length).toBeGreaterThan(0);
    expect(p.ghosts.every((g) => g.hwnd !== 'N')).toBe(true);

    // and setMode('overlay') keeps it managed
    brain.moveSizeEnd('R', { x: 0, y: 48, width: 480, height: 344 });
    brain.setMode(GRID_ID, 'overlay');
    expect(gridTiles(last(snapshots)).find((t) => t.hwnd === 'N')).toBeDefined();
  });
});
