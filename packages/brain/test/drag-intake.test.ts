// Spec 2026-08-20 (drag intake + spoken refusals): dragging a *floating*
// window over a gridded monitor previews and, on drop, places it — and when
// a placement is impossible, the overlay says so instead of dead air. Born
// from a QA session where saturated grids made every drag gesture silently
// inert (docs/superpowers/specs/2026-08-20-drag-intake-and-refusal-design.md).

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
    rows: 1,
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

function harness(): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
  });
  brain.setMonitors([makeMonitor(), makeMonitor2()]);
  return { brain, applies, snapshots, previews };
}

/** Grid1 is 1x1: A takes the only cell, B floats. */
function floatB(h: Harness, g2?: GridSettings): void {
  h.brain.enableGrid(grid1(), [makeWindow('A'), makeWindow('B', { x: 600 })]);
  if (g2) h.brain.enableGrid(g2, []);
  const snap = h.snapshots[h.snapshots.length - 1]!;
  expect(snap.floating.map((f) => f.hwnd)).toContain('B');
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

describe('intake drags (floating window)', () => {
  it('starting a drag on a floating window emits a visible preview', () => {
    const h = harness();
    floatB(h);
    const before = h.previews.length;

    h.brain.moveSizeStart('B');

    expect(h.previews.length).toBeGreaterThan(before);
    const p = last(h.previews);
    expect(p.visible).toBe(true);
    expect(p.gridId).toBe(GRID1_ID);
    // B hovers its own full 1x1 push grid: the placement is impossible and
    // the overlay must say so instead of showing a mute footprint.
    expect(p.refusal).toBeTruthy();
  });

  it('a drop on another grid with room places the window there', () => {
    const h = harness();
    floatB(h, grid2());
    const appliesBefore = h.applies.length;

    h.brain.moveSizeStart('B');
    // Cursor onto MON2's first cell (cells are 480 wide from x=1920).
    h.brain.dragMoved({ hwnd: 'B', cursorX: 2100, cursorY: 500, x: 1950, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 1950, y: 100, width: 500, height: 400 });

    const snap = last(h.snapshots);
    const tiles = snap.tiles[GRID2_ID]!;
    expect(tiles.map((t) => t.hwnd)).toContain('B');
    expect(tiles.find((t) => t.hwnd === 'B')!.slot.col).toBe(0);
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
    // The placement produced a real window move.
    expect(h.applies.length).toBeGreaterThan(appliesBefore);
  });

  it('a refused drop leaves the window floating and speaks', () => {
    const h = harness();
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 900, cursorY: 500, x: 700, y: 300, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 700, y: 300, width: 500, height: 400 });

    const snap = last(h.snapshots);
    expect(snap.tiles[GRID1_ID]!.map((t) => t.hwnd)).toEqual(['A']);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.visible).toBe(true);
  });

  it('a stack-mode grid accepts the same drop by overlapping', () => {
    const h = harness();
    floatB(h, grid2({ cols: 1, rows: 1, mode: 'stack' }));
    // Fill the stack grid so acceptance genuinely means overlap.
    h.brain.windowAppeared(makeWindow('C', { monitorId: MON2_ID, x: 1920 }));
    expect(last(h.snapshots).tiles[GRID2_ID]!.map((t) => t.hwnd)).toContain('C');

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 2400, cursorY: 500, x: 2100, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 2100, y: 100, width: 500, height: 400 });

    const snap = last(h.snapshots);
    const ids = snap.tiles[GRID2_ID]!.map((t) => t.hwnd);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
  });

  it('a reflow grid moves the incumbent aside and honours the aimed cell', () => {
    const h = harness();
    floatB(h, grid2({ mode: 'reflow' }));
    h.brain.windowAppeared(makeWindow('C', { monitorId: MON2_ID, x: 1920 }));
    const before = last(h.snapshots).tiles[GRID2_ID]!;
    expect(before.find((t) => t.hwnd === 'C')!.slot.col).toBe(0);

    // Aim B exactly at C's cell (col 0).
    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 2100, cursorY: 500, x: 1950, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 1950, y: 100, width: 500, height: 400 });

    const tiles = last(h.snapshots).tiles[GRID2_ID]!;
    expect(tiles.find((t) => t.hwnd === 'B')!.slot.col).toBe(0);
    expect(tiles.find((t) => t.hwnd === 'C')!.slot.col).not.toBe(0);
  });

  it('a drop on an ungridded monitor is a silent no-op', () => {
    const h = harness();
    floatB(h); // no grid on MON2
    const appliesBefore = h.applies.length;

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 2400, cursorY: 500, x: 2100, y: 100, width: 500, height: 400 });
    h.brain.moveSizeEnd('B', { x: 2100, y: 100, width: 500, height: 400 });

    const snap = last(h.snapshots);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    expect(snap.tiles[GRID1_ID]!.map((t) => t.hwnd)).toEqual(['A']);
    expect(h.applies.length).toBe(appliesBefore);
  });

  it('an hwnd the brain has never seen still starts nothing', () => {
    const h = harness();
    floatB(h);
    const previewsBefore = h.previews.length;

    h.brain.moveSizeStart('999');
    h.brain.dragMoved({ hwnd: '999', cursorX: 900, cursorY: 500, x: 700, y: 300, width: 500, height: 400 });
    h.brain.moveSizeEnd('999', { x: 700, y: 300, width: 500, height: 400 });

    expect(h.previews.length).toBe(previewsBefore);
  });
});

describe('managed drags speak on refusal too', () => {
  it('hovering an impossible cross-grid drop carries a refusal message', () => {
    const h = harness();
    // A managed on a roomy grid1; grid2 is a full 1x1 push grid.
    h.brain.enableGrid(grid1({ cols: 4, rows: 1 }), [makeWindow('A')]);
    h.brain.enableGrid(grid2({ cols: 1, rows: 1 }), []);
    h.brain.windowAppeared(makeWindow('C', { monitorId: MON2_ID, x: 1920 }));

    h.brain.moveSizeStart('A');
    h.brain.dragMoved({ hwnd: 'A', cursorX: 2400, cursorY: 500, x: 2100, y: 100, width: 500, height: 400 });

    const p = last(h.previews);
    expect(p.gridId).toBe(GRID2_ID);
    expect(p.visible).toBe(true);
    expect(p.refusal).toBeTruthy();
  });
});
