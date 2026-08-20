// Spec 2026-08-20 addendum (swap drop zone): beside "Make room", a second
// pill — "Swap" — minimizes the window occupying the aimed slot and places
// the dragged window there instead. Field request: "two hitboxes 'Make
// Room' & 'Swap'".

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import type {
  ApplyLayout,
  GridSettings,
  Hwnd,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const GRID1_ID = `grid:${MON1_ID}`;

function makeMonitor(): MonitorInfo {
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
  };
}

function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 400,
    height: 400,
    monitorId: MON1_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function gridCfg(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID1_ID,
    monitorIds: [MON1_ID],
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
  minimized: Hwnd[];
}

function harness(): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const minimized: Hwnd[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
    onMinimize: (h) => minimized.push(h),
  });
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots, previews, minimized };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

/** Full 2x1 grid (A spans both cells); B floats. */
function floatB(h: Harness): void {
  h.brain.enableGrid(gridCfg(), [
    makeWindow('A', { width: 1900, height: 1000 }),
    makeWindow('B', { x: 5, width: 800, height: 700 }),
  ]);
  expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');
}

describe('swap drop zone (spec 2026-08-20 addendum)', () => {
  it('offers both pills, with disjoint rects', () => {
    const h = harness();
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });

    const p = last(h.previews);
    expect(p.makeRoom).toBeDefined();
    expect(p.swap).toBeDefined();
    const mr = p.makeRoom!;
    const sw = p.swap!;
    const overlap =
      mr.x < sw.x + sw.width && sw.x < mr.x + mr.width && mr.y < sw.y + sw.height && sw.y < mr.y + mr.height;
    expect(overlap).toBe(false);
  });

  it('arming swap previews the victim slot and says swap', () => {
    const h = harness();
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    const sw = last(h.previews).swap!;
    h.brain.dragMoved({
      hwnd: 'B',
      cursorX: sw.x + sw.width / 2,
      cursorY: sw.y + sw.height / 2,
      x: 5,
      y: 60,
      width: 800,
      height: 700,
    });

    const p = last(h.previews);
    expect(p.swap!.armed).toBe(true);
    expect(p.refusal).toMatch(/swap/i);
    // The newcomer would take the victim's whole slot.
    expect(p.footprint).toEqual({ col: 0, row: 0, w: 2, h: 1 });
  });

  it('an armed swap drop minimizes the victim and takes its slot', () => {
    const h = harness();
    floatB(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    const sw = last(h.previews).swap!;
    h.brain.dragMoved({
      hwnd: 'B',
      cursorX: sw.x + sw.width / 2,
      cursorY: sw.y + sw.height / 2,
      x: 5,
      y: 60,
      width: 800,
      height: 700,
    });
    h.brain.moveSizeEnd('B', { x: 5, y: 60, width: 800, height: 700 });

    const snap = last(h.snapshots);
    const tiles = snap.tiles[GRID1_ID]!;
    expect(tiles.map((t) => t.hwnd)).toEqual(['B']);
    expect(tiles[0]!.slot).toEqual({ col: 0, row: 0, w: 2, h: 1 });
    expect(h.minimized).toEqual(['A']);
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
  });

  it('a 1x1 victim cannot make room but can still swap', () => {
    const h = harness();
    h.brain.enableGrid(gridCfg({ cols: 1 }), [
      makeWindow('A', { width: 1900, height: 1000 }),
      makeWindow('B', { x: 5, width: 800, height: 700 }),
    ]);
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 900, cursorY: 500, x: 5, y: 60, width: 800, height: 700 });

    const p = last(h.previews);
    expect(p.makeRoom).toBeUndefined();
    expect(p.swap).toBeDefined();
  });

  it('no swap pill when the victim slot is below the newcomer minimum', () => {
    const h = harness();
    // 4x1 grid, one window per cell -> full. Z floats with a 900px minimum
    // (2 of the 480px cells); swapping into any single 1-cell slot would
    // overflow, so swap must not be offered.
    h.brain.enableGrid(gridCfg({ cols: 4 }), [
      makeWindow('A'),
      makeWindow('C', { x: 500 }),
      makeWindow('E', { x: 1000 }),
      makeWindow('F', { x: 1500 }),
      makeWindow('Z', { x: 5, minWidth: 900, minHeight: 200 }),
    ]);
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('Z');

    h.brain.moveSizeStart('Z');
    h.brain.dragMoved({ hwnd: 'Z', cursorX: 200, cursorY: 500, x: 5, y: 60, width: 400, height: 400 });

    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.swap).toBeUndefined();
  });
});
