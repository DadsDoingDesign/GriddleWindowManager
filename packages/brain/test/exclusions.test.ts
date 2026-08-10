// Plan Task 19 — contract C3 extension `setExclusions`: the exclusions
// editor's live path. Adding an exe unmanages its windows immediately (tiles
// removed, no moves emitted — the windows stay where they are); removing one
// re-manages nothing by itself (windows come back through the host's normal
// window-appeared flow); the list normalizes, persists, and rides the
// snapshot so the settings UI always shows the truth.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain, defaultConfig } from '../src';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src';

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

function makeWindow(hwnd: string, exe: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe,
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

function harness(cfg?: AppConfig) {
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
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots, previews };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

describe('setExclusions (contract C3 extension, Task 19)', () => {
  it('normalizes entries (trim, lowercase, dedupe, drop empties) into config and snapshot', () => {
    const { brain, snapshots } = harness();
    brain.setExclusions(['  Slack.EXE ', 'FIGMA.exe', 'slack.exe', '', '   ']);
    expect(brain.exportConfig().exclusions).toEqual(['slack.exe', 'figma.exe']);
    expect(last(snapshots).exclusions).toEqual(['slack.exe', 'figma.exe']);
  });

  it('is a no-op (no snapshot) when the normalized list is unchanged', () => {
    const { brain, snapshots } = harness();
    brain.setExclusions(['slack.exe']);
    const count = snapshots.length;
    brain.setExclusions(['SLACK.exe', 'slack.exe ']);
    expect(snapshots.length).toBe(count);
  });

  it('unmanages tiled windows of a newly excluded exe without emitting any move', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1', 'slack.exe'),
      makeWindow('2', 'code.exe'),
    ]);
    const appliesBefore = applies.length;

    brain.setExclusions(['slack.exe']);

    // No move for the excluded window (it stays where it is) and no
    // neighbor reflow either.
    expect(applies.length).toBe(appliesBefore);
    const snap = last(snapshots);
    const tiles = snap.tiles[GRID_ID]!;
    expect(tiles.map((t) => t.hwnd)).toEqual(['2']);
    expect(snap.exclusions).toEqual(['slack.exe']);
  });

  it('drops floating and minimized-remembered windows of an excluded exe', () => {
    const { brain, snapshots } = harness();
    // 1×1 grid: first window fills it, the second floats.
    brain.enableGrid(makeGridSettings({ cols: 1, rows: 1 }), [
      makeWindow('1', 'code.exe', { width: 1920, height: 1032 }),
      makeWindow('2', 'slack.exe', { width: 1920, height: 1032 }),
    ]);
    expect(last(snapshots).floating.map((f) => f.hwnd)).toEqual(['2']);

    // Minimize the tiled one so it is remembered, then exclude both exes.
    brain.windowMinimized('1');
    brain.setExclusions(['slack.exe', 'code.exe']);

    const snap = last(snapshots);
    expect(snap.floating).toEqual([]);
    expect(snap.tiles[GRID_ID]).toEqual([]);

    // Restore of the excluded window must not re-manage it.
    brain.windowRestored(makeWindow('1', 'code.exe', { width: 1920, height: 1032 }));
    expect(last(snapshots).tiles[GRID_ID]).toEqual([]);
  });

  it('cancels an in-flight drag of a window that just became excluded', () => {
    const { brain, previews } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', 'slack.exe')]);
    brain.moveSizeStart('1');
    expect(last(previews).visible).toBe(true);

    brain.setExclusions(['slack.exe']);
    expect(last(previews).visible).toBe(false);

    // A stale movesize-end for the cancelled drag is ignored.
    brain.moveSizeEnd('1', { x: 700, y: 300, width: 500, height: 400 });
    expect(last(previews).visible).toBe(false);
  });

  it('windows of a removed exclusion are managed again via window-appeared', () => {
    const cfg = { ...defaultConfig(), exclusions: ['slack.exe'] };
    const { brain, snapshots } = harness(cfg);
    brain.enableGrid(makeGridSettings(), [makeWindow('2', 'code.exe')]);

    // Excluded: appearing does nothing.
    brain.windowAppeared(makeWindow('1', 'slack.exe'));
    expect(last(snapshots).tiles[GRID_ID]!.map((t) => t.hwnd)).toEqual(['2']);

    // Un-exclude, then the tracker's resync re-announces the window.
    brain.setExclusions([]);
    brain.windowAppeared(makeWindow('1', 'slack.exe'));
    expect(last(snapshots).tiles[GRID_ID]!.map((t) => t.hwnd).sort()).toEqual(['1', '2']);
  });

  it('windows on unaffected grids and exes stay exactly where they are', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1', 'code.exe'),
      makeWindow('2', 'notepad.exe'),
      makeWindow('3', 'slack.exe'),
    ]);
    const tilesBefore = last(snapshots).tiles[GRID_ID]!;
    const slotOf = (hwnd: string) => tilesBefore.find((t) => t.hwnd === hwnd)!.slot;

    brain.setExclusions(['slack.exe']);
    const tilesAfter = last(snapshots).tiles[GRID_ID]!;
    expect(tilesAfter.map((t) => t.hwnd).sort()).toEqual(['1', '2']);
    for (const t of tilesAfter) {
      expect(t.slot).toEqual(slotOf(t.hwnd));
    }
  });

  it('round-trips through a config reload', () => {
    const { brain } = harness();
    brain.setExclusions(['slack.exe', 'figma.exe']);
    const { brain: reloaded } = harness(brain.exportConfig());
    expect(reloaded.exportConfig().exclusions).toEqual(['slack.exe', 'figma.exe']);
    // And a reloaded brain still refuses excluded windows.
    reloaded.enableGrid(makeGridSettings(), [makeWindow('1', 'slack.exe')]);
    expect(reloaded.exportConfig().exclusions).toContain('slack.exe');
  });

  it('every snapshot carries the exclusion list (empty by default)', () => {
    const { brain, snapshots } = harness();
    expect(last(snapshots).exclusions).toEqual([]);
    brain.enableGrid(makeGridSettings(), [makeWindow('1', 'code.exe')]);
    expect(last(snapshots).exclusions).toEqual([]);
  });
});
