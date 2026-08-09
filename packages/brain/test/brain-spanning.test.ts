// Task 17 — spanning grids in the brain: a grid over the union work area of
// an L-shaped 2-monitor setup, with dead-space cells excluded from
// placement, drag snapping, previews, editor moves, and displacement.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { rectCoveredByWorkAreas, spanGridId } from '../src/spanning';
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  Slot,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

// L-shaped union: A 1920×1080 at origin, B 1280×720 top-aligned to its right.
// 8×4 grid over the 3200×1080 union → exact 400×270 cells. Dead cells:
// every (col ≥ 4, row ≥ 2).
const MON_A: MonitorInfo = {
  id: '\\\\.\\DISPLAY1@0,0',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  workX: 0,
  workY: 0,
  workWidth: 1920,
  workHeight: 1080,
  dpi: 96,
  primary: true,
};
const MON_B: MonitorInfo = {
  id: '\\\\.\\DISPLAY2@1920,0',
  x: 1920,
  y: 0,
  width: 1280,
  height: 720,
  workX: 1920,
  workY: 0,
  workWidth: 1280,
  workHeight: 720,
  dpi: 96,
  primary: false,
};
const SPAN_ID = spanGridId([MON_A.id, MON_B.id]);

function spanSettings(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: SPAN_ID,
    monitorIds: [MON_A.id, MON_B.id],
    cols: 8,
    rows: 4,
    mode: 'collision',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

// Default window: 400×270 → snaps to exactly 1×1 on the 8×4 span grid.
function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 0,
    width: 400,
    height: 270,
    monitorId: MON_A.id,
    minimized: false,
    resizable: true,
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
  brain.setMonitors([MON_A, MON_B]);
  return { brain, applies, snapshots, previews };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function slotOf(snap: StateSnapshot, hwnd: string, gridId = SPAN_ID): Slot {
  const tile = snap.tiles[gridId]?.find((t) => t.hwnd === hwnd);
  expect(tile, `tile ${hwnd} in ${gridId}`).toBeDefined();
  return tile!.slot;
}

/** Every rect ever applied must lie on real screen — never in dead space. */
function assertAppliesCovered(applies: ApplyLayout[]): void {
  for (const layout of applies) {
    for (const m of layout.moves) {
      expect(
        rectCoveredByWorkAreas(
          { x: m.x, y: m.y, width: m.width, height: m.height },
          [MON_A, MON_B],
        ),
        `move ${m.hwnd} → ${m.x},${m.y} ${m.width}×${m.height} must be on-screen`,
      ).toBe(true);
    }
  }
}

describe('spanning grid — enable + placement', () => {
  it('lays out windows from both monitors on the union grid, dead space excluded', () => {
    const h = harness();
    const windows = [
      makeWindow('1'),
      makeWindow('2', { x: 600, y: 100 }),
      makeWindow('3', { monitorId: MON_B.id, x: 2000, y: 50 }),
    ];
    h.brain.enableGrid(spanSettings(), windows);

    const snap = last(h.snapshots);
    expect(snap.tiles[SPAN_ID]).toHaveLength(3);
    for (const w of windows) {
      expect(h.brain.slotUsable(SPAN_ID, slotOf(snap, w.hwnd))).toBe(true);
    }
    expect(h.applies).toHaveLength(1);
    assertAppliesCovered(h.applies);
  });

  it('slotUsable reports dead cells of the union', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), []);
    expect(h.brain.slotUsable(SPAN_ID, { col: 0, row: 3, w: 1, h: 1 })).toBe(true);
    expect(h.brain.slotUsable(SPAN_ID, { col: 4, row: 2, w: 1, h: 1 })).toBe(false);
    expect(h.brain.slotUsable(SPAN_ID, { col: 6, row: 0, w: 2, h: 2 })).toBe(true);
    expect(h.brain.slotUsable(SPAN_ID, { col: 6, row: 1, w: 1, h: 2 })).toBe(false);
    expect(h.brain.slotUsable('nope', { col: 0, row: 0, w: 1, h: 1 })).toBe(false);
  });

  it('enabling a spanning grid tears down per-monitor grids on those monitors', () => {
    const h = harness();
    h.brain.enableGrid(
      {
        id: `grid:${MON_A.id}`,
        monitorIds: [MON_A.id],
        cols: 12,
        rows: 6,
        mode: 'collision',
        enabled: true,
        activeTemplateId: null,
      },
      [makeWindow('1'), makeWindow('2', { x: 600, y: 100 })],
    );
    expect(last(h.snapshots).tiles[`grid:${MON_A.id}`]).toHaveLength(2);

    h.brain.enableGrid(spanSettings(), [
      makeWindow('1'),
      makeWindow('2', { x: 600, y: 100 }),
      makeWindow('3', { monitorId: MON_B.id, x: 2000, y: 50 }),
    ]);
    const snap = last(h.snapshots);
    const perMonitor = snap.grids.find((g) => g.id === `grid:${MON_A.id}`);
    expect(perMonitor?.enabled).toBe(false);
    expect(snap.tiles[`grid:${MON_A.id}`]).toBeUndefined();
    expect(snap.tiles[SPAN_ID]).toHaveLength(3);
    assertAppliesCovered(h.applies);
  });

  it('a window snapping into the dead zone appears at the nearest usable slot', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), []);
    // Rect at B's bottom edge: raw snap is (7,2) — a dead cell.
    h.brain.windowAppeared(
      makeWindow('9', { monitorId: MON_B.id, x: 2600, y: 600, width: 500, height: 300 }),
    );
    const slot = slotOf(last(h.snapshots), '9');
    expect(h.brain.slotUsable(SPAN_ID, slot)).toBe(true);
    assertAppliesCovered(h.applies);
  });

  it('first-fit skips dead cells: the 25th 1×1 window floats instead', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), []);
    // Usable cells: 8×2 (rows 0-1) + 4×2 (rows 2-3, cols 0-3) = 24.
    for (let i = 1; i <= 24; i++) {
      h.brain.windowAppeared(makeWindow(String(i)));
    }
    let snap = last(h.snapshots);
    expect(snap.tiles[SPAN_ID]).toHaveLength(24);
    for (const t of snap.tiles[SPAN_ID]!) {
      expect(h.brain.slotUsable(SPAN_ID, t.slot)).toBe(true);
    }

    // The 25th would land in dead space (the only free cells) — it floats.
    h.brain.windowAppeared(makeWindow('25'));
    snap = last(h.snapshots);
    expect(snap.tiles[SPAN_ID]).toHaveLength(24);
    expect(snap.floating.map((f) => f.hwnd)).toContain('25');
    assertAppliesCovered(h.applies);
  });

  it('overlay-mode spanning grid pins dead-zone windows to usable slots', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings({ mode: 'overlay' }), []);
    h.brain.windowAppeared(
      makeWindow('7', { monitorId: MON_B.id, x: 2600, y: 600, width: 500, height: 300 }),
    );
    const slot = slotOf(last(h.snapshots), '7');
    expect(h.brain.slotUsable(SPAN_ID, slot)).toBe(true);
    assertAppliesCovered(h.applies);
  });
});

describe('spanning grid — drag, snap, and editor', () => {
  it('drag preview footprint snaps out of the dead zone', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [makeWindow('1')]);
    const start = slotOf(last(h.snapshots), '1');
    expect(start).toEqual({ col: 0, row: 0, w: 1, h: 1 });

    h.brain.moveSizeStart('1');
    // Cursor over B near its bottom: raw slotFromCursor gives (6,2) — dead.
    h.brain.dragMoved({
      hwnd: '1',
      cursorX: 2600,
      cursorY: 650,
      x: 2400,
      y: 500,
      width: 400,
      height: 270,
    });
    const preview = last(h.previews);
    expect(preview.visible).toBe(true);
    expect(preview.footprint).toEqual({ col: 6, row: 1, w: 1, h: 1 });
    h.brain.moveSizeEnd('1', { x: 2400, y: 500, width: 400, height: 270 });
    assertAppliesCovered(h.applies);
  });

  it('a drop into the dead zone commits to the nearest usable slot', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [makeWindow('1')]);
    h.brain.moveSizeStart('1');
    // Final rect snaps to (6,2,2,2) — dead rows; nearest usable 2×2 is (6,0).
    h.brain.moveSizeEnd('1', { x: 2400, y: 500, width: 700, height: 500 });

    const slot = slotOf(last(h.snapshots), '1');
    expect(slot).toEqual({ col: 6, row: 0, w: 2, h: 2 });
    assertAppliesCovered(h.applies);
    // The final rect lands fully on monitor B.
    const lastMove = last(last(h.applies).moves);
    expect(lastMove.hwnd).toBe('1');
    expect(lastMove).toMatchObject({ x: 2400, y: 0, width: 800, height: 540 });
  });

  it('editor moves into dead cells land on the nearest usable slot', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [makeWindow('1')]);
    h.brain.moveTileFromEditor(SPAN_ID, '1', { col: 6, row: 2, w: 1, h: 1 });
    expect(slotOf(last(h.snapshots), '1')).toEqual({ col: 6, row: 1, w: 1, h: 1 });
    assertAppliesCovered(h.applies);
  });

  it('rejects a resize whose displacement would push a neighbor into dead space', () => {
    const h = harness();
    // 2×2 grid over the union: cells (0,0), (1,0), (0,1) usable; (1,1) dead.
    h.brain.enableGrid(spanSettings({ cols: 2, rows: 2 }), [
      makeWindow('T', { x: 0, y: 0, width: 1600, height: 540 }),
      makeWindow('V', { x: 1600, y: 0, width: 1600, height: 540 }),
      makeWindow('W', { x: 0, y: 540, width: 1600, height: 540 }),
    ]);
    let snap = last(h.snapshots);
    expect(slotOf(snap, 'T')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, 'V')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, 'W')).toEqual({ col: 0, row: 1, w: 1, h: 1 });

    // Growing T to 2×1 would displace V — its only escape is the dead cell
    // (1,1), so the whole op must be rejected and every tile stay put.
    h.brain.moveSizeStart('T');
    h.brain.moveSizeEnd('T', { x: 0, y: 0, width: 3200, height: 540 });
    snap = last(h.snapshots);
    expect(slotOf(snap, 'T')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, 'V')).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(slotOf(snap, 'W')).toEqual({ col: 0, row: 1, w: 1, h: 1 });
    assertAppliesCovered(h.applies);
  });
});

describe('spanning grid — persistence and topology changes', () => {
  it('round-trips the span layout through exportConfig', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [
      makeWindow('1'),
      makeWindow('2', { monitorId: MON_B.id, x: 2000, y: 50 }),
    ]);
    h.brain.moveTileFromEditor(SPAN_ID, '2', { col: 6, row: 0, w: 2, h: 2 });
    const before = last(h.snapshots);
    const cfg = h.brain.exportConfig();
    expect(cfg.grids.find((g) => g.id === SPAN_ID)?.monitorIds).toEqual([
      MON_A.id,
      MON_B.id,
    ]);

    const applies: ApplyLayout[] = [];
    const snapshots: StateSnapshot[] = [];
    const brain2 = new WindowManagerBrain(
      {
        onApply: (l) => applies.push(l),
        onPreview: () => {},
        onSnapshot: (s) => snapshots.push(s),
      },
      cfg,
    );
    brain2.setMonitors([MON_A, MON_B]);
    brain2.enableGrid(cfg.grids.find((g) => g.id === SPAN_ID)!, [
      makeWindow('1'),
      makeWindow('2', { monitorId: MON_B.id, x: 2000, y: 50 }),
    ]);
    const after = last(snapshots);
    expect(slotOf(after, '1')).toEqual(slotOf(before, '1'));
    expect(slotOf(after, '2')).toEqual(slotOf(before, '2'));
    assertAppliesCovered(applies);
  });

  it('survives a member monitor vanishing and returning', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [makeWindow('1')]);
    const before = h.applies.length;

    h.brain.setMonitors([MON_A]); // B unplugged: span grid goes inert
    h.brain.windowAppeared(makeWindow('2', { x: 600, y: 100 }));
    // No monitor union → no moves can be computed for the span grid.
    expect(h.applies.length).toBe(before);

    h.brain.setMonitors([MON_A, MON_B]); // B returns: dead space recomputed
    expect(h.brain.slotUsable(SPAN_ID, { col: 4, row: 2, w: 1, h: 1 })).toBe(false);
    expect(h.brain.slotUsable(SPAN_ID, { col: 4, row: 1, w: 1, h: 1 })).toBe(true);
  });

  it('reflowGrid recomputes the dead-space mask for the new dims', () => {
    const h = harness();
    h.brain.enableGrid(spanSettings(), [makeWindow('1')]);
    h.brain.reflowGrid(SPAN_ID, 4, 2);
    // 4×2 over the union → 800×540 cells; dead cells are (col ≥ 2, row 1)…
    expect(h.brain.slotUsable(SPAN_ID, { col: 2, row: 1, w: 1, h: 1 })).toBe(false);
    expect(h.brain.slotUsable(SPAN_ID, { col: 3, row: 0, w: 1, h: 1 })).toBe(true);
    // …and the surviving tile still sits on a usable slot.
    const slot = slotOf(last(h.snapshots), '1');
    expect(h.brain.slotUsable(SPAN_ID, slot)).toBe(true);
    assertAppliesCovered(h.applies);
  });
});
