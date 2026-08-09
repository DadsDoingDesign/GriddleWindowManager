// Task 13 — settings editor input: moveTileFromEditor places an existing
// tile at an exact slot (the editor's drop commits route here through the
// `settings-move` event). Same commit rules as a native drop: move / resize /
// displacement / pin update, clamped into the grid, one apply.

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

// Default window: 500×400 → 3×2 on a 12×6 grid.
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
    mode: 'collision',
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

function tileSlot(snap: StateSnapshot, hwnd: string) {
  const tile = (snap.tiles[GRID_ID] ?? []).find((t) => t.hwnd === hwnd);
  expect(tile).toBeDefined();
  return tile!.slot;
}

function slotsOverlap(
  a: { col: number; row: number; w: number; h: number },
  b: typeof a,
): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

function assertInBounds(applies: ApplyLayout[], mon: MonitorInfo) {
  for (const l of applies) {
    for (const m of l.moves) {
      expect(m.x).toBeGreaterThanOrEqual(mon.workX);
      expect(m.y).toBeGreaterThanOrEqual(mon.workY);
      expect(m.x + m.width).toBeLessThanOrEqual(mon.workX + mon.workWidth);
      expect(m.y + m.height).toBeLessThanOrEqual(mon.workY + mon.workHeight);
    }
  }
}

describe('moveTileFromEditor — collision mode', () => {
  it('moves a tile to a free slot and emits the exact cell rect', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    applies.length = 0;

    brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 2, w: 3, h: 2 });

    expect(tileSlot(last(snapshots), '1')).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    const apply = last(applies);
    const move = apply.moves.find((m) => m.hwnd === '1');
    expect(move).toBeDefined();
    const want = cellRect(mon, { cols: 12, rows: 6 }, { col: 6, row: 2, w: 3, h: 2 });
    expect(move).toEqual({ hwnd: '1', ...want });
    assertInBounds(applies, mon);
  });

  it('resizes a tile when the slot footprint differs', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    applies.length = 0;

    brain.moveTileFromEditor(GRID_ID, '1', { col: 0, row: 0, w: 6, h: 3 });

    expect(tileSlot(last(snapshots), '1')).toEqual({ col: 0, row: 0, w: 6, h: 3 });
    const move = last(applies).moves.find((m) => m.hwnd === '1');
    const want = cellRect(mon, { cols: 12, rows: 6 }, { col: 0, row: 0, w: 6, h: 3 });
    expect(move).toEqual({ hwnd: '1', ...want });
    assertInBounds(applies, mon);
  });

  it('displaces the sitting neighbor and keeps the grid overlap-free', () => {
    const { brain, applies, snapshots, mon } = harness();
    // Two 3×2 windows: '1' at (0,0), '2' first-fit right of it at (3,0).
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    applies.length = 0;

    // Drop '1' exactly onto '2'.
    brain.moveTileFromEditor(GRID_ID, '1', { col: 3, row: 0, w: 3, h: 2 });

    const snap = last(snapshots);
    const s1 = tileSlot(snap, '1');
    const s2 = tileSlot(snap, '2');
    expect(s1).toEqual({ col: 3, row: 0, w: 3, h: 2 });
    expect(slotsOverlap(s1, s2)).toBe(false);
    // Same-footprint drop is a swap (Griddle rule 2): both windows move.
    const apply = last(applies);
    expect(apply.moves.map((m) => m.hwnd).sort()).toEqual(['1', '2']);
    assertInBounds(applies, mon);
  });

  it('clamps an out-of-bounds slot into the grid', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);

    brain.moveTileFromEditor(GRID_ID, '1', { col: 11, row: 5, w: 3, h: 2 });

    expect(tileSlot(last(snapshots), '1')).toEqual({ col: 9, row: 4, w: 3, h: 2 });
  });

  it('is a no-op for unknown grids, unknown hwnds, and non-finite slots', () => {
    const { brain, applies } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    applies.length = 0;

    brain.moveTileFromEditor('grid:nope', '1', { col: 1, row: 1, w: 1, h: 1 });
    brain.moveTileFromEditor(GRID_ID, '999', { col: 1, row: 1, w: 1, h: 1 });
    brain.moveTileFromEditor(GRID_ID, '1', { col: Number.NaN, row: 0, w: 1, h: 1 });

    expect(applies).toEqual([]);
  });

  it('cancels an in-flight native drag of the same window (preview hidden)', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.moveSizeStart('1');
    expect(last(previews).visible).toBe(true);

    brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 2, w: 3, h: 2 });
    expect(last(previews).visible).toBe(false);

    // The native drop that eventually lands is ignored (drag was cancelled).
    const before = previews.length;
    brain.moveSizeEnd('1', { x: 0, y: 48, width: 500, height: 400 });
    expect(previews.length).toBe(before);
  });
});

describe('moveTileFromEditor — overlay mode & absolute tiles', () => {
  it('moves an overlay tile freely (overlap allowed) and emits only that window', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings({ mode: 'overlay' }), [
      makeWindow('1'),
      makeWindow('2', { x: 600, y: 400 }),
    ]);
    applies.length = 0;
    const s2Before = tileSlot(last(snapshots), '2');

    // Drop '1' right on top of '2'.
    brain.moveTileFromEditor(GRID_ID, '1', { col: s2Before.col, row: s2Before.row, w: 3, h: 2 });

    const snap = last(snapshots);
    expect(tileSlot(snap, '1').col).toBe(s2Before.col);
    expect(tileSlot(snap, '1').row).toBe(s2Before.row);
    expect(tileSlot(snap, '2')).toEqual(s2Before); // untouched
    expect(last(applies).moves.map((m) => m.hwnd)).toEqual(['1']);
    // The just-moved window is now top-most (listed last in overlay order).
    const order = snap.tiles[GRID_ID]!.map((t) => t.hwnd);
    expect(order[order.length - 1]).toBe('1');
    assertInBounds(applies, mon);
  });

  it('pins a non-resizable window (position snaps, size untouched)', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1', { resizable: false, width: 700, height: 500 }),
    ]);
    applies.length = 0;

    brain.moveTileFromEditor(GRID_ID, '1', { col: 4, row: 1, w: 3, h: 2 });

    const slot = tileSlot(last(snapshots), '1');
    expect(slot.col).toBe(4);
    expect(slot.row).toBe(1);
    const move = last(applies).moves.find((m) => m.hwnd === '1');
    expect(move).toBeDefined();
    // Non-resizable: the window keeps its own size.
    expect(move!.width).toBe(700);
    expect(move!.height).toBe(500);
    assertInBounds(applies, mon);
  });
});
