// Evals plan §3 (docs/evals-plan.md): the placement invariants behind the
// 2026-08-31 behaviors, checked over randomized inputs with a seeded PRNG
// (set INVARIANT_SEED=<n> to reproduce a run):
//   A. a fill footprint never overlaps a blocked cell, never sits below the
//      minimum, and always appears when a fitting free rectangle exists;
//   B. an auto-split either tiles the victim's old span exactly — both
//      halves at or above their minimum cells — or changes nothing;
//   C. expand → toggle returns a tile to its original slot, and the grown
//      slot always contains the original and overlaps nobody.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { bestOpenSlot } from '../src/openspace';
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  Slot,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

declare const process: { env: Record<string, string | undefined> };

const SEED = Number(process.env.INVARIANT_SEED ?? 20260831);

/** mulberry32 — small, seedable, good enough for test-case generation. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rnd: () => number, lo: number, hi: number) =>
  lo + Math.floor(rnd() * (hi - lo + 1));

function overlaps(a: Slot, b: Slot): boolean {
  return (
    a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h
  );
}

function contains(outer: Slot, inner: Slot): boolean {
  return (
    outer.col <= inner.col &&
    outer.row <= inner.row &&
    outer.col + outer.w >= inner.col + inner.w &&
    outer.row + outer.h >= inner.row + inner.h
  );
}

describe('the checkers themselves can see violations', () => {
  it('overlaps and contains distinguish good from bad', () => {
    expect(overlaps({ col: 0, row: 0, w: 2, h: 2 }, { col: 1, row: 1, w: 2, h: 2 })).toBe(true);
    expect(overlaps({ col: 0, row: 0, w: 1, h: 1 }, { col: 1, row: 0, w: 1, h: 1 })).toBe(false);
    expect(contains({ col: 0, row: 0, w: 3, h: 3 }, { col: 1, row: 1, w: 1, h: 1 })).toBe(true);
    expect(contains({ col: 0, row: 0, w: 2, h: 2 }, { col: 1, row: 1, w: 2, h: 2 })).toBe(false);
  });
});

describe('invariant A — bestOpenSlot is safe and complete', () => {
  it('holds over 400 random masks', () => {
    const rnd = prng(SEED);
    for (let i = 0; i < 400; i++) {
      const ctx = `seed ${SEED} iteration ${i}`;
      const cols = int(rnd, 1, 10);
      const rows = int(rnd, 1, 10);
      const min = { w: int(rnd, 1, 3), h: int(rnd, 1, 3) };
      const blocked = new Set<number>();
      for (let c = 0; c < cols * rows; c++) if (rnd() < 0.4) blocked.add(c);
      // Plant a guaranteed-free rectangle of exactly the minimum size, when
      // the grid can hold one — completeness must then find SOMETHING.
      const plantable = min.w <= cols && min.h <= rows;
      let planted: Slot | null = null;
      if (plantable) {
        planted = {
          col: int(rnd, 0, cols - min.w),
          row: int(rnd, 0, rows - min.h),
          w: min.w,
          h: min.h,
        };
        for (let r = planted.row; r < planted.row + planted.h; r++) {
          for (let c = planted.col; c < planted.col + planted.w; c++) {
            blocked.delete(r * cols + c);
          }
        }
      }
      const cursor = rnd() < 0.5 ? null : { col: int(rnd, 0, cols - 1), row: int(rnd, 0, rows - 1) };
      const slot = bestOpenSlot({ cols, rows, blocked, cursor, min });

      if (planted) expect(slot, `${ctx}: planted rect must be findable`).not.toBeNull();
      if (slot) {
        expect(slot.col >= 0 && slot.row >= 0, ctx).toBe(true);
        expect(slot.col + slot.w <= cols && slot.row + slot.h <= rows, ctx).toBe(true);
        expect(slot.w >= min.w && slot.h >= min.h, ctx).toBe(true);
        for (let r = slot.row; r < slot.row + slot.h; r++) {
          for (let c = slot.col; c < slot.col + slot.w; c++) {
            expect(blocked.has(r * cols + c), `${ctx}: covers blocked cell (${c},${r})`).toBe(false);
          }
        }
      }
      // Cover variant: growing around the planted rect must contain it.
      if (planted) {
        const grown = bestOpenSlot({ cols, rows, blocked, cursor: null, min, cover: planted });
        expect(grown, `${ctx}: cover variant`).not.toBeNull();
        expect(contains(grown!, planted), `${ctx}: grown must contain cover`).toBe(true);
      }
    }
  });
});

// ── brain-level harness ─────────────────────────────────────────────────

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const MON2_ID = '\\\\.\\DISPLAY2@1920,0';
const GRID1_ID = `grid:${MON1_ID}`;
const GRID2_ID = `grid:${MON2_ID}`;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
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
    ...overrides,
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
    monitorId: MON1_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function gridSettings(overrides: Partial<GridSettings>): GridSettings {
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

function harness() {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
    onRestore: () => {},
  });
  brain.setMonitors([makeMonitor(), makeMonitor(({ id: MON2_ID, x: 1920, workX: 1920, primary: false }))]);
  return { brain, applies, snapshots, previews };
}

function lastSnap(snapshots: StateSnapshot[]): StateSnapshot {
  expect(snapshots.length).toBeGreaterThan(0);
  return snapshots[snapshots.length - 1]!;
}

describe('invariant B — auto-split tiles the old span or changes nothing', () => {
  it('holds over 80 random full grids and minimums', () => {
    const rnd = prng(SEED ^ 0x5117);
    for (let i = 0; i < 80; i++) {
      const ctx = `seed ${SEED} iteration ${i}`;
      const cols = int(rnd, 1, 5);
      const rows = int(rnd, 1, 3);
      const cellW = 1920 / cols;
      const h = harness();
      h.brain.enableGrid(gridSettings({ id: GRID2_ID, monitorIds: [MON2_ID], cols, rows }), [
        makeWindow('A2', { monitorId: MON2_ID, x: 1920 }),
      ]);
      h.brain.moveTileFromEditor(GRID2_ID, 'A2', { col: 0, row: 0, w: cols, h: rows });
      // B floats off grid1 (1x1, occupied by A).
      const minW = int(rnd, 0, 1920);
      h.brain.enableGrid(gridSettings({ cols: 1, rows: 1 }), [
        makeWindow('A'),
        makeWindow('B', { x: 600, minWidth: minW }),
      ]);

      const cursorX = 1920 + int(rnd, 0, cols - 1) * cellW + cellW / 2;
      h.brain.moveSizeStart('B');
      h.brain.dragMoved({ hwnd: 'B', cursorX, cursorY: 60, x: 2000, y: 60, width: 500, height: 400 });
      h.brain.moveSizeEnd('B', { x: 2000, y: 60, width: 500, height: 400 });

      const snap = lastSnap(h.snapshots);
      const tiles = snap.tiles[GRID2_ID]!;
      const b = tiles.find((t) => t.hwnd === 'B');
      const a2 = tiles.find((t) => t.hwnd === 'A2');
      expect(a2, ctx).toBeDefined();
      if (b) {
        // Split happened: the two slots are disjoint and tile the victim's
        // old span (the whole grid) exactly.
        expect(overlaps(b.slot, a2!.slot), `${ctx}: split slots overlap`).toBe(false);
        expect(b.slot.w * b.slot.h + a2!.slot.w * a2!.slot.h, ctx).toBe(cols * rows);
        // The newcomer's OS minimum is honoured in cells.
        const minCellsB = Math.max(1, Math.ceil(minW / cellW));
        expect(b.slot.w, `${ctx}: newcomer below its minimum`).toBeGreaterThanOrEqual(
          Math.min(minCellsB, cols),
        );
        expect(snap.floating.map((f) => f.hwnd), ctx).not.toContain('B');
      } else {
        // No split: the victim is untouched and B still floats.
        expect(a2!.slot, `${ctx}: refused drop must change nothing`).toEqual({
          col: 0,
          row: 0,
          w: cols,
          h: rows,
        });
        expect(snap.floating.map((f) => f.hwnd), ctx).toContain('B');
      }
    }
  });
});

describe('invariant C — expand toggles back and never tramples a neighbor', () => {
  it('holds over 80 random grids and tile sets', () => {
    const rnd = prng(SEED ^ 0xe97a);
    for (let i = 0; i < 80; i++) {
      const ctx = `seed ${SEED} iteration ${i}`;
      const cols = int(rnd, 2, 6);
      const rows = int(rnd, 1, 4);
      const h = harness();
      const count = int(rnd, 1, Math.min(3, cols * rows));
      const wins = Array.from({ length: count }, (_, n) => makeWindow(`W${n}`, { x: n * 40 }));
      h.brain.enableGrid(gridSettings({ cols, rows }), wins);
      // Pin every window to its own random distinct cell.
      const cells = new Set<number>();
      while (cells.size < count) cells.add(int(rnd, 0, cols * rows - 1));
      const slots = [...cells].map((c) => ({ col: c % cols, row: Math.floor(c / cols), w: 1, h: 1 }));
      slots.forEach((s, n) => h.brain.moveTileFromEditor(GRID1_ID, `W${n}`, s));

      const pick = int(rnd, 0, count - 1);
      const original = lastSnap(h.snapshots).tiles[GRID1_ID]!.find((t) => t.hwnd === `W${pick}`)!.slot;

      h.brain.windowMaximized(`W${pick}`);
      h.brain.windowRestored(makeWindow(`W${pick}`, { x: original.col * 10 }));
      const afterGrow = lastSnap(h.snapshots).tiles[GRID1_ID]!;
      const grown = afterGrow.find((t) => t.hwnd === `W${pick}`)!.slot;
      expect(contains(grown, original), `${ctx}: grown must contain the original`).toBe(true);
      for (const t of afterGrow) {
        if (t.hwnd === `W${pick}`) continue;
        expect(overlaps(grown, t.slot), `${ctx}: expand trampled ${t.hwnd}`).toBe(false);
      }

      h.brain.windowMaximized(`W${pick}`);
      h.brain.windowRestored(makeWindow(`W${pick}`, { x: original.col * 10 }));
      const back = lastSnap(h.snapshots).tiles[GRID1_ID]!.find((t) => t.hwnd === `W${pick}`)!.slot;
      expect(back, `${ctx}: toggle must return the original slot`).toEqual(original);
    }
  });
});
