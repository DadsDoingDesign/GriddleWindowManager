// Spec 2026-08-20 (make-room drop zone): a refused placement on a full grid
// offers a pill at the refused footprint — releasing inside it splits the
// tile the user is aiming at and gives the newcomer the donated half.

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
    width: 1900,
    height: 1000,
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
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots, previews };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

/** A (2x1-grid-filling) window A tiles; B floats. */
function floatBOverFullWideTile(h: Harness): void {
  // A is 1900px wide -> spans both columns of the 2x1 grid.
  h.brain.enableGrid(gridCfg(), [makeWindow('A'), makeWindow('B', { x: 5, width: 800, height: 700 })]);
  const snap = last(h.snapshots);
  expect(snap.tiles[GRID1_ID]!.map((t) => t.hwnd)).toEqual(['A']);
  expect(snap.tiles[GRID1_ID]![0]!.slot.w).toBe(2);
  expect(snap.floating.map((f) => f.hwnd)).toContain('B');
}

describe('make-room drop zone (spec 2026-08-20)', () => {
  it('offers the pill exactly when refused over a splittable victim', () => {
    const h = harness();
    floatBOverFullWideTile(h);

    h.brain.moveSizeStart('B');
    // Cursor over the left column, far from the pill center initially.
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });

    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.makeRoom).toBeDefined();
    expect(p.makeRoom!.width).toBeGreaterThan(0);
  });

  it('offers no pill when the victim is 1x1 — the plain refusal stands', () => {
    const h = harness();
    // 1x1 grid: A takes the only cell; the victim cannot donate.
    h.brain.enableGrid(gridCfg({ cols: 1 }), [makeWindow('A'), makeWindow('B', { x: 5, width: 800, height: 700 })]);
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 900, cursorY: 500, x: 5, y: 60, width: 800, height: 700 });

    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.makeRoom).toBeUndefined();
  });

  it('arms when the cursor enters the pill and disarms when it leaves', () => {
    const h = harness();
    floatBOverFullWideTile(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    const offered = last(h.previews).makeRoom!;
    const cx = offered.x + offered.width / 2;
    const cy = offered.y + offered.height / 2;

    h.brain.dragMoved({ hwnd: 'B', cursorX: cx, cursorY: cy, x: 5, y: 60, width: 800, height: 700 });
    expect(last(h.previews).makeRoom!.armed).toBe(true);

    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    expect(last(h.previews).makeRoom!.armed).toBe(false);
  });

  it('an armed preview ghosts the victim onto its kept half', () => {
    const h = harness();
    floatBOverFullWideTile(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    const offered = last(h.previews).makeRoom!;
    h.brain.dragMoved({
      hwnd: 'B',
      cursorX: offered.x + offered.width / 2,
      cursorY: offered.y + offered.height / 2,
      x: 5,
      y: 60,
      width: 800,
      height: 700,
    });

    const p = last(h.previews);
    expect(p.makeRoom!.armed).toBe(true);
    expect(p.ghosts.map((g) => g.hwnd)).toContain('A');
    // The victim keeps a 1-wide half of its former 2-wide span.
    const ghost = p.ghosts.find((g) => g.hwnd === 'A')!;
    expect(ghost.to.w).toBe(1);
  });

  it('an armed drop splits the victim and tiles the newcomer on the donated half', () => {
    const h = harness();
    floatBOverFullWideTile(h);
    const appliesBefore = h.applies.length;

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    const offered = last(h.previews).makeRoom!;
    const cx = offered.x + offered.width / 2;
    const cy = offered.y + offered.height / 2;
    h.brain.dragMoved({ hwnd: 'B', cursorX: cx, cursorY: cy, x: 5, y: 60, width: 800, height: 700 });
    // The drop rect matches the last sample (the window stopped where the
    // cursor is): the commit's cursor extrapolation then lands on the pill.
    h.brain.moveSizeEnd('B', { x: 5, y: 60, width: 800, height: 700 });

    const snap = last(h.snapshots);
    const tiles = snap.tiles[GRID1_ID]!;
    expect(tiles.map((t) => t.hwnd).sort()).toEqual(['A', 'B']);
    const a = tiles.find((t) => t.hwnd === 'A')!;
    const b = tiles.find((t) => t.hwnd === 'B')!;
    expect(a.slot.w).toBe(1);
    expect(b.slot.w).toBe(1);
    expect(a.slot.col).not.toBe(b.slot.col);
    expect(snap.floating.map((f) => f.hwnd)).not.toContain('B');
    expect(h.applies.length).toBeGreaterThan(appliesBefore);
  });

  it('an un-armed drop keeps the refusal: still floating, nothing split', () => {
    const h = harness();
    floatBOverFullWideTile(h);

    h.brain.moveSizeStart('B');
    h.brain.dragMoved({ hwnd: 'B', cursorX: 200, cursorY: 100, x: 5, y: 60, width: 800, height: 700 });
    h.brain.moveSizeEnd('B', { x: 5, y: 60, width: 800, height: 700 });

    const snap = last(h.snapshots);
    expect(snap.tiles[GRID1_ID]!.map((t) => t.hwnd)).toEqual(['A']);
    expect(snap.tiles[GRID1_ID]![0]!.slot.w).toBe(2);
    expect(snap.floating.map((f) => f.hwnd)).toContain('B');
    expect(last(h.previews).refusal).toBeTruthy();
  });
});
