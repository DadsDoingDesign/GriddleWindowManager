// Task 4 — drag pipeline: preview on moveSizeStart, footprint + simulated
// ghosts on dragMoved (live grid must stay untouched), commit on moveSizeEnd
// (move / resize / cross-monitor transfer / drop-to-unmanage).

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

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const MON2_ID = '\\\\.\\DISPLAY2@1920,0';
const GRID1_ID = `grid:${MON1_ID}`;
const GRID2_ID = `grid:${MON2_ID}`;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: MON1_ID,
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
    ...overrides,
  };
}

function makeMonitor2(): MonitorInfo {
  return makeMonitor({
    id: MON2_ID,
    x: 1920,
    workX: 1920,
    primary: false,
  });
}

// Default window: 500×400 → 3×2 on a 12×6 grid, 1×1 on a 4×1 grid.
function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 500,
    height: 400,
    monitorId: MON1_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function makeGridSettings(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID1_ID,
    monitorIds: [MON1_ID],
    cols: 12,
    rows: 6,
    mode: 'push',
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
  mon2: MonitorInfo;
}

function harness(opts: { twoMonitors?: boolean } = {}): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
  });
  const mon = makeMonitor();
  const mon2 = makeMonitor2();
  brain.setMonitors(opts.twoMonitors ? [mon, mon2] : [mon]);
  return { brain, applies, snapshots, previews, mon, mon2 };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function gridTiles(snap: StateSnapshot, gridId: string = GRID1_ID) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return tiles!;
}

function slotsOverlap(a: { col: number; row: number; w: number; h: number }, b: typeof a): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

describe('moveSizeStart', () => {
  it('emits a visible preview with the current slot as footprint and no ghosts', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);

    brain.moveSizeStart('1');

    expect(previews).toHaveLength(1);
    expect(previews[0]).toEqual({
      gridId: GRID1_ID,
      visible: true,
      footprint: { col: 0, row: 0, w: 3, h: 2 },
      ghosts: [],
    });
  });

  it('emits nothing for an unmanaged hwnd', () => {
    const { brain, previews, applies } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);

    brain.moveSizeStart('999');
    brain.dragMoved({ hwnd: '999', cursorX: 500, cursorY: 500, x: 0, y: 48, width: 500, height: 400 });
    brain.moveSizeEnd('999', { x: 100, y: 100, width: 500, height: 400 });

    expect(previews).toHaveLength(0);
    expect(applies).toHaveLength(1); // only the enableGrid apply
  });
});

describe('dragMoved', () => {
  it('moves the footprint via slotFromCursor without touching the live grid', () => {
    const { brain, previews, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    const appliesBefore = applies.length;
    const snapsBefore = snapshots.length;

    brain.moveSizeStart('1');
    // Cursor at (1200, 564): 3×2 footprint centered there → {col:6,row:2}.
    brain.dragMoved({ hwnd: '1', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });

    const p = last(previews);
    expect(p.visible).toBe(true);
    expect(p.gridId).toBe(GRID1_ID);
    expect(p.footprint).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    expect(p.ghosts).toEqual([]);
    // no mutation of live state during drag
    expect(applies.length).toBe(appliesBefore);
    expect(snapshots.length).toBe(snapsBefore);
  });

  it('computes collision ghosts on a clone: same-footprint neighbor swaps in preview', () => {
    // 4×1 grid: A at col 0, B at col 1 (both 1×1). Dragging A over B's cell
    // triggers Griddle rule 2 (same-footprint swap) → ghost B 1→0.
    const { brain, previews, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [makeWindow('A'), makeWindow('B')]);

    brain.moveSizeStart('A');
    brain.dragMoved({ hwnd: 'A', cursorX: 720, cursorY: 564, x: 480, y: 48, width: 480, height: 1032 });

    const p = last(previews);
    expect(p.footprint).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(p.ghosts).toEqual([
      { hwnd: 'B', from: { col: 1, row: 0, w: 1, h: 1 }, to: { col: 0, row: 0, w: 1, h: 1 } },
    ]);
    // the live grid must be untouched: snapshot slots unchanged
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 1, row: 0, w: 1, h: 1 });
  });

  it('dropping back at the original spot proves the drag simulation never mutated the grid', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [makeWindow('A'), makeWindow('B')]);

    brain.moveSizeStart('A');
    // preview shows a swap ghost...
    brain.dragMoved({ hwnd: 'A', cursorX: 720, cursorY: 564, x: 480, y: 48, width: 480, height: 1032 });
    // ...but the user drops back at the original cell
    brain.moveSizeEnd('A', { x: 3, y: 50, width: 480, height: 1032 });

    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    // commit apply re-snaps only the dragged window; B never moved
    const commit = last(applies);
    expect(commit.moves.map((m) => m.hwnd)).toEqual(['A']);
    expect(commit.moves[0]).toEqual({ hwnd: 'A', x: 0, y: 48, width: 480, height: 1032 });
  });

  it('does not re-emit identical previews for repeated cursor positions in the same slot', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.moveSizeStart('1');
    brain.dragMoved({ hwnd: '1', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });
    const count = previews.length;
    brain.dragMoved({ hwnd: '1', cursorX: 1210, cursorY: 570, x: 970, y: 398, width: 480, height: 344 });
    expect(previews.length).toBe(count); // same slot → no new preview
  });
});

describe('moveSizeEnd — move commit', () => {
  it('moves the tile to the snapped slot with one apply and hides the preview', () => {
    const { brain, applies, previews, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);

    brain.moveSizeStart('1');
    brain.dragMoved({ hwnd: '1', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });
    brain.moveSizeEnd('1', { x: 960, y: 392, width: 480, height: 344 });

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toEqual([
      { hwnd: '1', ...cellRect(mon, { cols: 12, rows: 6 }, { col: 6, row: 2, w: 3, h: 2 }) },
    ]);
    expect(gridTiles(last(snapshots)).find((t) => t.hwnd === '1')!.slot).toEqual({
      col: 6,
      row: 2,
      w: 3,
      h: 2,
    });
    const p = last(previews);
    expect(p).toEqual({ gridId: GRID1_ID, visible: false, footprint: null, ghosts: [] });
  });

  it('emits the dragged window AND every displaced neighbor in one apply', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [makeWindow('A'), makeWindow('B')]);

    brain.moveSizeStart('A');
    brain.dragMoved({ hwnd: 'A', cursorX: 720, cursorY: 564, x: 480, y: 48, width: 480, height: 1032 });
    const previewGhostTo = { col: 0, row: 0, w: 1, h: 1 }; // rule-2 swap promised by preview
    brain.moveSizeEnd('A', { x: 480, y: 48, width: 480, height: 1032 });

    expect(applies).toHaveLength(2);
    const moves = applies[1]!.moves;
    expect(new Set(moves.map((m) => m.hwnd))).toEqual(new Set(['A', 'B']));
    expect(moves.find((m) => m.hwnd === 'A')).toEqual({ hwnd: 'A', x: 480, y: 48, width: 480, height: 1032 });
    expect(moves.find((m) => m.hwnd === 'B')).toEqual({ hwnd: 'B', x: 0, y: 48, width: 480, height: 1032 });

    const tiles = gridTiles(last(snapshots));
    const bSlot = tiles.find((t) => t.hwnd === 'B')!.slot;
    expect(bSlot).toEqual(previewGhostTo); // preview promised exactly this
  });

  it('snaps the window back when the target move is impossible', () => {
    // 3×1 grid: A (1×1) at col 0, B (2×1) at cols 1-2. Dropping A on col 1
    // leaves B no 2-cell span that avoids col 1 → every rule (and the BFS
    // repack) fails, the grid stays unchanged.
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 3, rows: 1 }), [
      makeWindow('A'), // 1×1 at col 0
      makeWindow('B', { width: 1200 }), // 2×1 at cols 1-2
    ]);
    expect(gridTiles(last(snapshots)).find((t) => t.hwnd === 'B')!.slot).toEqual({
      col: 1,
      row: 0,
      w: 2,
      h: 1,
    });

    brain.moveSizeStart('A');
    brain.moveSizeEnd('A', { x: 640, y: 48, width: 640, height: 1032 });

    // grid unchanged, dragged window re-snapped to its original rect
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'A')!.slot).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(tiles.find((t) => t.hwnd === 'B')!.slot).toEqual({ col: 1, row: 0, w: 2, h: 1 });
    const commit = last(applies);
    expect(commit.moves).toEqual([{ hwnd: 'A', x: 0, y: 48, width: 640, height: 1032 }]);
  });
});

describe('moveSizeEnd — commit matches the previewed footprint (WYSIWYG)', () => {
  it('commits the previewed cell for an off-center title-bar grab', () => {
    // 12×6 grid, 160×172 cells. Window 1 is 3×2 at (0,0). The user grabs the
    // title bar 20 px from the window's left edge and moves the window right
    // by 240 px: rect x=240 (rect-origin rounding would say col 2), cursor at
    // 260 (cursor-centered footprint says col 0). Preview and commit must
    // agree — the window lands in the cell the overlay highlighted.
    const { brain, previews, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { width: 480, height: 344 })]);

    brain.moveSizeStart('1');
    brain.dragMoved({ hwnd: '1', cursorX: 260, cursorY: 220, x: 240, y: 48, width: 480, height: 344 });
    const previewed = last(previews);
    expect(previewed.visible).toBe(true);
    expect(previewed.footprint).toEqual({ col: 0, row: 0, w: 3, h: 2 });

    brain.moveSizeEnd('1', { x: 240, y: 48, width: 480, height: 344 });

    const committed = gridTiles(last(snapshots)).find((t) => t.hwnd === '1')!.slot;
    expect(committed).toEqual(previewed.footprint);
  });

  it('extrapolates the cursor when the rect moved after the last drag-pos sample', () => {
    // Last sample previewed col 6; the final movesize-end rect is 160 px
    // further right (one cell) — the commit re-anchors on the extrapolated
    // cursor and lands one cell over, exactly where a preview at that
    // position would have been.
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { width: 480, height: 344 })]);

    brain.moveSizeStart('1');
    brain.dragMoved({ hwnd: '1', cursorX: 1200, cursorY: 564, x: 960, y: 392, width: 480, height: 344 });
    brain.moveSizeEnd('1', { x: 1120, y: 392, width: 480, height: 344 });

    const committed = gridTiles(last(snapshots)).find((t) => t.hwnd === '1')!.slot;
    expect(committed).toEqual({ col: 7, row: 2, w: 3, h: 2 });
  });

  it('commits the previewed target grid near a monitor seam', () => {
    // Cursor (and preview) on monitor 2, but the window rect's center is
    // still on monitor 1: the commit must follow the preview, not the rect.
    const h = harness({ twoMonitors: true });
    h.brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    h.brain.enableGrid(makeGridSettings({ id: GRID2_ID, monitorIds: [MON2_ID] }), []);

    h.brain.moveSizeStart('1');
    // Window mostly on MON1 (center x = 1900), cursor just across the seam.
    h.brain.dragMoved({ hwnd: '1', cursorX: 1930, cursorY: 392, x: 1660, y: 220, width: 480, height: 344 });
    const previewed = last(h.previews);
    expect(previewed.gridId).toBe(GRID2_ID);

    h.brain.moveSizeEnd('1', { x: 1660, y: 220, width: 480, height: 344 });

    const snap = last(h.snapshots);
    expect(gridTiles(snap, GRID1_ID)).toEqual([]);
    const tiles2 = gridTiles(snap, GRID2_ID);
    expect(tiles2.map((t) => t.hwnd)).toEqual(['1']);
    expect(tiles2[0]!.slot).toEqual(previewed.footprint);
  });
});

describe('moveSizeEnd — resize commit', () => {
  it('resizes to the snapped footprint and reflows neighbors', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    // 1 → (0,0,3,2), 2 → (3,0,3,2)

    brain.moveSizeStart('1');
    // grow to 6×4 keeping the origin: rect 960×688 at (0,48)
    brain.moveSizeEnd('1', { x: 0, y: 48, width: 960, height: 688 });

    expect(applies).toHaveLength(2);
    const moves = applies[1]!.moves;
    expect(new Set(moves.map((m) => m.hwnd))).toEqual(new Set(['1', '2']));
    expect(moves.find((m) => m.hwnd === '1')).toEqual({
      hwnd: '1',
      ...cellRect(mon, { cols: 12, rows: 6 }, { col: 0, row: 0, w: 6, h: 4 }),
    });

    const tiles = gridTiles(last(snapshots));
    const s1 = tiles.find((t) => t.hwnd === '1')!.slot;
    const s2 = tiles.find((t) => t.hwnd === '2')!.slot;
    expect(s1).toEqual({ col: 0, row: 0, w: 6, h: 4 });
    expect(slotsOverlap(s1, s2)).toBe(false);
    expect(s2.col + s2.w).toBeLessThanOrEqual(12);
    expect(s2.row + s2.h).toBeLessThanOrEqual(6);
  });

  it('handles a resize that also moves the origin (top-left handle)', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    // start (0,0,3,2); drag the SE corner window to (2,1) growing to 4×3:
    // rect at cell (2,1) origin = (320, 220), size 4×3 cells = 640×516
    brain.moveSizeStart('1');
    brain.moveSizeEnd('1', { x: 320, y: 220, width: 640, height: 516 });

    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === '1')!.slot).toEqual({ col: 2, row: 1, w: 4, h: 3 });
    expect(last(applies).moves).toEqual([
      { hwnd: '1', ...cellRect(mon, { cols: 12, rows: 6 }, { col: 2, row: 1, w: 4, h: 3 }) },
    ]);
  });
});

describe('moveSizeEnd — drop on an ungridded monitor', () => {
  it('removes the tile, emits no move, and forgets the window', () => {
    const { brain, applies, snapshots } = harness({ twoMonitors: true });
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    expect(applies).toHaveLength(1);

    brain.moveSizeStart('1');
    // rect centered on monitor 2 (no grid there)
    brain.moveSizeEnd('1', { x: 2400, y: 300, width: 500, height: 400 });

    expect(applies).toHaveLength(1); // window stays where the user dropped it
    const snap = last(snapshots);
    expect(gridTiles(snap).map((t) => t.hwnd)).toEqual(['2']);
    expect(snap.floating).toEqual([]);

    // forgotten: further events for it do nothing
    brain.moveSizeStart('1');
    brain.moveSizeEnd('1', { x: 0, y: 48, width: 500, height: 400 });
    expect(applies).toHaveLength(1);
  });
});

describe('moveSizeEnd — drop on a different gridded monitor', () => {
  function twoGridHarness() {
    const h = harness({ twoMonitors: true });
    h.brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    h.brain.enableGrid(
      makeGridSettings({ id: GRID2_ID, monitorIds: [MON2_ID] }),
      [],
    );
    return h;
  }

  it('transfers the tile to the target grid at the snapped slot', () => {
    const h = twoGridHarness();
    h.brain.moveSizeStart('1');
    h.brain.moveSizeEnd('1', { x: 2400, y: 220, width: 480, height: 344 });

    const snap = last(h.snapshots);
    expect(gridTiles(snap, GRID1_ID)).toEqual([]);
    const tiles2 = gridTiles(snap, GRID2_ID);
    expect(tiles2.map((t) => t.hwnd)).toEqual(['1']);
    expect(tiles2[0]!.slot).toEqual({ col: 3, row: 1, w: 3, h: 2 });
    expect(last(h.applies).moves).toEqual([
      { hwnd: '1', ...cellRect(h.mon2, { cols: 12, rows: 6 }, { col: 3, row: 1, w: 3, h: 2 }) },
    ]);
  });

  it('shows the preview on the target grid while the cursor crosses monitors', () => {
    const h = twoGridHarness();
    h.brain.moveSizeStart('1');
    h.brain.dragMoved({ hwnd: '1', cursorX: 500, cursorY: 400, x: 260, y: 228, width: 480, height: 344 });
    expect(last(h.previews).gridId).toBe(GRID1_ID);

    h.brain.dragMoved({ hwnd: '1', cursorX: 2640, cursorY: 392, x: 2400, y: 220, width: 480, height: 344 });

    // old grid hidden, new grid visible
    const hide = h.previews[h.previews.length - 2]!;
    expect(hide).toEqual({ gridId: GRID1_ID, visible: false, footprint: null, ghosts: [] });
    const show = last(h.previews);
    expect(show.gridId).toBe(GRID2_ID);
    expect(show.visible).toBe(true);
    expect(show.footprint).toEqual({ col: 3, row: 1, w: 3, h: 2 });
  });
});

describe('non-resizable (absolute) windows', () => {
  it('never produces ghosts and commits a single position-snap move keeping its size', () => {
    const { brain, applies, previews, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('R'), // resizable, in flow at (0,0,3,2)
      makeWindow('N', { x: 900, y: 500, resizable: false }),
    ]);

    brain.moveSizeStart('N');
    // drag N right over R's cells — absolute tiles displace nothing
    brain.dragMoved({ hwnd: 'N', cursorX: 240, cursorY: 220, x: 0, y: 48, width: 500, height: 400 });
    expect(last(previews).ghosts).toEqual([]);

    brain.moveSizeEnd('N', { x: 10, y: 60, width: 500, height: 400 });

    const commit = last(applies);
    // snapped to cell (0,0) origin, size untouched; R is NOT displaced
    expect(commit.moves).toEqual([{ hwnd: 'N', x: 0, y: 48, width: 500, height: 400 }]);
    const tiles = gridTiles(last(snapshots));
    expect(tiles.find((t) => t.hwnd === 'R')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(tiles.find((t) => t.hwnd === 'N')!.slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });
});
