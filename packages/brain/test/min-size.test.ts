// Spec 2026-08-20 (minimum window sizes): apps enforce minimum tracking
// sizes at the OS level (Electron's Discord most famously), so a window
// assigned a cell smaller than its minimum overflows the cell — Windows
// clamps the resize, not Griddle. Field report: "discord wont fit my thin
// column layout, its snapping but to a size bigger than the grid."
//
// The fix is to know before placing: WindowInfo carries minWidth/minHeight,
// and every footprint the brain computes is at least the cells that minimum
// needs — or the placement refuses with a message naming the real cause.

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
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots, previews };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

describe('minimum window sizes (spec 2026-08-20)', () => {
  it('placement grants at least the cells the minimum needs', () => {
    const h = harness();
    // 4x1 grid on 1920: cells are 480 wide. A window that is 400 wide now
    // but refuses to shrink below 900 needs 2 cells, not 1.
    h.brain.enableGrid(gridCfg(), [makeWindow('D', { minWidth: 900, minHeight: 200 })]);

    const tiles = last(h.snapshots).tiles[GRID1_ID]!;
    expect(tiles.find((t) => t.hwnd === 'D')!.slot.w).toBe(2);
  });

  it('a window without a minimum keeps its natural single cell', () => {
    const h = harness();
    h.brain.enableGrid(gridCfg(), [makeWindow('A')]);
    const tiles = last(h.snapshots).tiles[GRID1_ID]!;
    expect(tiles.find((t) => t.hwnd === 'A')!.slot.w).toBe(1);
  });

  it('a drag footprint grows to the minimum too', () => {
    const h = harness();
    h.brain.enableGrid(gridCfg(), [
      makeWindow('D', { minWidth: 900, minHeight: 200 }),
      makeWindow('A', { x: 960 }),
    ]);

    h.brain.moveSizeStart('D');
    h.brain.dragMoved({ hwnd: 'D', cursorX: 1200, cursorY: 500, x: 900, y: 60, width: 400, height: 400 });

    const p = last(h.previews);
    expect(p.footprint).not.toBeNull();
    expect(p.footprint!.w).toBeGreaterThanOrEqual(2);
  });

  it('a grid whose whole span cannot reach the minimum refuses and says why', () => {
    const h = harness();
    // 4x1 on 1920 = 480px cells; the entire grid is 1920 wide, so a
    // 3000px-minimum window can never fit — the refusal must name the
    // minimum, not claim the grid is full (it is empty).
    h.brain.enableGrid(gridCfg(), []);
    h.brain.windowAppeared(makeWindow('W', { minWidth: 3000, minHeight: 200 }));
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('W');

    h.brain.moveSizeStart('W');
    h.brain.dragMoved({ hwnd: 'W', cursorX: 900, cursorY: 500, x: 0, y: 60, width: 400, height: 400 });

    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.refusal).toMatch(/minimum/i);
  });

  it('make-room offers no pill when the donated half is below the minimum', () => {
    const h = harness();
    // 2x1 grid, A spans both cells; newcomer needs both cells (min 1500 on
    // 960px cells -> 2 cells). Splitting donates one cell — not enough, so
    // the pill must not be offered.
    h.brain.enableGrid(gridCfg({ cols: 2 }), [makeWindow('A', { width: 1900, height: 1000 })]);
    h.brain.windowAppeared(makeWindow('W', { minWidth: 1500, minHeight: 200 }));
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('W');

    h.brain.moveSizeStart('W');
    h.brain.dragMoved({ hwnd: 'W', cursorX: 400, cursorY: 500, x: 0, y: 60, width: 400, height: 400 });

    const p = last(h.previews);
    expect(p.refusal).toBeTruthy();
    expect(p.makeRoom).toBeUndefined();
  });
});
