// Spec 2026-08-31 (second batch): a refused new-to-grid drop no longer dead-
// ends in "No room" — under the default `noRoomPlacement: 'split'` the aimed
// tile donates half its span automatically: the preview shows the outcome
// (donated footprint + victim ghost, no aiming band) and a release commits
// it. Covers intake AND managed cross-grid drags (the full-grid-to-full-grid
// field report). The Swap band stays for intake; `'refuse'` restores the
// banded behavior verbatim.

import { describe, expect, it } from 'vitest';
import {
  REFUSAL_MAKE_ROOM_ARMED,
  REFUSAL_NO_ROOM,
  WindowManagerBrain,
} from '../src/brain';
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

/** Grid2: 2x1 on MON2 — 960x1032 cells at x 1920. */
function grid2(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID2_ID,
    monitorIds: [MON2_ID],
    cols: 2,
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

function slotOf(snap: StateSnapshot, gridId: string, hwnd: string) {
  const t = snap.tiles[gridId]!.find((x) => x.hwnd === hwnd);
  expect(t).toBeDefined();
  return t!.slot;
}

/** Fill grid2 with A2 (whole 2x1 span), plus a floating B if asked. */
function fullGrid2(h: Harness, a2Overrides: Partial<WindowInfo> = {}): void {
  h.brain.enableGrid(grid2(), [
    makeWindow('A2', { monitorId: MON2_ID, x: 1920, ...a2Overrides }),
  ]);
  h.brain.moveTileFromEditor(GRID2_ID, 'A2', { col: 0, row: 0, w: 2, h: 1 });
}

function floatB(h: Harness, extra: Partial<WindowInfo> = {}): void {
  h.brain.enableGrid(grid1(), [
    makeWindow('A'),
    makeWindow('B', { x: 600, ...extra }),
  ]);
  expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');
}

// Cursor Y 100 sits above the band zone, so no band ever arms in these
// drags; X picks the aimed cell (col c center of the 2x1 grid on MON2).
const col = (c: number) => 1920 + c * 960 + 480;

describe("auto-split (default noRoomPlacement: 'split')", () => {
  it('an intake drop on a full grid splits the aimed tile where you aim', () => {
    const h = harness();
    fullGrid2(h);
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: col(1), cursorY: 100, x: 2900, y: 60, width: 500, height: 400 });

    const p = last(h.previews);
    expect(p.gridId).toBe(GRID2_ID);
    // WYSIWYG: the preview IS the outcome — donated right half as the
    // footprint, the victim's shrink as a ghost, no make-room band to aim.
    expect(p.footprint).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(p.ghosts).toEqual([
      { hwnd: 'A2', from: { col: 0, row: 0, w: 2, h: 1 }, to: { col: 0, row: 0, w: 1, h: 1 } },
    ]);
    expect(p.refusal).toBe(REFUSAL_MAKE_ROOM_ARMED);
    expect(p.makeRoom).toBeUndefined();

    h.brain.moveSizeEnd('B', { x: 2900, y: 60, width: 500, height: 400 });
    const snap = last(h.snapshots);
    expect(slotOf(snap, GRID2_ID, 'B')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, GRID2_ID, 'A2')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
  });

  it('the field report: a full-grid tile dragged onto a full grid — both shrink', () => {
    const h = harness();
    h.brain.enableGrid(grid1(), [makeWindow('A')]); // A fills grid1's 1x1
    fullGrid2(h);

    h.brain.moveSizeStart('A');
    // A's applied rect is grid1's whole work area; keeping it makes this a
    // move gesture. The 2-cell-wide footprint anchors at col 0.
    h.brain.dragMoved({ hwnd: 'A', cursorX: col(0), cursorY: 100, x: 2000, y: 60, width: 1920, height: 1032 });

    const p = last(h.previews);
    expect(p.footprint).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(p.refusal).toBe(REFUSAL_MAKE_ROOM_ARMED);
    expect(p.makeRoom).toBeUndefined();

    h.brain.moveSizeEnd('A', { x: 2000, y: 60, width: 1920, height: 1032 });
    const snap = last(h.snapshots);
    expect(slotOf(snap, GRID2_ID, 'A')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, GRID2_ID, 'A2')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(snap.tiles[GRID1_ID]!).toEqual([]);
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('A');
  });

  it('a victim at its minimum cannot donate — the refusal stands', () => {
    const h = harness();
    // A2's OS minimum needs both 960px cells; its kept half would collapse.
    fullGrid2(h, { minWidth: 1900 });
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: col(0), cursorY: 100, x: 2000, y: 60, width: 500, height: 400 });
    expect(last(h.previews).refusal).toBe(REFUSAL_NO_ROOM);

    h.brain.moveSizeEnd('B', { x: 2000, y: 60, width: 500, height: 400 });
    const snap = last(h.snapshots);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    expect(slotOf(snap, GRID2_ID, 'A2')).toEqual({ col: 0, row: 0, w: 2, h: 1 });
  });

  it('a click (no drag samples) never commits a split', () => {
    const h = harness();
    fullGrid2(h);
    floatB(h);

    // No dragMoved: the drop's fallback cursor is the rect center, on the
    // full grid — a stationary click-release must not split anything.
    h.brain.moveSizeStart('B');
    h.brain.moveSizeEnd('B', { x: 2000, y: 60, width: 500, height: 400 });

    const snap = last(h.snapshots);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    expect(slotOf(snap, GRID2_ID, 'A2')).toEqual({ col: 0, row: 0, w: 2, h: 1 });
  });

  it('same-grid moves keep their push semantics — no split', () => {
    const h = harness();
    h.brain.enableGrid(grid2(), [
      makeWindow('A2', { monitorId: MON2_ID, x: 1920 }),
      makeWindow('B2', { monitorId: MON2_ID, x: 2900 }),
    ]);
    h.brain.moveTileFromEditor(GRID2_ID, 'A2', { col: 0, row: 0, w: 1, h: 1 });
    h.brain.moveTileFromEditor(GRID2_ID, 'B2', { col: 1, row: 0, w: 1, h: 1 });

    h.brain.moveSizeStart('A2');
    h.brain.dragMoved({ hwnd: 'A2', cursorX: col(1), cursorY: 100, x: 2900, y: 60, width: 960, height: 1032 });
    expect(last(h.previews).refusal).toBeUndefined();
    h.brain.moveSizeEnd('A2', { x: 2900, y: 60, width: 960, height: 1032 });

    const snap = last(h.snapshots);
    expect(slotOf(snap, GRID2_ID, 'A2')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, GRID2_ID, 'B2')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });
});

describe("noRoomPlacement: 'refuse' keeps the banded behavior", () => {
  it('the refusal, the make-room band and the unarmed footprint are as shipped', () => {
    const h = harness({ noRoomPlacement: 'refuse' });
    fullGrid2(h);
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: col(0), cursorY: 100, x: 2000, y: 60, width: 500, height: 400 });

    const p = last(h.previews);
    expect(p.refusal).toBe(REFUSAL_NO_ROOM);
    expect(p.makeRoom).toBeDefined(); // the aiming band is back
    expect(p.footprint).toEqual({ col: 0, row: 0, w: 1, h: 1 }); // not donated

    h.brain.moveSizeEnd('B', { x: 2000, y: 60, width: 500, height: 400 });
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');
  });
});
