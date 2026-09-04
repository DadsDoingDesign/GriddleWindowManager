// Spec 2026-08-31 (second batch): a maximize gesture on a tiled, resizable
// window expands its tile to the largest free rectangle containing its cells
// instead of OS-maximizing, toggling back on the next maximize. The brain
// releases the tile with the grown slot remembered, asks the shell to
// SW_RESTORE (`onRestore`), and the tracker's window-restored re-tiles it —
// the existing minimize/restore machinery, pointed at a different slot.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { defaultConfig } from '../src/persist';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  Hwnd,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

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

function grid(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID_ID,
    monitorIds: [MON_ID],
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
  restores: Hwnd[];
}

function harness(cfg?: Partial<AppConfig>): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const restores: Hwnd[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
      onRestore: (h) => restores.push(h),
    },
    cfg ? { ...defaultConfig(), ...cfg } : undefined,
  );
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots, previews, restores };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function slotOf(snap: StateSnapshot, hwnd: string) {
  const t = snap.tiles[GRID_ID]!.find((x) => x.hwnd === hwnd);
  expect(t).toBeDefined();
  return t!.slot;
}

/** A and B tiled 1x1 at cols 0 and 3 of the 4x1 grid. */
function setupCorners(h: Harness): void {
  h.brain.enableGrid(grid(), [makeWindow('A'), makeWindow('B', { x: 1500 })]);
  h.brain.moveTileFromEditor(GRID_ID, 'A', { col: 0, row: 0, w: 1, h: 1 });
  h.brain.moveTileFromEditor(GRID_ID, 'B', { col: 3, row: 0, w: 1, h: 1 });
}

describe('windowMaximized — expand (default maximizeBehavior)', () => {
  it('grows the tile to the largest containing rectangle via restore', () => {
    const h = harness();
    setupCorners(h);

    h.brain.windowMaximized('A');
    // The tile is released (never resized while OS-maximized) and the shell
    // is asked to un-maximize the window.
    expect(last(h.snapshots).tiles[GRID_ID]!.map((t) => t.hwnd)).toEqual(['B']);
    expect(h.restores).toEqual(['A']);

    // The tracker's unmaximize event re-tiles at the grown slot: cols 0-2.
    h.brain.windowRestored(makeWindow('A'));
    expect(slotOf(last(h.snapshots), 'A')).toEqual({ col: 0, row: 0, w: 3, h: 1 });
    expect(slotOf(last(h.snapshots), 'B')).toEqual({ col: 3, row: 0, w: 1, h: 1 });
  });

  it('a second maximize toggles back to the pre-expand slot', () => {
    const h = harness();
    setupCorners(h);
    h.brain.windowMaximized('A');
    h.brain.windowRestored(makeWindow('A'));

    h.brain.windowMaximized('A');
    h.brain.windowRestored(makeWindow('A'));
    expect(slotOf(last(h.snapshots), 'A')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('a boxed-in tile just un-maximizes back onto its own cells', () => {
    const h = harness();
    h.brain.enableGrid(grid(), [makeWindow('A'), makeWindow('B', { x: 1500 })]);
    h.brain.moveTileFromEditor(GRID_ID, 'A', { col: 0, row: 0, w: 1, h: 1 });
    h.brain.moveTileFromEditor(GRID_ID, 'B', { col: 1, row: 0, w: 3, h: 1 });

    h.brain.windowMaximized('A');
    expect(h.restores).toEqual(['A']);
    h.brain.windowRestored(makeWindow('A'));
    expect(slotOf(last(h.snapshots), 'A')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('another commit clears the toggle memory — the next maximize grows fresh', () => {
    const h = harness();
    setupCorners(h);
    h.brain.windowMaximized('A');
    h.brain.windowRestored(makeWindow('A')); // A now 3x1 at col 0

    // The editor squeezes A back down: toggle memory must not survive.
    h.brain.moveTileFromEditor(GRID_ID, 'A', { col: 1, row: 0, w: 1, h: 1 });

    h.brain.windowMaximized('A');
    h.brain.windowRestored(makeWindow('A'));
    // Grown around col 1, not returned to the stale pre-expand slot.
    expect(slotOf(last(h.snapshots), 'A')).toEqual({ col: 0, row: 0, w: 3, h: 1 });
  });
});

describe('windowMaximized — fallbacks keep the pre-spec behavior', () => {
  it("maximizeBehavior 'windows' releases the tile and leaves the window alone", () => {
    const h = harness({ maximizeBehavior: 'windows' });
    setupCorners(h);

    h.brain.windowMaximized('A');
    expect(h.restores).toEqual([]); // never un-maximizes the user's window
    expect(last(h.snapshots).tiles[GRID_ID]!.map((t) => t.hwnd)).toEqual(['B']);

    // Un-maximizing by hand returns it to its own slot, as always.
    h.brain.windowRestored(makeWindow('A'));
    expect(slotOf(last(h.snapshots), 'A')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('a floating window maximizing is left alone', () => {
    const h = harness();
    // 1x1 grid: A takes it, B floats.
    h.brain.enableGrid(grid({ cols: 1, rows: 1 }), [
      makeWindow('A'),
      makeWindow('B', { x: 600 }),
    ]);
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toContain('B');

    h.brain.windowMaximized('B');
    expect(h.restores).toEqual([]);
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).not.toContain('B');
  });

  it('a non-resizable tile cannot expand — release and leave alone', () => {
    const h = harness();
    h.brain.enableGrid(grid(), [makeWindow('A', { resizable: false })]);

    h.brain.windowMaximized('A');
    expect(h.restores).toEqual([]);
    expect(last(h.snapshots).tiles[GRID_ID]!).toEqual([]);
  });

  it('an unknown hwnd is ignored', () => {
    const h = harness();
    setupCorners(h);
    const before = h.snapshots.length;
    h.brain.windowMaximized('999');
    expect(h.restores).toEqual([]);
    expect(h.snapshots.length).toBe(before);
  });
});
