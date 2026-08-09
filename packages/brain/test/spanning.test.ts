// Task 17 — pure spanning helpers: union work area, dead-space cells of an
// L-shaped 2-monitor union, and nearest-usable-slot snapping.

import { describe, expect, it } from 'vitest';
import {
  cellIndex,
  computeUnusableCells,
  nearestUsableSlot,
  rectCoveredByWorkAreas,
  slotUsable,
  spanGridId,
  unionWorkArea,
} from '../src/spanning';
import type { GridDims } from '../src/coords';
import type { MonitorInfo } from '../src/types';

// L-shaped union: A is 1920×1080 at the origin, B is 1280×720 to its right,
// top-aligned. Dead space: x 1920..3200, y 720..1080.
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

// 8×4 grid over the 3200×1080 union → exact 400×270 cells.
const DIMS: GridDims = { cols: 8, rows: 4 };

function lShapeUnusable(): Set<number> {
  return computeUnusableCells(unionWorkArea([MON_A, MON_B]), DIMS, [MON_A, MON_B]);
}

describe('spanGridId', () => {
  it('sorts monitor ids and joins with "+"', () => {
    expect(spanGridId([MON_B.id, MON_A.id])).toBe(
      `grid:span:${MON_A.id}+${MON_B.id}`,
    );
    expect(spanGridId([MON_A.id, MON_B.id])).toBe(spanGridId([MON_B.id, MON_A.id]));
  });
});

describe('unionWorkArea', () => {
  it('is the bounding box of the members work areas', () => {
    const u = unionWorkArea([MON_A, MON_B]);
    expect(u.workX).toBe(0);
    expect(u.workY).toBe(0);
    expect(u.workWidth).toBe(3200);
    expect(u.workHeight).toBe(1080);
    expect(u.x).toBe(0);
    expect(u.y).toBe(0);
    expect(u.width).toBe(3200);
    expect(u.height).toBe(1080);
    expect(u.primary).toBe(true);
  });

  it('includes taskbar insets of the members', () => {
    const a = { ...MON_A, workY: 48, workHeight: 1032 };
    const u = unionWorkArea([a, MON_B]);
    expect(u.workY).toBe(0); // B still starts at 0
    expect(u.workHeight).toBe(1080);
  });

  it('throws on an empty list', () => {
    expect(() => unionWorkArea([])).toThrow();
  });
});

describe('computeUnusableCells (L-shaped union)', () => {
  it('marks exactly the cells over the dead space', () => {
    const dead = lShapeUnusable();
    // Dead space: x ≥ 1920 (column 4 straddles the seam at x=1600..2000),
    // y ≥ 720 (row 2 straddles 540..810). Every cell with col ≥ 4 and
    // row ≥ 2 touches uncovered area; everything else is covered.
    const expected = new Set<number>();
    for (let row = 2; row < 4; row++) {
      for (let col = 4; col < 8; col++) expected.add(cellIndex(DIMS, col, row));
    }
    expect(dead).toEqual(expected);
  });

  it('is empty when the union is a perfect rectangle', () => {
    const b = { ...MON_B, height: 1080, workHeight: 1080 };
    const union = unionWorkArea([MON_A, b]);
    expect(computeUnusableCells(union, DIMS, [MON_A, b]).size).toBe(0);
  });

  it('treats a cell straddling the seam of adjacent monitors as usable', () => {
    const dead = lShapeUnusable();
    // Cell (4,0) covers x 1600..2000 — A covers up to 1920, B the rest.
    expect(dead.has(cellIndex(DIMS, 4, 0))).toBe(false);
  });

  it('marks cells over a gap between non-adjacent monitors as dead', () => {
    const b = { ...MON_B, x: 2000, workX: 2000, height: 1080, workHeight: 1080 };
    const union = unionWorkArea([MON_A, b]);
    const dead = computeUnusableCells(union, DIMS, [MON_A, b]);
    // Union is 3280 wide; the 80 px gap at x 1920..2000 falls inside some
    // column of every row — no row can be fully usable across the seam.
    expect(dead.size).toBeGreaterThan(0);
  });
});

describe('slotUsable', () => {
  const dead = lShapeUnusable();

  it('accepts slots fully over live cells', () => {
    expect(slotUsable(DIMS, dead, { col: 0, row: 0, w: 8, h: 2 })).toBe(true);
    expect(slotUsable(DIMS, dead, { col: 0, row: 2, w: 4, h: 2 })).toBe(true);
  });

  it('rejects slots touching any dead cell', () => {
    expect(slotUsable(DIMS, dead, { col: 4, row: 2, w: 1, h: 1 })).toBe(false);
    expect(slotUsable(DIMS, dead, { col: 3, row: 1, w: 2, h: 2 })).toBe(false); // corner
  });

  it('rejects out-of-bounds slots', () => {
    expect(slotUsable(DIMS, dead, { col: 7, row: 0, w: 2, h: 1 })).toBe(false);
    expect(slotUsable(DIMS, dead, { col: -1, row: 0, w: 1, h: 1 })).toBe(false);
  });
});

describe('nearestUsableSlot', () => {
  const dead = lShapeUnusable();

  it('returns the slot itself when already usable', () => {
    const s = { col: 6, row: 1, w: 2, h: 1 };
    expect(nearestUsableSlot(DIMS, dead, s)).toEqual(s);
  });

  it('snaps a dead-zone slot to the nearest usable position', () => {
    // 1×1 at (6,2) — dead. Nearest usable: (6,1), one row up.
    expect(nearestUsableSlot(DIMS, dead, { col: 6, row: 2, w: 1, h: 1 })).toEqual({
      col: 6,
      row: 1,
      w: 1,
      h: 1,
    });
    // 2×2 at (6,2) — dead. Nearest usable 2×2 is at (6,0).
    expect(nearestUsableSlot(DIMS, dead, { col: 6, row: 2, w: 2, h: 2 })).toEqual({
      col: 6,
      row: 0,
      w: 2,
      h: 2,
    });
  });

  it('shrinks the footprint when no position of it is usable', () => {
    // A full-grid 8×4 slot cannot avoid the dead corner; it must shrink.
    const s = nearestUsableSlot(DIMS, dead, { col: 0, row: 0, w: 8, h: 4 });
    expect(s).not.toBeNull();
    expect(slotUsable(DIMS, dead, s!)).toBe(true);
    expect(s!.w * s!.h).toBeLessThan(32);
  });

  it('returns null only when the grid has zero usable cells', () => {
    const allDead = new Set<number>();
    for (let i = 0; i < DIMS.cols * DIMS.rows; i++) allDead.add(i);
    expect(nearestUsableSlot(DIMS, allDead, { col: 0, row: 0, w: 1, h: 1 })).toBeNull();
  });
});

describe('rectCoveredByWorkAreas', () => {
  it('covers a rect spanning the seam of adjacent monitors', () => {
    expect(
      rectCoveredByWorkAreas(
        { x: 1600, y: 0, width: 800, height: 700 },
        [MON_A, MON_B],
      ),
    ).toBe(true);
  });

  it('rejects a rect dipping into the dead space', () => {
    expect(
      rectCoveredByWorkAreas(
        { x: 2000, y: 600, width: 400, height: 200 },
        [MON_A, MON_B],
      ),
    ).toBe(false);
  });
});
