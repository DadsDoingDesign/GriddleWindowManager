import { describe, expect, it } from 'vitest';
import {
  cellRect,
  effectiveSpacing,
  MAX_SPACING_PX,
  MIN_UNIT_PX,
  slotFromCursor,
  snapRectToSlot,
} from '../src/coords';
import type { MonitorInfo, Slot } from '../src/types';

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: '\\\\.\\DISPLAY1@0,0',
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

// 1920×1032 work area at (0,48), 12×6 grid → unit 160×172
const mon = makeMonitor();
const grid = { cols: 12, rows: 6 };

describe('cellRect', () => {
  it('maps a 1×1 slot at origin to one unit cell (160×172) at the work-area origin', () => {
    expect(cellRect(mon, grid, { col: 0, row: 0, w: 1, h: 1 })).toEqual({
      x: 0,
      y: 48,
      width: 160,
      height: 172,
    });
  });

  it('maps {col:2,row:1,w:3,h:2} to {x:320,y:220,width:480,height:344}', () => {
    expect(cellRect(mon, grid, { col: 2, row: 1, w: 3, h: 2 })).toEqual({
      x: 320,
      y: 220,
      width: 480,
      height: 344,
    });
  });

  it('produces absolute virtual-desktop coordinates for a monitor not at the origin', () => {
    const mon2 = makeMonitor({
      id: '\\\\.\\DISPLAY2@1920,0',
      x: 1920,
      y: 0,
      workX: 1920,
      workY: 48,
      primary: false,
    });
    expect(cellRect(mon2, grid, { col: 2, row: 1, w: 3, h: 2 })).toEqual({
      x: 1920 + 320,
      y: 220,
      width: 480,
      height: 344,
    });
  });

  describe('non-integer division (2560 / 12)', () => {
    const wide = makeMonitor({
      id: '\\\\.\\DISPLAY3@0,0',
      width: 2560,
      height: 1440,
      workWidth: 2560,
      workHeight: 1392,
    });

    it('cellRect widths of every column sum to <= workWidth', () => {
      let sum = 0;
      for (let col = 0; col < grid.cols; col++) {
        sum += cellRect(wide, grid, { col, row: 0, w: 1, h: 1 }).width;
      }
      expect(sum).toBeLessThanOrEqual(wide.workWidth);
    });

    it('adjacent cells tile exactly with integer edges (floor-accumulate)', () => {
      let expectedX = wide.workX;
      for (let col = 0; col < grid.cols; col++) {
        const r = cellRect(wide, grid, { col, row: 0, w: 1, h: 1 });
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.width)).toBe(true);
        expect(r.x).toBe(expectedX);
        expectedX = r.x + r.width;
      }
    });

    it('a full-width slot reaches exactly the right work-area edge (last column gets the remainder)', () => {
      const r = cellRect(wide, grid, { col: 0, row: 0, w: 12, h: 1 });
      expect(r.x + r.width).toBe(wide.workX + wide.workWidth);
      const last = cellRect(wide, grid, { col: 11, row: 0, w: 1, h: 1 });
      expect(last.x + last.width).toBe(wide.workX + wide.workWidth);
    });
  });
});

describe('snapRectToSlot', () => {
  it('snaps {x:250,y:100,width:500,height:400} to {col:2,row:0,w:3,h:2}', () => {
    expect(
      snapRectToSlot(mon, grid, { x: 250, y: 100, width: 500, height: 400 }),
    ).toEqual({ col: 2, row: 0, w: 3, h: 2 });
  });

  it('clamps a rect hanging past the right edge so col + w <= cols', () => {
    const slot = snapRectToSlot(mon, grid, {
      x: 1800,
      y: 48,
      width: 500,
      height: 344,
    });
    expect(slot.col + slot.w).toBeLessThanOrEqual(grid.cols);
    expect(slot.w).toBe(3);
    expect(slot.col).toBe(9);
  });

  it('clamps a rect hanging past the bottom edge so row + h <= rows', () => {
    const slot = snapRectToSlot(mon, grid, {
      x: 0,
      y: 900,
      width: 320,
      height: 700,
    });
    expect(slot.row + slot.h).toBeLessThanOrEqual(grid.rows);
  });

  it('never returns a footprint smaller than 1×1', () => {
    const slot = snapRectToSlot(mon, grid, { x: 10, y: 60, width: 8, height: 5 });
    expect(slot.w).toBe(1);
    expect(slot.h).toBe(1);
  });

  it('clamps a rect positioned before the work-area origin to col/row 0', () => {
    const slot = snapRectToSlot(mon, grid, {
      x: -200,
      y: -100,
      width: 480,
      height: 344,
    });
    expect(slot.col).toBe(0);
    expect(slot.row).toBe(0);
  });

  it('a rect larger than the whole grid clamps to the full grid', () => {
    const slot = snapRectToSlot(mon, grid, {
      x: -100,
      y: 0,
      width: 4000,
      height: 3000,
    });
    expect(slot).toEqual({ col: 0, row: 0, w: 12, h: 6 });
  });
});

describe('slotFromCursor', () => {
  it('centers the footprint on the cursor', () => {
    // cursor at center of work area → 3×2 footprint centered there
    const slot = slotFromCursor(mon, grid, 960, 48 + 516, { w: 3, h: 2 });
    // 960/160 = 6 → col = round(6 - 1.5) = 5 (or 4/5 boundary); footprint stays in bounds
    expect(slot.w).toBe(3);
    expect(slot.h).toBe(2);
    expect(slot.col).toBeGreaterThanOrEqual(4);
    expect(slot.col + slot.w).toBeLessThanOrEqual(8);
    expect(slot.row).toBeGreaterThanOrEqual(1);
    expect(slot.row + slot.h).toBeLessThanOrEqual(4);
  });

  it('cursor at the top-left monitor corner keeps the footprint fully in bounds', () => {
    const slot = slotFromCursor(mon, grid, 0, 0, { w: 3, h: 2 });
    expect(slot).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('cursor at the bottom-right monitor corner keeps the footprint fully in bounds', () => {
    const slot = slotFromCursor(mon, grid, 1919, 1079, { w: 3, h: 2 });
    expect(slot).toEqual({ col: 9, row: 4, w: 3, h: 2 });
  });

  it('clamps an oversized footprint to the grid dimensions', () => {
    const slot = slotFromCursor(mon, grid, 960, 500, { w: 20, h: 10 });
    expect(slot).toEqual({ col: 0, row: 0, w: 12, h: 6 });
  });

  it('footprint is at least 1×1 even for degenerate input', () => {
    const slot = slotFromCursor(mon, grid, 960, 500, { w: 0, h: 0 });
    expect(slot.w).toBe(1);
    expect(slot.h).toBe(1);
  });
});

describe('types', () => {
  it('Slot shape is structurally usable', () => {
    const s: Slot = { col: 0, row: 0, w: 1, h: 1 };
    expect(s).toBeTruthy();
  });
});

// ── v0.2.0 spacing (spec §1): gap + padding ────────────────────────────────

describe('effectiveSpacing', () => {
  it('padding insets the work area on all four sides', () => {
    const eff = effectiveSpacing(mon, { cols: 12, rows: 6, padding: 16 });
    expect(eff).toMatchObject({
      x: 16,
      y: 48 + 16,
      width: 1920 - 32,
      height: 1032 - 32,
    });
  });

  it('defaults to zero spacing when gap/padding are absent', () => {
    expect(effectiveSpacing(mon, grid)).toEqual({
      x: mon.workX,
      y: mon.workY,
      width: mon.workWidth,
      height: mon.workHeight,
      gapX: 0,
      gapY: 0,
    });
  });

  it('keeps the requested gap when units stay >= MIN_UNIT_PX', () => {
    const eff = effectiveSpacing(mon, { cols: 12, rows: 6, gap: 8 });
    expect(eff.gapX).toBe(8);
    expect(eff.gapY).toBe(8);
  });

  it('coerces the gap down so unitW >= 16px when gap*(cols-1) crowds the extent', () => {
    // 300px extent, 12 cols, gap 64: 64*11 = 704 >= 300 → coerced.
    const tiny = makeMonitor({ workWidth: 300 });
    const eff = effectiveSpacing(tiny, { cols: 12, rows: 6, gap: 64 });
    // max gap keeping unitW >= 16: floor((300 - 16*12) / 11) = 9
    expect(eff.gapX).toBe(9);
    const unitW = (eff.width - eff.gapX * 11) / 12;
    expect(unitW).toBeGreaterThanOrEqual(MIN_UNIT_PX);
    // The y-axis is untouched (1032px has room for gap 64).
    expect(eff.gapY).toBe(64);
  });

  it('coerces the gap to 0 when even gap 0 cannot reach MIN_UNIT_PX', () => {
    const tiny = makeMonitor({ workWidth: 100 });
    const eff = effectiveSpacing(tiny, { cols: 12, rows: 6, gap: 30 });
    expect(eff.gapX).toBe(0);
  });

  it('clamps out-of-range gap/padding into 0..MAX_SPACING_PX', () => {
    const eff = effectiveSpacing(mon, { cols: 12, rows: 6, gap: 999, padding: -7 });
    expect(eff.gapX).toBe(MAX_SPACING_PX);
    expect(eff.gapY).toBe(MAX_SPACING_PX);
    expect(eff.x).toBe(mon.workX);
    expect(eff.width).toBe(mon.workWidth);
  });
});

describe('cellRect with gap + padding', () => {
  // eff area: x 16, y 64, 1888×1000; unitW = (1888-88)/12 = 150 exactly;
  // unitH = (1000-40)/6 = 160 exactly.
  const spaced = { cols: 12, rows: 6, gap: 8, padding: 16 };

  it('origin cell starts at the padded origin with the exact unit size', () => {
    expect(cellRect(mon, spaced, { col: 0, row: 0, w: 1, h: 1 })).toEqual({
      x: 16,
      y: 64,
      width: 150,
      height: 160,
    });
  });

  it('a w-cell footprint spans w*unitW + (w-1)*gap (interior gaps belong to the tile)', () => {
    const r = cellRect(mon, spaced, { col: 0, row: 0, w: 3, h: 2 });
    expect(r.width).toBe(3 * 150 + 2 * 8);
    expect(r.height).toBe(2 * 160 + 1 * 8);
  });

  it('adjacent cells are separated by exactly the gap', () => {
    const a = cellRect(mon, spaced, { col: 2, row: 0, w: 1, h: 1 });
    const b = cellRect(mon, spaced, { col: 3, row: 0, w: 1, h: 1 });
    expect(b.x - (a.x + a.width)).toBe(8);
    const c = cellRect(mon, spaced, { col: 0, row: 1, w: 1, h: 1 });
    const d = cellRect(mon, spaced, { col: 0, row: 2, w: 1, h: 1 });
    expect(d.y - (c.y + c.height)).toBe(8);
  });

  it('a full-width footprint stays flush with the padded far edge', () => {
    const r = cellRect(mon, spaced, { col: 0, row: 0, w: 12, h: 6 });
    expect(r.x).toBe(16);
    expect(r.x + r.width).toBe(1920 - 16);
    expect(r.y + r.height).toBe(48 + 1032 - 16);
  });

  describe('floor-accumulate rounding at odd resolutions (2560/12 with gap 7)', () => {
    const wide = makeMonitor({
      id: '\\\\.\\DISPLAY3@0,0',
      width: 2560,
      height: 1440,
      workWidth: 2560,
      workHeight: 1392,
    });
    const dims = { cols: 12, rows: 6, gap: 7, padding: 5 };

    it('all edges are integers and consecutive cells sit exactly gap apart', () => {
      let prev: { x: number; width: number } | null = null;
      for (let col = 0; col < dims.cols; col++) {
        const r = cellRect(wide, dims, { col, row: 0, w: 1, h: 1 });
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.width)).toBe(true);
        if (prev) expect(r.x - (prev.x + prev.width)).toBe(7);
        prev = r;
      }
    });

    it('the last column ends exactly at the padded right edge', () => {
      const last = cellRect(wide, dims, { col: 11, row: 0, w: 1, h: 1 });
      expect(last.x + last.width).toBe(wide.workX + wide.workWidth - 5);
      const full = cellRect(wide, dims, { col: 0, row: 0, w: 12, h: 1 });
      expect(full.x + full.width).toBe(wide.workX + wide.workWidth - 5);
    });

    it('multi-cell footprints tile without overlap: [0..k) + [k..12) meet gap apart', () => {
      for (let k = 1; k < 12; k++) {
        const left = cellRect(wide, dims, { col: 0, row: 0, w: k, h: 1 });
        const right = cellRect(wide, dims, { col: k, row: 0, w: 12 - k, h: 1 });
        expect(right.x - (left.x + left.width)).toBe(7);
      }
    });
  });

  it('gap 0 + padding 0 reproduces the legacy (unspaced) rects exactly', () => {
    for (const slot of [
      { col: 0, row: 0, w: 1, h: 1 },
      { col: 2, row: 1, w: 3, h: 2 },
      { col: 11, row: 5, w: 1, h: 1 },
    ]) {
      expect(cellRect(mon, { cols: 12, rows: 6, gap: 0, padding: 0 }, slot)).toEqual(
        cellRect(mon, grid, slot),
      );
    }
  });
});

describe('snapRectToSlot / slotFromCursor with gap + padding', () => {
  const spaced = { cols: 12, rows: 6, gap: 8, padding: 16 };

  it('snapping a cellRect back returns the identical slot', () => {
    for (const slot of [
      { col: 0, row: 0, w: 1, h: 1 },
      { col: 2, row: 1, w: 3, h: 2 },
      { col: 9, row: 4, w: 3, h: 2 },
      { col: 0, row: 0, w: 12, h: 6 },
    ]) {
      const r = cellRect(mon, spaced, slot);
      expect(snapRectToSlot(mon, spaced, r)).toEqual(slot);
    }
  });

  it('a rect at the unpadded work-area origin clamps into the padded grid', () => {
    const slot = snapRectToSlot(mon, spaced, { x: 0, y: 48, width: 500, height: 400 });
    expect(slot.col).toBe(0);
    expect(slot.row).toBe(0);
  });

  it('slotFromCursor centers the footprint using the gapped pitch', () => {
    // Center of cell col 6 (x = 16 + 6*158 + 75 = 1039): a 3-wide footprint
    // centered there starts at col 5 (round(6.03... - 1.5) = 5).
    const slot = slotFromCursor(mon, spaced, 1039, 64 + 500, { w: 3, h: 2 });
    expect(slot.w).toBe(3);
    expect(slot.h).toBe(2);
    expect(slot.col).toBeGreaterThanOrEqual(4);
    expect(slot.col + slot.w).toBeLessThanOrEqual(8);
  });

  it('cursor at the monitor corners keeps the footprint in bounds', () => {
    expect(slotFromCursor(mon, spaced, 0, 0, { w: 3, h: 2 })).toEqual({
      col: 0,
      row: 0,
      w: 3,
      h: 2,
    });
    expect(slotFromCursor(mon, spaced, 1919, 1079, { w: 3, h: 2 })).toEqual({
      col: 9,
      row: 4,
      w: 3,
      h: 2,
    });
  });
});
