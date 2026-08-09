// Task 6 — templates: builtinTemplates() ships the five builtin layouts;
// captureTemplate snapshots a live grid's cols/rows + slots (reading order,
// no hwnds); applyTemplate maps windows to slots by recency (most recent →
// first slot), auto-places extras, reflows the grid first when the template's
// dims differ, and emits exactly one apply.

import { describe, expect, it } from 'vitest';
import { builtinTemplates } from '../src/templates';
import { WindowManagerBrain } from '../src/brain';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  Slot,
  StateSnapshot,
  Template,
  WindowInfo,
} from '../src/types';
import { cellRect } from '../src/coords';

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const GRID_ID = `grid:${MON_ID}`;
const DIMS = { cols: 12, rows: 6 };
const BUILTIN_IDS = ['tpl:2col', 'tpl:3col', 'tpl:2x2', 'tpl:main-side', 'tpl:rows2'];

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

// Default window: 500×400 at the work-area origin → 3×2 cells on a 12×6 grid.
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
    mode: 'collision',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

// A user template on the same 12×6 dims as the default grid: one big left
// half, two stacked right quarters.
const CUSTOM_TPL: Template = {
  id: 'tpl:custom12',
  name: 'Custom 12x6',
  cols: 12,
  rows: 6,
  slots: [
    { col: 0, row: 0, w: 6, h: 6 },
    { col: 6, row: 0, w: 6, h: 3 },
    { col: 6, row: 3, w: 6, h: 3 },
  ],
  builtin: false,
};

// An 8×6 user template — dims differ from the grid's 12×6 to exercise the
// re-dimension path (builtins no longer do: they are all authored at 12×6).
const TPL_8X6: Template = {
  id: 'tpl:wide8',
  name: 'Main + side (8x6)',
  cols: 8,
  rows: 6,
  slots: [
    { col: 0, row: 0, w: 5, h: 6 },
    { col: 5, row: 0, w: 3, h: 6 },
  ],
  builtin: false,
};

function makeConfig(templates: Template[]): AppConfig {
  return {
    version: 2,
    grids: [],
    templates,
    exclusions: [],
    layouts: {},
    hotkey: 'Ctrl+Super+G',
    autostart: false,
    paused: false,
    appRules: [],
    views: [],
    startupViewId: null,
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

function slotOf(snap: StateSnapshot, hwnd: string): Slot {
  const tile = gridTiles(snap).find((t) => t.hwnd === hwnd);
  expect(tile).toBeDefined();
  return tile!.slot;
}

function slotsOverlap(a: Slot, b: Slot): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

function inReadingOrder(slots: Slot[]): boolean {
  for (let i = 1; i < slots.length; i++) {
    const p = slots[i - 1]!;
    const s = slots[i]!;
    if (s.row < p.row || (s.row === p.row && s.col < p.col)) return false;
  }
  return true;
}

describe('builtinTemplates', () => {
  it('ships exactly the five builtin templates with the contract ids, in order', () => {
    const tpls = builtinTemplates();
    expect(tpls.map((t) => t.id)).toEqual(BUILTIN_IDS);
    expect(tpls.every((t) => t.builtin)).toBe(true);
    expect(tpls.every((t) => t.name.length > 0)).toBe(true);
  });

  // Critique round 3: every builtin is authored at the 12×6 default dims so
  // applying one on a fresh install never re-dimensions the user's grid
  // (applyTemplate re-dims to the template's cols/rows).
  it('every builtin is authored on the 12×6 default lattice', () => {
    for (const t of builtinTemplates()) {
      expect(t.cols, t.id).toBe(12);
      expect(t.rows, t.id).toBe(6);
    }
  });

  it('tpl:2col — two full-height columns', () => {
    const t = builtinTemplates().find((t) => t.id === 'tpl:2col')!;
    expect(t.slots).toEqual([
      { col: 0, row: 0, w: 6, h: 6 },
      { col: 6, row: 0, w: 6, h: 6 },
    ]);
  });

  it('tpl:3col — three full-height columns', () => {
    const t = builtinTemplates().find((t) => t.id === 'tpl:3col')!;
    expect(t.slots).toEqual([
      { col: 0, row: 0, w: 4, h: 6 },
      { col: 4, row: 0, w: 4, h: 6 },
      { col: 8, row: 0, w: 4, h: 6 },
    ]);
  });

  it('tpl:2x2 — four quadrants in reading order', () => {
    const t = builtinTemplates().find((t) => t.id === 'tpl:2x2')!;
    expect(t.slots).toEqual([
      { col: 0, row: 0, w: 6, h: 3 },
      { col: 6, row: 0, w: 6, h: 3 },
      { col: 0, row: 3, w: 6, h: 3 },
      { col: 6, row: 3, w: 6, h: 3 },
    ]);
  });

  it('tpl:main-side — main {0,0,7,6} + side {7,0,5,6}', () => {
    const t = builtinTemplates().find((t) => t.id === 'tpl:main-side')!;
    expect(t.slots).toEqual([
      { col: 0, row: 0, w: 7, h: 6 },
      { col: 7, row: 0, w: 5, h: 6 },
    ]);
  });

  it('tpl:rows2 — two full-width rows', () => {
    const t = builtinTemplates().find((t) => t.id === 'tpl:rows2')!;
    expect(t.slots).toEqual([
      { col: 0, row: 0, w: 12, h: 3 },
      { col: 0, row: 3, w: 12, h: 3 },
    ]);
  });

  it('every builtin has in-bounds, non-overlapping slots in reading order', () => {
    for (const t of builtinTemplates()) {
      for (const s of t.slots) {
        expect(s.col).toBeGreaterThanOrEqual(0);
        expect(s.row).toBeGreaterThanOrEqual(0);
        expect(s.col + s.w).toBeLessThanOrEqual(t.cols);
        expect(s.row + s.h).toBeLessThanOrEqual(t.rows);
      }
      for (let i = 0; i < t.slots.length; i++) {
        for (let j = i + 1; j < t.slots.length; j++) {
          expect(slotsOverlap(t.slots[i]!, t.slots[j]!)).toBe(false);
        }
      }
      expect(inReadingOrder(t.slots)).toBe(true);
    }
  });

  it('returns fresh copies — mutating a result does not poison later calls', () => {
    const first = builtinTemplates();
    first[0]!.slots[0]!.w = 99;
    first[0]!.name = 'mangled';
    const again = builtinTemplates();
    expect(again[0]!.slots[0]!.w).toBe(6);
    expect(again[0]!.name).not.toBe('mangled');
  });
});

describe('brain ships builtins', () => {
  it('a fresh brain lists all builtins in snapshots and exportConfig', () => {
    const { brain, snapshots } = harness();
    const ids = last(snapshots).templates.map((t) => t.id);
    for (const id of BUILTIN_IDS) expect(ids).toContain(id);
    const cfgIds = brain.exportConfig().templates.map((t) => t.id);
    for (const id of BUILTIN_IDS) expect(cfgIds).toContain(id);
  });

  it('config round-trip does not duplicate builtins and keeps user templates', () => {
    const a = harness(makeConfig([CUSTOM_TPL]));
    const b = harness(a.brain.exportConfig());
    const ids = b.brain.exportConfig().templates.map((t) => t.id);
    expect(ids.filter((id) => id === 'tpl:2col')).toHaveLength(1);
    expect(ids).toContain('tpl:custom12');
    expect(new Set(ids).size).toBe(ids.length); // no duplicates at all
  });
});

describe('captureTemplate', () => {
  it('snapshots cols/rows and slots, sorted in reading order, with no hwnds', () => {
    const { brain, snapshots } = harness();
    // Overlay mode keeps each window at its own snapped slot, so we can put
    // tiles at out-of-order positions: W1 at (6,2), W2 at (0,0).
    brain.enableGrid(makeGridSettings({ mode: 'overlay' }), [
      makeWindow('W1', { x: 960, y: 392 }), // → slot (6,2,3,2)
      makeWindow('W2'), // → slot (0,0,3,2)
    ]);

    const tpl = brain.captureTemplate(GRID_ID, 'My layout');

    expect(tpl.name).toBe('My layout');
    expect(tpl.builtin).toBe(false);
    expect(tpl.cols).toBe(12);
    expect(tpl.rows).toBe(6);
    // reading order regardless of placement order; slots carry no hwnd keys
    expect(tpl.slots).toEqual([
      { col: 0, row: 0, w: 3, h: 2 },
      { col: 6, row: 2, w: 3, h: 2 },
    ]);
    // registered: appears in the next snapshot and in exportConfig
    expect(last(snapshots).templates.some((t) => t.id === tpl.id)).toBe(true);
    expect(brain.exportConfig().templates.some((t) => t.id === tpl.id)).toBe(true);
  });

  it('captures a collision grid layout (in-flow tiles)', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    // first-fit: A (0,0,3,2), B (3,0,3,2)
    const tpl = brain.captureTemplate(GRID_ID, 'Pair');
    expect(tpl.slots).toEqual([
      { col: 0, row: 0, w: 3, h: 2 },
      { col: 3, row: 0, w: 3, h: 2 },
    ]);
  });

  it('assigns unique non-builtin ids across captures', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    const t1 = brain.captureTemplate(GRID_ID, 'one');
    const t2 = brain.captureTemplate(GRID_ID, 'two');
    expect(t1.id).not.toBe(t2.id);
    expect(BUILTIN_IDS).not.toContain(t1.id);
    expect(BUILTIN_IDS).not.toContain(t2.id);
  });

  it('throws on an unknown grid id', () => {
    const { brain } = harness();
    expect(() => brain.captureTemplate('grid:nope', 'x')).toThrow();
  });
});

describe('applyTemplate — same dims', () => {
  it('maps windows to slots by recency (most recent → first slot) in one apply', () => {
    const { brain, applies, snapshots, mon } = harness(makeConfig([CUSTOM_TPL]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B'), makeWindow('C')]);
    const appliesBefore = applies.length;

    brain.applyTemplate(GRID_ID, 'tpl:custom12');

    expect(applies).toHaveLength(appliesBefore + 1); // exactly one apply
    const snap = last(snapshots);
    // enable order A,B,C → C is most recent → first slot
    expect(slotOf(snap, 'C')).toEqual({ col: 0, row: 0, w: 6, h: 6 });
    expect(slotOf(snap, 'B')).toEqual({ col: 6, row: 0, w: 6, h: 3 });
    expect(slotOf(snap, 'A')).toEqual({ col: 6, row: 3, w: 6, h: 3 });
    // pixel rects match the slots
    const moves = last(applies).moves;
    expect(moves.find((m) => m.hwnd === 'C')).toEqual({
      hwnd: 'C',
      ...cellRect(mon, DIMS, { col: 0, row: 0, w: 6, h: 6 }),
    });
    expect(moves.find((m) => m.hwnd === 'A')).toEqual({
      hwnd: 'A',
      ...cellRect(mon, DIMS, { col: 6, row: 3, w: 6, h: 3 }),
    });
    // template recorded as active
    expect(snap.grids.find((g) => g.id === GRID_ID)!.activeTemplateId).toBe('tpl:custom12');
  });

  it('a drag updates recency: the just-dragged window takes the first slot', () => {
    const { brain, snapshots } = harness(makeConfig([CUSTOM_TPL]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B'), makeWindow('C')]);
    // drag A in place — it becomes the most recent
    brain.moveSizeStart('A');
    brain.moveSizeEnd('A', { x: 0, y: 48, width: 480, height: 344 });

    brain.applyTemplate(GRID_ID, 'tpl:custom12');

    expect(slotOf(last(snapshots), 'A')).toEqual({ col: 0, row: 0, w: 6, h: 6 });
  });

  it('auto-places extra windows beyond the template slots without overlap', () => {
    const twoSlot: Template = {
      id: 'tpl:two',
      name: 'Two top halves',
      cols: 12,
      rows: 6,
      slots: [
        { col: 0, row: 0, w: 6, h: 3 },
        { col: 6, row: 0, w: 6, h: 3 },
      ],
      builtin: false,
    };
    const { brain, applies, snapshots } = harness(makeConfig([twoSlot]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B'), makeWindow('C')]);
    const appliesBefore = applies.length;

    brain.applyTemplate(GRID_ID, 'tpl:two');

    expect(applies).toHaveLength(appliesBefore + 1);
    const snap = last(snapshots);
    expect(slotOf(snap, 'C')).toEqual({ col: 0, row: 0, w: 6, h: 3 });
    expect(slotOf(snap, 'B')).toEqual({ col: 6, row: 0, w: 6, h: 3 });
    // A is the extra: auto-placed first-fit (3×2 footprint) below the slots
    expect(slotOf(snap, 'A')).toEqual({ col: 0, row: 3, w: 3, h: 2 });
    expect(snap.floating).toEqual([]);
    const slots = gridTiles(snap).map((t) => t.slot);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        expect(slotsOverlap(slots[i]!, slots[j]!)).toBe(false);
      }
    }
  });
});

describe('applyTemplate — different dims (reflow first)', () => {
  it('re-dims the grid to the template cols/rows and lays out with the new cells', () => {
    const { brain, applies, snapshots, mon } = harness(makeConfig([TPL_8X6]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    const appliesBefore = applies.length;

    brain.applyTemplate(GRID_ID, 'tpl:wide8'); // 8×6 vs the grid's 12×6

    expect(applies).toHaveLength(appliesBefore + 1);
    const snap = last(snapshots);
    const g = snap.grids.find((g) => g.id === GRID_ID)!;
    expect(g.cols).toBe(8);
    expect(g.rows).toBe(6);
    expect(g.activeTemplateId).toBe('tpl:wide8');
    // B is most recent → main slot; A → side slot
    expect(slotOf(snap, 'B')).toEqual({ col: 0, row: 0, w: 5, h: 6 });
    expect(slotOf(snap, 'A')).toEqual({ col: 5, row: 0, w: 3, h: 6 });
    // pixel rects use the NEW dims: 1920/8 = 240 px units
    const moves = last(applies).moves;
    expect(moves.find((m) => m.hwnd === 'B')).toEqual({
      hwnd: 'B',
      ...cellRect(mon, { cols: 8, rows: 6 }, { col: 0, row: 0, w: 5, h: 6 }),
    });
    expect(moves.find((m) => m.hwnd === 'A')).toEqual({
      hwnd: 'A',
      ...cellRect(mon, { cols: 8, rows: 6 }, { col: 5, row: 0, w: 3, h: 6 }),
    });
    expect(moves.find((m) => m.hwnd === 'B'))!;
  });

  it('subsequent placement uses the template dims (exportConfig agrees)', () => {
    const { brain } = harness(makeConfig([TPL_8X6]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.applyTemplate(GRID_ID, 'tpl:wide8');
    const g = brain.exportConfig().grids.find((g) => g.id === GRID_ID)!;
    expect(g.cols).toBe(8);
    expect(g.rows).toBe(6);
  });

  // Critique round 3 regression: the first-run happy path. A fresh install
  // starts on 12×6; clicking Apply on any builtin must never change the
  // grid's dims (the old degenerate builtins re-gridded to 2×1 etc.).
  it('applying any builtin to the default 12×6 grid keeps the dims', () => {
    for (const tpl of builtinTemplates()) {
      const { brain, snapshots } = harness();
      brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
      brain.applyTemplate(GRID_ID, tpl.id);
      const g = last(snapshots).grids.find((g) => g.id === GRID_ID)!;
      expect(g.cols, tpl.id).toBe(12);
      expect(g.rows, tpl.id).toBe(6);
    }
  });
});

describe('applyTemplate — modes and special windows', () => {
  it('overlay grid: windows take template slots, mode stays overlay', () => {
    const { brain, applies, snapshots, mon } = harness(makeConfig([CUSTOM_TPL]));
    brain.enableGrid(makeGridSettings({ mode: 'overlay' }), [makeWindow('A'), makeWindow('B')]);
    const appliesBefore = applies.length;

    brain.applyTemplate(GRID_ID, 'tpl:custom12');

    expect(applies).toHaveLength(appliesBefore + 1);
    const snap = last(snapshots);
    expect(snap.grids.find((g) => g.id === GRID_ID)!.mode).toBe('overlay');
    expect(slotOf(snap, 'B')).toEqual({ col: 0, row: 0, w: 6, h: 6 });
    expect(slotOf(snap, 'A')).toEqual({ col: 6, row: 0, w: 6, h: 3 });
    expect(last(applies).moves.find((m) => m.hwnd === 'B')).toEqual({
      hwnd: 'B',
      ...cellRect(mon, DIMS, { col: 0, row: 0, w: 6, h: 6 }),
    });
  });

  it('non-resizable window gets the slot position but keeps its own size', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [
      makeWindow('R'),
      makeWindow('N', { resizable: false }), // most recent → first (main) slot
    ]);

    brain.applyTemplate(GRID_ID, 'tpl:main-side');

    const snap = last(snapshots);
    expect(slotOf(snap, 'N')).toEqual({ col: 0, row: 0, w: 7, h: 6 });
    expect(slotOf(snap, 'R')).toEqual({ col: 7, row: 0, w: 5, h: 6 });
    const nMove = last(applies).moves.find((m) => m.hwnd === 'N');
    if (nMove) {
      expect(nMove.width).toBe(500); // own size, not the 1120px cell
      expect(nMove.height).toBe(400);
      expect(nMove).toMatchObject({ x: 0, y: 48 });
    }
  });

  it('retries floating windows: a roomier template re-adopts them', () => {
    const { brain, snapshots } = harness(makeConfig([CUSTOM_TPL]));
    // 1×1 grid: only one 1×1 window fits; the others float.
    brain.enableGrid(makeGridSettings({ cols: 1, rows: 1 }), [
      makeWindow('A', { width: 1920, height: 1032 }),
      makeWindow('B', { width: 1920, height: 1032 }),
      makeWindow('C', { width: 1920, height: 1032 }),
    ]);
    expect(last(snapshots).floating.length).toBeGreaterThan(0);

    brain.applyTemplate(GRID_ID, 'tpl:custom12'); // 12×6 with 3 slots

    const snap = last(snapshots);
    expect(snap.floating).toEqual([]);
    expect(gridTiles(snap)).toHaveLength(3);
  });
});

describe('applyTemplate — edges', () => {
  it('unknown template id is a no-op', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    const appliesBefore = applies.length;
    const before = gridTiles(last(snapshots)).map((t) => ({ ...t }));

    brain.applyTemplate(GRID_ID, 'tpl:missing');

    expect(applies).toHaveLength(appliesBefore);
    expect(gridTiles(last(snapshots))).toEqual(before);
  });

  it('unknown / disabled grid id is a no-op', () => {
    const { brain, applies } = harness();
    brain.applyTemplate('grid:nope', 'tpl:2col');
    expect(applies).toHaveLength(0);
  });

  it('cancels an in-progress drag on the reshaped grid', () => {
    const { brain, previews } = harness(makeConfig([CUSTOM_TPL]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.moveSizeStart('A');
    expect(last(previews).visible).toBe(true);

    brain.applyTemplate(GRID_ID, 'tpl:custom12');
    expect(last(previews).visible).toBe(false);

    // the stale drag no longer produces previews
    const count = previews.length;
    brain.dragMoved({ hwnd: 'A', cursorX: 240, cursorY: 220, x: 0, y: 48, width: 480, height: 344 });
    expect(previews).toHaveLength(count);
  });

  it('applying a captured template restores the captured layout', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    const tpl = brain.captureTemplate(GRID_ID, 'Snapshot'); // A(0,0,3,2) B(3,0,3,2)

    // shuffle: drag B down to (6,4)
    brain.moveSizeStart('B');
    brain.moveSizeEnd('B', { x: 960, y: 736, width: 480, height: 344 });
    expect(slotOf(last(snapshots), 'B')).toEqual({ col: 6, row: 4, w: 3, h: 2 });

    brain.applyTemplate(GRID_ID, tpl.id);

    const snap = last(snapshots);
    const slots = gridTiles(snap).map((t) => t.slot);
    expect(slots).toContainEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots).toContainEqual({ col: 3, row: 0, w: 3, h: 2 });
  });
});

describe('deleteTemplate (contract §C3 extension, plan Task 16)', () => {
  it('deletes a user template from snapshots and exportConfig, returns true', () => {
    const { brain, snapshots } = harness(makeConfig([CUSTOM_TPL]));
    expect(last(snapshots).templates.some((t) => t.id === 'tpl:custom12')).toBe(true);

    expect(brain.deleteTemplate('tpl:custom12')).toBe(true);

    expect(last(snapshots).templates.some((t) => t.id === 'tpl:custom12')).toBe(false);
    expect(brain.exportConfig().templates.some((t) => t.id === 'tpl:custom12')).toBe(false);
  });

  it('refuses to delete a builtin template, returns false', () => {
    const { brain, snapshots } = harness();
    const before = snapshots.length;
    for (const id of BUILTIN_IDS) {
      expect(brain.deleteTemplate(id)).toBe(false);
    }
    expect(snapshots).toHaveLength(before); // no snapshot spam for no-ops
    const ids = brain.exportConfig().templates.map((t) => t.id);
    for (const id of BUILTIN_IDS) expect(ids).toContain(id);
  });

  it('unknown template id is a no-op returning false', () => {
    const { brain, snapshots } = harness();
    const before = snapshots.length;
    expect(brain.deleteTemplate('tpl:missing')).toBe(false);
    expect(snapshots).toHaveLength(before);
  });

  it('clears activeTemplateId on grids that referenced the deleted template', () => {
    const { brain, applies, snapshots } = harness(makeConfig([CUSTOM_TPL]));
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    brain.applyTemplate(GRID_ID, 'tpl:custom12');
    expect(last(snapshots).grids.find((g) => g.id === GRID_ID)!.activeTemplateId).toBe(
      'tpl:custom12',
    );
    const appliesBefore = applies.length;
    const tilesBefore = gridTiles(last(snapshots)).map((t) => ({ ...t }));

    expect(brain.deleteTemplate('tpl:custom12')).toBe(true);

    const snap = last(snapshots);
    expect(snap.grids.find((g) => g.id === GRID_ID)!.activeTemplateId).toBeNull();
    // deleting a template never moves windows
    expect(applies).toHaveLength(appliesBefore);
    expect(gridTiles(snap)).toEqual(tilesBefore);
    expect(brain.exportConfig().grids.find((g) => g.id === GRID_ID)!.activeTemplateId).toBeNull();
  });

  it('a freshly captured template can be deleted again', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    const tpl = brain.captureTemplate(GRID_ID, 'Ephemeral');
    expect(brain.deleteTemplate(tpl.id)).toBe(true);
    expect(brain.exportConfig().templates.some((t) => t.id === tpl.id)).toBe(false);
  });
});

describe('applying a captured template (round trip)', () => {
  it('applying a captured template restores the captured layout', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    const tpl = brain.captureTemplate(GRID_ID, 'Snapshot'); // A(0,0,3,2) B(3,0,3,2)

    // shuffle: drag B down to (6,4)
    brain.moveSizeStart('B');
    brain.moveSizeEnd('B', { x: 960, y: 736, width: 480, height: 344 });
    expect(slotOf(last(snapshots), 'B')).toEqual({ col: 6, row: 4, w: 3, h: 2 });

    brain.applyTemplate(GRID_ID, tpl.id);

    const snap = last(snapshots);
    const slots = gridTiles(snap).map((t) => t.slot);
    expect(slots).toContainEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots).toContainEqual({ col: 3, row: 0, w: 3, h: 2 });
  });
});
