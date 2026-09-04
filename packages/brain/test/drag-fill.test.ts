// Spec 2026-08-31 (drag fill placement): a window NEW to a grid — floating
// intake or a cross-grid transfer — fills the largest open rectangle of free
// cells, snapping to the open space no matter where the cursor hovers,
// unless the cursor hovers a different open region (which wins). Same-grid
// moves keep the tile's span. Both are preferences (`dropPlacement`,
// `movePlacement`); `'size'` restores the pre-spec cursor-anchored behavior.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { defaultConfig } from '../src/persist';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const MON2_ID = '\\\\.\\DISPLAY2@1920,0';
const GRID1_ID = `grid:${MON1_ID}`;
const GRID2_ID = `grid:${MON2_ID}`;

// MON2 work area: x 1920..3840, y 48..1080 (1920x1032).
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
  return makeMonitor({ id: MON2_ID, x: 1920, workX: 1920, primary: false });
}

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

function grid1(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID1_ID,
    monitorIds: [MON1_ID],
    cols: 1,
    rows: 1,
    mode: 'push',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

function grid2(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID2_ID,
    monitorIds: [MON2_ID],
    cols: 4,
    rows: 2,
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
}

function harness(cfg?: Partial<AppConfig>): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
    },
    cfg ? { ...defaultConfig(), ...cfg } : undefined,
  );
  brain.setMonitors([makeMonitor(), makeMonitor2()]);
  return { brain, applies, snapshots, previews };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

/** Grid1 is 1x1: A takes the only cell, B floats (with `extra` overrides). */
function floatB(h: Harness, extra: Partial<WindowInfo> = {}): void {
  h.brain.enableGrid(grid1(), [
    makeWindow('A'),
    makeWindow('B', { x: 600, ...extra }),
  ]);
  const snap = last(h.snapshots);
  expect(snap.floating.map((f) => f.hwnd)).toContain('B');
}

/** Enable grid2 with window A2 pinned at an exact slot via the editor path. */
function setupGrid2(
  h: Harness,
  g: GridSettings,
  slot: { col: number; row: number; w: number; h: number },
): void {
  h.brain.enableGrid(g, [makeWindow('A2', { monitorId: MON2_ID, x: 1920 })]);
  h.brain.moveTileFromEditor(GRID2_ID, 'A2', slot);
  const tiles = last(h.snapshots).tiles[GRID2_ID]!;
  expect(tiles.find((t) => t.hwnd === 'A2')!.slot).toEqual(slot);
}

/** Cursor at the center of cell (col, row) of a cols x rows grid on MON2. */
function mon2Cursor(
  cols: number,
  rows: number,
  col: number,
  row: number,
): { x: number; y: number } {
  const cw = 1920 / cols;
  const ch = 1032 / rows;
  return { x: 1920 + col * cw + cw / 2, y: 48 + row * ch + ch / 2 };
}

function slotOf(snap: StateSnapshot, gridId: string, hwnd: string) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  const t = tiles!.find((x) => x.hwnd === hwnd);
  expect(t).toBeDefined();
  return t!.slot;
}

describe('drag fill: windows new to a grid (default dropPlacement: fill)', () => {
  it('an intake drop fills the largest open rectangle, and WYSIWYG holds', () => {
    const h = harness();
    setupGrid2(h, grid2(), { col: 0, row: 0, w: 2, h: 2 }); // left half taken
    floatB(h);

    h.brain.moveSizeStart('B');
    // Hover the OCCUPIED left half: the preview must still snap to the open
    // right half — dragging over tiles never displaces while space is open.
    const c = mon2Cursor(4, 2, 0, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c.x, cursorY: c.y, x: 2000, y: 100, width: 500, height: 400 });

    const p = last(h.previews);
    expect(p.gridId).toBe(GRID2_ID);
    expect(p.refusal).toBeUndefined();
    expect(p.footprint).toEqual({ col: 2, row: 0, w: 2, h: 2 });

    h.brain.moveSizeEnd('B', { x: 2000, y: 100, width: 500, height: 400 });
    const snap = last(h.snapshots);
    expect(slotOf(snap, GRID2_ID, 'B')).toEqual(p.footprint); // WYSIWYG
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
  });

  it('hovering a different open region retargets the fill there', () => {
    const h = harness();
    setupGrid2(h, grid2({ cols: 4, rows: 1 }), { col: 1, row: 0, w: 1, h: 1 });
    floatB(h);

    h.brain.moveSizeStart('B');
    // Over the occupied col 1: the biggest open region (cols 2-3) wins.
    const over = mon2Cursor(4, 1, 1, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: over.x, cursorY: over.y, x: 2000, y: 100, width: 500, height: 400 });
    expect(last(h.previews).footprint).toEqual({ col: 2, row: 0, w: 2, h: 1 });

    // Over the small open col 0: the hovered region wins over the bigger one.
    const c0 = mon2Cursor(4, 1, 0, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c0.x, cursorY: c0.y, x: 2000, y: 100, width: 500, height: 400 });
    expect(last(h.previews).footprint).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('a cross-grid transfer fills too — the tile is new to that grid', () => {
    const h = harness();
    h.brain.enableGrid(grid1({ cols: 4, rows: 1 }), [makeWindow('A')]);
    setupGrid2(h, grid2(), { col: 0, row: 0, w: 2, h: 2 });

    h.brain.moveSizeStart('A');
    // The rect keeps A's applied 1x1-cell size (480x1032 on grid1's 4x1) so
    // the gesture reads as a move, not a resize.
    const c = mon2Cursor(4, 2, 1, 1); // over the occupied left half
    h.brain.dragMoved({ hwnd: 'A', cursorX: c.x, cursorY: c.y, x: 2000, y: 100, width: 480, height: 1032 });
    h.brain.moveSizeEnd('A', { x: 2000, y: 100, width: 480, height: 1032 });

    const snap = last(h.snapshots);
    expect(slotOf(snap, GRID2_ID, 'A')).toEqual({ col: 2, row: 0, w: 2, h: 2 });
  });

  it("the fill never drops below the window's OS minimum cells", () => {
    const h = harness();
    setupGrid2(h, grid2({ cols: 4, rows: 1 }), { col: 1, row: 0, w: 1, h: 1 });
    // 480px cells; a 600px minimum needs 2 of them.
    floatB(h, { minWidth: 600 });

    h.brain.moveSizeStart('B');
    // Hovering the 1-wide open col 0, which cannot host the minimum: the
    // fitting region (cols 2-3) must win instead of a refusal.
    const c0 = mon2Cursor(4, 1, 0, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c0.x, cursorY: c0.y, x: 2000, y: 100, width: 500, height: 400 });
    expect(last(h.previews).footprint).toEqual({ col: 2, row: 0, w: 2, h: 1 });
    expect(last(h.previews).refusal).toBeUndefined();

    h.brain.moveSizeEnd('B', { x: 2000, y: 100, width: 500, height: 400 });
    expect(slotOf(last(h.snapshots), GRID2_ID, 'B')).toEqual({ col: 2, row: 0, w: 2, h: 1 });
  });

  it('no open rectangle fitting the minimum falls back to the refusal flow', () => {
    const h = harness();
    // 2x1 grid, 960px cells; A2 holds col 0. A 1000px minimum needs both
    // cells, so the single open cell cannot host it.
    setupGrid2(h, grid2({ cols: 2, rows: 1 }), { col: 0, row: 0, w: 1, h: 1 });
    floatB(h, { minWidth: 1000 });

    h.brain.moveSizeStart('B');
    // Band-free zone near the top of the work area (same spot the intake
    // refusal tests use), so the drop is a plain refusal, not an armed pill.
    h.brain.dragMoved({ hwnd: 'B', cursorX: 2900, cursorY: 100, x: 2700, y: 60, width: 500, height: 400 });
    expect(last(h.previews).refusal).toBeTruthy();

    h.brain.moveSizeEnd('B', { x: 2700, y: 60, width: 500, height: 400 });
    const snap = last(h.snapshots);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    expect(snap.tiles[GRID2_ID]!.map((t) => t.hwnd)).toEqual(['A2']);
  });

  it('a stack grid keeps the cursor-anchored footprint (overlap has no open space)', () => {
    const h = harness();
    h.brain.enableGrid(grid2({ cols: 4, rows: 1, mode: 'stack' }), [
      makeWindow('A2', { monitorId: MON2_ID, x: 1920 }),
    ]);
    floatB(h);

    h.brain.moveSizeStart('B');
    const c = mon2Cursor(4, 1, 2, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c.x, cursorY: c.y, x: 2000, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 2000, y: 100, width: 500, height: 400 });

    // A 500x400 window on 480x1032 cells snaps to 1x1 at the aimed cell.
    expect(slotOf(last(h.snapshots), GRID2_ID, 'B')).toEqual({ col: 2, row: 0, w: 1, h: 1 });
  });

  it('a non-resizable window keeps the cursor-anchored footprint (it cannot grow)', () => {
    const h = harness();
    // Non-resizable windows never float — they tile absolute — so build the
    // new-to-grid drag as a cross-grid transfer instead of an intake.
    h.brain.enableGrid(grid1(), [makeWindow('B', { resizable: false })]);
    setupGrid2(h, grid2(), { col: 0, row: 0, w: 2, h: 2 });

    h.brain.moveSizeStart('B');
    const c = mon2Cursor(4, 2, 3, 1);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c.x, cursorY: c.y, x: 3400, y: 700, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 3400, y: 700, width: 500, height: 400 });

    expect(slotOf(last(h.snapshots), GRID2_ID, 'B')).toEqual({ col: 3, row: 1, w: 1, h: 1 });
  });

  it("dropPlacement: 'size' restores the pre-spec window-size footprint", () => {
    const h = harness({ dropPlacement: 'size' });
    h.brain.enableGrid(grid2({ cols: 4, rows: 1 }), []);
    floatB(h);

    h.brain.moveSizeStart('B');
    const c = mon2Cursor(4, 1, 1, 0);
    h.brain.dragMoved({ hwnd: 'B', cursorX: c.x, cursorY: c.y, x: 2200, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 2200, y: 100, width: 500, height: 400 });

    // The empty 4x1 grid would fill whole under 'fill'; 'size' keeps the
    // 500x400 window a 1x1 tile at the aimed cell.
    expect(slotOf(last(h.snapshots), GRID2_ID, 'B')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
  });
});

describe('drag fill: same-grid moves (default movePlacement: size)', () => {
  function setupSameGrid(h: Harness): void {
    h.brain.enableGrid(grid2({ cols: 4, rows: 1 }), [
      makeWindow('A2', { monitorId: MON2_ID, x: 1920 }),
      makeWindow('B2', { monitorId: MON2_ID, x: 2000 }),
    ]);
    h.brain.moveTileFromEditor(GRID2_ID, 'A2', { col: 0, row: 0, w: 1, h: 1 });
    h.brain.moveTileFromEditor(GRID2_ID, 'B2', { col: 3, row: 0, w: 1, h: 1 });
  }

  it("keeps the tile's span by default — a size the user set is respected", () => {
    const h = harness();
    setupSameGrid(h);

    h.brain.moveSizeStart('A2');
    // Keep A2's applied 1x1-cell size (480x1032) so this is a move gesture.
    const c = mon2Cursor(4, 1, 2, 0);
    h.brain.dragMoved({ hwnd: 'A2', cursorX: c.x, cursorY: c.y, x: 2900, y: 100, width: 480, height: 1032 });
    h.brain.moveSizeEnd('A2', { x: 2900, y: 100, width: 480, height: 1032 });

    expect(slotOf(last(h.snapshots), GRID2_ID, 'A2')).toEqual({ col: 2, row: 0, w: 1, h: 1 });
  });

  it("movePlacement: 'fill' makes a same-grid move fill, vacating its own slot", () => {
    const h = harness({ movePlacement: 'fill' });
    setupSameGrid(h);

    h.brain.moveSizeStart('A2');
    // Keep A2's applied 1x1-cell size (480x1032) so this is a move gesture.
    const c = mon2Cursor(4, 1, 1, 0);
    h.brain.dragMoved({ hwnd: 'A2', cursorX: c.x, cursorY: c.y, x: 2400, y: 100, width: 480, height: 1032 });
    h.brain.moveSizeEnd('A2', { x: 2400, y: 100, width: 480, height: 1032 });

    // A2's own cell counts as free — picking it up vacates col 0 — so the
    // open space is cols 0-2 and the move fills all three.
    expect(slotOf(last(h.snapshots), GRID2_ID, 'A2')).toEqual({ col: 0, row: 0, w: 3, h: 1 });
  });

  it('a resize drag still snaps the dragged rect, never fills', () => {
    const h = harness({ movePlacement: 'fill' });
    setupSameGrid(h);

    h.brain.moveSizeStart('A2');
    // Width changed from the start rect: this is a resize gesture. Dragging
    // the right edge out to ~2 cells must yield 2 cells, not a 3-cell fill.
    h.brain.dragMoved({ hwnd: 'A2', cursorX: 2800, cursorY: 500, x: 1920, y: 48, width: 940, height: 1032 });
    h.brain.moveSizeEnd('A2', { x: 1920, y: 48, width: 940, height: 1032 });

    expect(slotOf(last(h.snapshots), GRID2_ID, 'A2')).toEqual({ col: 0, row: 0, w: 2, h: 1 });
  });
});
