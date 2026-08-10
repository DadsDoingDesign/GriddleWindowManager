import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  Move,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';
import { cellRect } from '../src/coords';

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

// Default window: 500×400 → snaps to 3×2 on the 12×6 grid, 1×1 on a 4×1 grid.
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

function gridTiles(snap: StateSnapshot, gridId: string = GRID_ID) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return tiles!;
}

function movesOverlap(a: Move, b: Move): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Spec bounds invariant: every rect of every apply ever emitted stays inside the work area. */
function assertAllWithinWorkArea(applies: ApplyLayout[], mon: MonitorInfo): void {
  for (const layout of applies) {
    for (const m of layout.moves) {
      expect(m.x).toBeGreaterThanOrEqual(mon.workX);
      expect(m.y).toBeGreaterThanOrEqual(mon.workY);
      expect(m.x + m.width).toBeLessThanOrEqual(mon.workX + mon.workWidth);
      expect(m.y + m.height).toBeLessThanOrEqual(mon.workY + mon.workHeight);
      expect(m.width).toBeGreaterThan(0);
      expect(m.height).toBeGreaterThan(0);
    }
  }
}

describe('enableGrid', () => {
  it('places 3 windows with a single apply of 3 non-overlapping in-bounds moves', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('101'),
      makeWindow('102'),
      makeWindow('103'),
    ]);

    expect(applies).toHaveLength(1);
    const moves = applies[0]!.moves;
    expect(moves).toHaveLength(3);
    expect(new Set(moves.map((m) => m.hwnd))).toEqual(new Set(['101', '102', '103']));
    for (let i = 0; i < moves.length; i++) {
      for (let j = i + 1; j < moves.length; j++) {
        expect(movesOverlap(moves[i]!, moves[j]!)).toBe(false);
      }
    }
    assertAllWithinWorkArea(applies, mon);

    const snap = last(snapshots);
    const tiles = gridTiles(snap);
    expect(tiles).toHaveLength(3);
    expect(tiles[0]!.title).toBe('Window 101');
    expect(tiles[0]!.exe).toBe('app.exe');
    expect(snap.grids.find((g) => g.id === GRID_ID)?.enabled).toBe(true);
  });

  it('ignores windows on other monitors and minimized windows', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1'),
      makeWindow('2', { monitorId: 'some-other-monitor' }),
      makeWindow('3', { minimized: true }),
    ]);
    expect(applies).toHaveLength(1);
    expect(applies[0]!.moves).toHaveLength(1);
    expect(applies[0]!.moves[0]!.hwnd).toBe('1');
    expect(gridTiles(last(snapshots))).toHaveLength(1);
  });

  it('skips windows whose exe is in the config exclusion list', () => {
    const cfg: AppConfig = {
      version: 4,
      grids: [],
      templates: [],
      exclusions: ['excluded.exe'],
      layouts: {},
      hotkey: 'Ctrl+Super+G',
      autostart: false,
      paused: false,
      appRules: [],
      views: [],
      startupViewId: null,
      autoCheckUpdates: false,
    };
    const { brain, applies, snapshots } = harness(cfg);
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1'),
      makeWindow('2', { exe: 'excluded.exe' }),
    ]);
    expect(applies).toHaveLength(1);
    expect(applies[0]!.moves).toHaveLength(1);
    expect(applies[0]!.moves[0]!.hwnd).toBe('1');
    expect(gridTiles(last(snapshots))).toHaveLength(1);
  });
});

describe('windowAppeared', () => {
  it('places a new window first-fit into free cells', () => {
    const { brain, applies, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    // 1 → (0,0,3,2), 2 → (3,0,3,2); next free 3×2 in reading order is (6,0).
    brain.windowAppeared(makeWindow('3'));

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toHaveLength(1);
    expect(applies[1]!.moves[0]).toEqual({
      hwnd: '3',
      ...cellRect(mon, { cols: 12, rows: 6 }, { col: 6, row: 0, w: 3, h: 2 }),
    });
    assertAllWithinWorkArea(applies, mon);
  });

  it('uses addTileWithDisplacement when no free slot fits, applying displaced neighbors too', () => {
    // 4×1 grid, unit 480×1032. A,B,C are 1×1 at cols 0,1,2. Minimizing B leaves
    // holes at cols 1 and 3 that are not contiguous, so a 2×1 window cannot
    // first-fit and must displace C.
    const { brain, applies, mon } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [
      makeWindow('A'),
      makeWindow('B'),
      makeWindow('C'),
    ]);
    brain.windowMinimized('B');
    brain.windowAppeared(makeWindow('D', { x: 480, width: 960, height: 1000 }));

    expect(applies).toHaveLength(2);
    const moves = last(applies).moves;
    expect(moves).toHaveLength(2);
    const dMove = moves.find((m) => m.hwnd === 'D');
    const cMove = moves.find((m) => m.hwnd === 'C');
    // D lands on cols 1-2, C is pushed to col 3.
    expect(dMove).toEqual({ hwnd: 'D', x: 480, y: 48, width: 960, height: 1032 });
    expect(cMove).toEqual({ hwnd: 'C', x: 1440, y: 48, width: 480, height: 1032 });
    assertAllWithinWorkArea(applies, mon);
  });

  it('marks the window floating (no apply) when the grid is full', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [
      makeWindow('1'),
      makeWindow('2'),
      makeWindow('3'),
      makeWindow('4'),
    ]);
    expect(applies).toHaveLength(1);
    brain.windowAppeared(makeWindow('5'));

    expect(applies).toHaveLength(1); // no apply for the unplaceable window
    const snap = last(snapshots);
    expect(gridTiles(snap)).toHaveLength(4);
    expect(snap.floating.map((f) => f.hwnd)).toEqual(['5']);
    expect(snap.floating[0]!.exe).toBe('app.exe');
    assertAllWithinWorkArea(applies, mon);
  });

  it('does nothing for windows on ungridded monitors', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    const before = snapshots.length;
    brain.windowAppeared(makeWindow('2', { monitorId: 'some-other-monitor' }));
    expect(applies).toHaveLength(1);
    expect(snapshots.length).toBe(before);
  });
});

describe('windowMinimized / windowRestored', () => {
  it('minimize removes the tile without emitting moves for others', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1'),
      makeWindow('2'),
      makeWindow('3'),
    ]);
    const slotsBefore = new Map(
      gridTiles(last(snapshots)).map((t) => [t.hwnd, t.slot]),
    );

    brain.windowMinimized('2');

    expect(applies).toHaveLength(1); // no apply from minimizing
    const tiles = gridTiles(last(snapshots));
    expect(tiles.map((t) => t.hwnd).sort()).toEqual(['1', '3']);
    // no auto-compact: survivors keep their slots
    for (const t of tiles) {
      expect(t.slot).toEqual(slotsBefore.get(t.hwnd));
    }
  });

  it('restore returns the window to its previous slot when it is still free', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('1'),
      makeWindow('2'),
      makeWindow('3'),
    ]);
    const originalMove = applies[0]!.moves.find((m) => m.hwnd === '2')!;

    brain.windowMinimized('2');
    brain.windowRestored(makeWindow('2'));

    expect(applies).toHaveLength(2);
    expect(applies[1]!.moves).toHaveLength(1);
    expect(applies[1]!.moves[0]).toEqual(originalMove);
    expect(gridTiles(last(snapshots))).toHaveLength(3);
    assertAllWithinWorkArea(applies, mon);
  });

  it('restore auto-places when the previous slot was taken', () => {
    // 4×1 grid: A,B,C at cols 0,1,2. Minimize B, D appears and first-fits into
    // col 1. Restoring B must auto-place it into the only free cell, col 3.
    const { brain, applies, mon } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [
      makeWindow('A'),
      makeWindow('B'),
      makeWindow('C'),
    ]);
    brain.windowMinimized('B');
    brain.windowAppeared(makeWindow('D'));
    expect(last(applies).moves).toEqual([
      { hwnd: 'D', x: 480, y: 48, width: 480, height: 1032 },
    ]);

    brain.windowRestored(makeWindow('B'));
    expect(last(applies).moves).toEqual([
      { hwnd: 'B', x: 1440, y: 48, width: 480, height: 1032 },
    ]);
    assertAllWithinWorkArea(applies, mon);
  });
});

describe('windowDestroyed', () => {
  it('removes the tile and allows the same hwnd to reappear', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);

    brain.windowDestroyed('1');
    expect(applies).toHaveLength(1); // removal emits no moves
    expect(gridTiles(last(snapshots)).map((t) => t.hwnd)).toEqual(['2']);

    brain.windowAppeared(makeWindow('1'));
    expect(applies).toHaveLength(2);
    // first-fit re-places it into the hole at (0,0)
    expect(applies[1]!.moves[0]).toEqual({
      hwnd: '1',
      ...cellRect(mon, { cols: 12, rows: 6 }, { col: 0, row: 0, w: 3, h: 2 }),
    });
    assertAllWithinWorkArea(applies, mon);
  });

  it('removes a floating window from the snapshot', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [
      makeWindow('1'),
      makeWindow('2'),
      makeWindow('3'),
      makeWindow('4'),
    ]);
    brain.windowAppeared(makeWindow('5'));
    expect(last(snapshots).floating.map((f) => f.hwnd)).toEqual(['5']);

    brain.windowDestroyed('5');
    expect(last(snapshots).floating).toEqual([]);
  });
});

describe('disableGrid', () => {
  it('drops the grid without emitting moves', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);

    brain.disableGrid(GRID_ID);

    expect(applies).toHaveLength(1); // windows stay where they are
    const snap = last(snapshots);
    expect(snap.tiles[GRID_ID]).toBeUndefined();
    expect(snap.grids.find((g) => g.id === GRID_ID)?.enabled).toBe(false);
  });

  it('stops managing windows: events after disable emit nothing', () => {
    const { brain, applies } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1')]);
    brain.disableGrid(GRID_ID);

    brain.windowAppeared(makeWindow('9'));
    brain.windowMinimized('1');
    brain.windowRestored(makeWindow('1'));
    expect(applies).toHaveLength(1);
  });
});

describe('non-resizable windows', () => {
  it('snaps position only (absolute tile), keeping the window size', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('N', { x: 600, y: 300, resizable: false }),
      makeWindow('R'),
    ]);

    expect(applies).toHaveLength(1);
    const nMove = applies[0]!.moves.find((m) => m.hwnd === 'N')!;
    // snapped slot (4,1,3,2) → cell origin (640,220); size untouched
    expect(nMove).toEqual({ hwnd: 'N', x: 640, y: 220, width: 500, height: 400 });
    const nTile = gridTiles(last(snapshots)).find((t) => t.hwnd === 'N')!;
    expect(nTile.slot).toEqual({ col: 4, row: 1, w: 3, h: 2 });
    // the resizable window still first-fits from the grid origin
    const rMove = applies[0]!.moves.find((m) => m.hwnd === 'R')!;
    expect(rMove).toEqual({
      hwnd: 'R',
      ...cellRect(mon, { cols: 12, rows: 6 }, { col: 0, row: 0, w: 3, h: 2 }),
    });
    assertAllWithinWorkArea(applies, mon);
  });
});

describe('bounds invariant under churn', () => {
  it('every apply ever emitted stays inside the work area and the final layout has no overlaps', () => {
    const { brain, applies, snapshots, mon } = harness();
    const initial = ['1', '2', '3'].map((h) => makeWindow(h));
    brain.enableGrid(makeGridSettings(), initial);

    // 12×6 grid holds exactly twelve 3×2 tiles; window 13 cannot fit.
    for (let i = 4; i <= 13; i++) {
      brain.windowAppeared(makeWindow(String(i)));
    }
    brain.windowMinimized('5');
    brain.windowDestroyed('6');
    brain.windowRestored(makeWindow('5'));
    brain.windowAppeared(makeWindow('14'));

    const snap = last(snapshots);
    const tiles = gridTiles(snap);
    expect(tiles).toHaveLength(12);
    expect(snap.floating.map((f) => f.hwnd)).toEqual(['13']);

    assertAllWithinWorkArea(applies, mon);

    // collision grid: no overlapping cells in the final layout
    const slots = tiles.map((t) => t.slot);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const overlap =
          a.col < b.col + b.w &&
          b.col < a.col + a.w &&
          a.row < b.row + b.h &&
          b.row < a.row + a.h;
        expect(overlap).toBe(false);
      }
    }
  });
});
