// Spacing behavior of the brain (spec v0.2 §1): gap/padding flow from
// GridSettings through every emitted rect, setSpacing re-applies the whole
// grid in one batch, values are clamped into 0..64, and spacing survives the
// exportConfig round-trip.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { cellRect, effectiveSpacing } from '../src/coords';
import { parseConfig, serializeConfig } from '../src/persist';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const GRID_ID = `grid:${MON_ID}`;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
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
    ...overrides,
  };
}

// Default window: 500×400 → snaps to 3×2 on a 12×6 grid (also with gap 8 /
// padding 16, where the pitch is 158×168).
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
}

function harness(cfg?: AppConfig): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
    },
    cfg,
  );
  const mon = makeMonitor();
  brain.setMonitors([mon]);
  return { brain, applies, snapshots, previews, mon };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function lastMoves(applies: ApplyLayout[]): Map<string, { x: number; y: number; width: number; height: number }> {
  return new Map(
    last(applies).moves.map((m) => [m.hwnd, { x: m.x, y: m.y, width: m.width, height: m.height }]),
  );
}

const SPACED = { gap: 8, padding: 16 };
const SPACED_DIMS = { cols: 12, rows: 6, ...SPACED };

describe('placement with gap + padding', () => {
  it('emits rects matching cellRect on the padded, gapped grid', () => {
    const { brain, applies, mon } = harness();
    brain.enableGrid(makeGridSettings(SPACED), [makeWindow('1')]);
    const moves = lastMoves(applies);
    expect(moves.get('1')).toEqual(
      cellRect(mon, SPACED_DIMS, { col: 0, row: 0, w: 3, h: 2 }),
    );
    // Concretely: eff origin (16, 64), unit 150×160, footprint 3×2.
    expect(moves.get('1')).toEqual({ x: 16, y: 64, width: 466, height: 328 });
  });

  it('adjacent tiles land exactly gap pixels apart', () => {
    const { brain, applies } = harness();
    brain.enableGrid(makeGridSettings(SPACED), [makeWindow('1'), makeWindow('2')]);
    const moves = lastMoves(applies);
    const a = moves.get('1')!;
    const b = moves.get('2')!;
    expect(b.x - (a.x + a.width)).toBe(8);
  });

  it('keeps a non-resizable window inside the effective (padded) area', () => {
    const { brain, applies, mon } = harness();
    // 500×400 non-resizable window hugging the work-area corner: the cell
    // position snap must clamp its rect into the padded area, not just the
    // work area.
    brain.enableGrid(makeGridSettings({ ...SPACED, mode: 'stack' }), [
      makeWindow('N', { x: 1420, y: 632, resizable: false }),
    ]);
    const eff = effectiveSpacing(mon, SPACED_DIMS);
    const m = lastMoves(applies).get('N')!;
    expect(m.width).toBe(500);
    expect(m.height).toBe(400);
    expect(m.x).toBeGreaterThanOrEqual(eff.x);
    expect(m.y).toBeGreaterThanOrEqual(eff.y);
    expect(m.x + m.width).toBeLessThanOrEqual(eff.x + eff.width);
    expect(m.y + m.height).toBeLessThanOrEqual(eff.y + eff.height);
  });
});

describe('setSpacing', () => {
  it('re-applies every tile in one batch and reports the values in the snapshot', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    const appliesBefore = applies.length;

    brain.setSpacing(GRID_ID, 8, 16);

    expect(applies.length).toBe(appliesBefore + 1);
    const moves = lastMoves(applies);
    expect(moves.get('1')).toEqual(
      cellRect(mon, SPACED_DIMS, { col: 0, row: 0, w: 3, h: 2 }),
    );
    expect(moves.get('2')).toEqual(
      cellRect(mon, SPACED_DIMS, { col: 3, row: 0, w: 3, h: 2 }),
    );
    const grid = last(snapshots).grids.find((g) => g.id === GRID_ID)!;
    expect(grid.gap).toBe(8);
    expect(grid.padding).toBe(16);
  });

  it('clamps values into 0..64 (integers)', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.setSpacing(GRID_ID, 999, -7);
    const grid = last(snapshots).grids.find((g) => g.id === GRID_ID)!;
    expect(grid.gap).toBe(64);
    expect(grid.padding).toBe(0);
    brain.setSpacing(GRID_ID, 12.9, 3.2);
    const grid2 = last(snapshots).grids.find((g) => g.id === GRID_ID)!;
    expect(grid2.gap).toBe(12);
    expect(grid2.padding).toBe(3);
  });

  it('is a no-op when nothing changes (no apply, no snapshot)', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(SPACED), [makeWindow('1')]);
    const appliesBefore = applies.length;
    const snapshotsBefore = snapshots.length;
    brain.setSpacing(GRID_ID, 8, 16);
    expect(applies.length).toBe(appliesBefore);
    expect(snapshots.length).toBe(snapshotsBefore);
  });

  it('ignores unknown grids', () => {
    const { brain, applies, snapshots } = harness();
    const snapshotsBefore = snapshots.length;
    brain.setSpacing('grid:nope', 8, 8);
    expect(applies.length).toBe(0);
    expect(snapshots.length).toBe(snapshotsBefore);
  });

  it('updates a disabled grid\'s remembered settings without emitting moves', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.disableGrid(GRID_ID);
    const appliesBefore = applies.length;
    brain.setSpacing(GRID_ID, 10, 20);
    expect(applies.length).toBe(appliesBefore);
    const grid = last(snapshots).grids.find((g) => g.id === GRID_ID)!;
    expect(grid).toMatchObject({ enabled: false, gap: 10, padding: 20 });
    expect(brain.exportConfig().grids.find((g) => g.id === GRID_ID)).toMatchObject({
      gap: 10,
      padding: 20,
    });
  });

  it('cancels an in-flight drag on the grid (preview hidden)', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.moveSizeStart('1');
    expect(last(previews).visible).toBe(true);
    brain.setSpacing(GRID_ID, 8, 8);
    expect(last(previews).visible).toBe(false);
  });
});

describe('spacing persistence round-trip', () => {
  it('exportConfig → parse → new brain reproduces the same rects', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(SPACED), [makeWindow('1'), makeWindow('2')]);
    const rectsA = lastMoves(a.applies);

    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()));
    expect(cfg).not.toBeNull();
    expect(cfg!.grids[0]).toMatchObject({ gap: 8, padding: 16 });

    const b = harness(cfg!);
    // setMonitors in harness() revives the enabled grid; feed the windows
    // through a fresh sweep to restore the layout.
    b.brain.enableGrid(cfg!.grids[0]!, [makeWindow('1'), makeWindow('2')]);
    expect(lastMoves(b.applies)).toEqual(rectsA);
  });
});
