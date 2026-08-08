import { describe, expect, it } from 'vitest';
import { cellRect, slotFromCursor, snapRectToSlot } from '../src/coords';
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
