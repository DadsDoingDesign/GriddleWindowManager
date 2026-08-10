// Pause-resume reconciliation + HWND-recycling re-adoption (critique round 2).
//
// Two related gaps in the same defense:
//
// 1. The host's async `window-destroyed` vetting can drop a genuine destroy
//    when Windows recycles the HWND to a new window fast enough that its
//    `window-appeared` is processed first. `windowAppeared` must therefore
//    re-adopt an already-tiled hwnd (refresh title/exe/monitor, converge
//    minimized/excluded states) instead of silently early-returning — that
//    makes the dropped-destroy race converge to correct state regardless of
//    event ordering.
//
// 2. `reconcile(live)` is the resume path (spec §6 panic button): while
//    paused the shell suppresses every event, so the brain must converge on
//    a fresh sweep — destroys for gone windows, the minimize flow for tiled
//    windows minimized/maximized during the pause, and a re-snap for tiled
//    windows the user physically moved (management is authoritative again
//    the moment it resumes).

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { cellRect } from '../src/coords';
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

// Default window: 500×400 → snaps to 3×2 on the 12×6 grid.
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

function tilesOf(snap: StateSnapshot, gridId: string = GRID_ID) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return tiles!;
}

describe('windowAppeared re-adoption (HWND recycling)', () => {
  it('refreshes title/exe of an already-tiled hwnd instead of ignoring it', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101')]);
    const before = tilesOf(last(snapshots)).find((t) => t.hwnd === '101')!;
    expect(before.exe).toBe('app.exe');

    // The dropped-destroy race: '101' died, the handle was recycled to a new
    // eligible window, and only the window-appeared made it to the brain.
    brain.windowAppeared(
      makeWindow('101', { title: 'Recycled', exe: 'other.exe' }),
    );

    const after = tilesOf(last(snapshots)).find((t) => t.hwnd === '101')!;
    expect(after.title).toBe('Recycled');
    expect(after.exe).toBe('other.exe');
    // The tile survives at its slot — the new window inherits it knowingly.
    expect(after.slot).toEqual(before.slot);
  });

  it('does not re-emit a snapshot when the re-appearance changes nothing', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101')]);
    const count = snapshots.length;
    brain.windowAppeared(makeWindow('101'));
    expect(snapshots.length).toBe(count);
  });

  it('routes a tiled-but-minimized re-appearance through the minimize flow', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101'), makeWindow('102')]);

    brain.windowAppeared(makeWindow('101', { minimized: true }));

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd)).not.toContain('101');
    expect(tiles.map((t) => t.hwnd)).toContain('102');
  });

  it('drops the stale tile when the hwnd was recycled to an excluded exe', () => {
    const { brain, snapshots, applies } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101'), makeWindow('102')]);
    brain.setExclusions(['blocked.exe']);
    const applyCount = applies.length;

    brain.windowAppeared(makeWindow('101', { exe: 'blocked.exe' }));

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd)).not.toContain('101');
    // The excluded window itself is never moved.
    for (const layout of applies.slice(applyCount)) {
      expect(layout.moves.map((m) => m.hwnd)).not.toContain('101');
    }
  });

  it('refreshes a floating window entry too', () => {
    const { brain, snapshots } = harness();
    // 1×1 grid: the second window cannot fit and floats.
    brain.enableGrid(makeGridSettings({ cols: 1, rows: 1 }), [
      makeWindow('101', { width: 1920, height: 1032 }),
      makeWindow('102', { width: 1920, height: 1032 }),
    ]);
    expect(last(snapshots).floating.map((f) => f.hwnd)).toContain('102');

    brain.windowAppeared(makeWindow('102', { title: 'Recycled float' }));
    const f = last(snapshots).floating.find((x) => x.hwnd === '102')!;
    expect(f.title).toBe('Recycled float');
  });
});

describe('reconcile (pause → resume)', () => {
  it('destroys known windows missing from the sweep', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101'), makeWindow('102')]);

    brain.reconcile([makeWindow('102')]);

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd)).toEqual(['102']);
  });

  it('re-snaps a tiled window the user moved while paused back onto its slot', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101')]);
    const slot = tilesOf(last(snapshots)).find((t) => t.hwnd === '101')!.slot;
    const expected = cellRect(mon, { cols: 12, rows: 6 }, slot);
    const applyCount = applies.length;

    // The user dragged the window somewhere else while management was paused.
    brain.reconcile([makeWindow('101', { x: 700, y: 500 })]);

    const moves = applies.slice(applyCount).flatMap((l) => l.moves);
    const move = moves.find((m) => m.hwnd === '101');
    expect(move).toBeDefined();
    expect({ x: move!.x, y: move!.y, width: move!.width, height: move!.height }).toEqual(
      expected,
    );
    // The tile itself never moved.
    expect(tilesOf(last(snapshots)).find((t) => t.hwnd === '101')!.slot).toEqual(slot);
  });

  it('does not emit moves when nothing changed while paused', () => {
    const { brain, applies, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101')]);
    // The window sits exactly where the brain last put it.
    const slot = { col: 0, row: 0, w: 3, h: 2 };
    const rect = cellRect(mon, { cols: 12, rows: 6 }, slot);
    const applyCount = applies.length;

    brain.reconcile([
      makeWindow('101', {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }),
    ]);

    expect(applies.slice(applyCount).flatMap((l) => l.moves)).toEqual([]);
  });

  it('releases the tile of a window minimized during the pause', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101'), makeWindow('102')]);
    const applyCount = applies.length;

    brain.reconcile([
      makeWindow('101', { minimized: true }),
      makeWindow('102'),
    ]);

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd)).toEqual(['102']);
    // No move is ever emitted for the minimized window.
    for (const layout of applies.slice(applyCount)) {
      expect(layout.moves.map((m) => m.hwnd)).not.toContain('101');
    }
  });

  it('places windows opened during the pause', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101')]);

    brain.reconcile([makeWindow('101'), makeWindow('103')]);

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd).sort()).toEqual(['101', '103']);
  });

  it('forgets a remembered (minimized) window that closed during the pause', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('101'), makeWindow('102')]);
    brain.windowMinimized('101'); // remembered for restore

    brain.reconcile([makeWindow('102')]);

    // A later appearance of a fresh window under the same hwnd places fresh
    // (no remembered-slot restore of the dead window's cell).
    brain.windowRestored(makeWindow('101', { title: 'New tenant' }));
    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd).sort()).toEqual(['101', '102']);
    expect(tiles.find((t) => t.hwnd === '101')!.title).toBe('New tenant');
  });

  it('handles the full pause storm: close + open + move + minimize at once', () => {
    const { brain, snapshots, mon, applies } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('101'),
      makeWindow('102'),
      makeWindow('103'),
    ]);
    const slots = new Map(
      tilesOf(last(snapshots)).map((t) => [t.hwnd, t.slot] as const),
    );
    const applyCount = applies.length;

    brain.reconcile([
      // 101 closed (missing); 102 moved; 103 minimized; 104 opened.
      makeWindow('102', { x: 999, y: 700 }),
      makeWindow('103', { minimized: true }),
      makeWindow('104'),
    ]);

    const tiles = tilesOf(last(snapshots));
    expect(tiles.map((t) => t.hwnd).sort()).toEqual(['102', '104']);
    // 102 snapped back to its old slot.
    expect(tiles.find((t) => t.hwnd === '102')!.slot).toEqual(slots.get('102'));
    const moved = applies.slice(applyCount).flatMap((l) => l.moves);
    expect(moved.map((m) => m.hwnd)).toContain('102');
    expect(moved.map((m) => m.hwnd)).not.toContain('103');
    // Every emitted rect stays inside the work area.
    for (const m of moved) {
      expect(m.x).toBeGreaterThanOrEqual(mon.workX);
      expect(m.y).toBeGreaterThanOrEqual(mon.workY);
      expect(m.x + m.width).toBeLessThanOrEqual(mon.workX + mon.workWidth);
      expect(m.y + m.height).toBeLessThanOrEqual(mon.workY + mon.workHeight);
    }
  });
});
