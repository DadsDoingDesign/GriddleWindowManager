// px ⇄ cell mapping. All pixel values are physical virtual-desktop pixels.
// Cell edges use floor-accumulate (edge(i) = floor(i * extent / count)) so that
// adjacent cells tile exactly, every edge is an integer, and the last
// column/row absorbs the remainder of a non-integer division.

import type { MonitorInfo, Slot } from './types';

export interface GridDims {
  cols: number;
  rows: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Pixel offset (work-area-relative) of grid line `i` out of `count` over `extent` px. */
function edge(extent: number, count: number, i: number): number {
  if (i >= count) return extent; // last line lands exactly on the far edge
  return Math.floor((i * extent) / count);
}

/**
 * Absolute virtual-desktop pixel rect covered by `slot` on `mon`'s work area.
 * Assumes the slot is within grid bounds.
 */
export function cellRect(mon: MonitorInfo, grid: GridDims, slot: Slot): Rect {
  const x0 = edge(mon.workWidth, grid.cols, slot.col);
  const x1 = edge(mon.workWidth, grid.cols, slot.col + slot.w);
  const y0 = edge(mon.workHeight, grid.rows, slot.row);
  const y1 = edge(mon.workHeight, grid.rows, slot.row + slot.h);
  return {
    x: mon.workX + x0,
    y: mon.workY + y0,
    width: x1 - x0,
    height: y1 - y0,
  };
}

/**
 * Snap a pixel rect to the nearest grid slot: nearest-cell rounding of origin
 * and size, minimum footprint 1×1, clamped so the slot lies fully in bounds.
 */
export function snapRectToSlot(mon: MonitorInfo, grid: GridDims, rect: Rect): Slot {
  const unitW = mon.workWidth / grid.cols;
  const unitH = mon.workHeight / grid.rows;

  let w = clamp(Math.round(rect.width / unitW), 1, grid.cols);
  let h = clamp(Math.round(rect.height / unitH), 1, grid.rows);
  const col = clamp(Math.round((rect.x - mon.workX) / unitW), 0, grid.cols - w);
  const row = clamp(Math.round((rect.y - mon.workY) / unitH), 0, grid.rows - h);
  return { col, row, w, h };
}

/**
 * Slot for a footprint of `footprint.w`×`footprint.h` cells centered on the
 * cursor, clamped fully inside the grid. Footprint is clamped to grid size
 * and to a 1×1 minimum.
 */
export function slotFromCursor(
  mon: MonitorInfo,
  grid: GridDims,
  cursorX: number,
  cursorY: number,
  footprint: { w: number; h: number },
): Slot {
  const unitW = mon.workWidth / grid.cols;
  const unitH = mon.workHeight / grid.rows;

  const w = clamp(footprint.w, 1, grid.cols);
  const h = clamp(footprint.h, 1, grid.rows);
  const col = clamp(
    Math.round((cursorX - mon.workX) / unitW - w / 2),
    0,
    grid.cols - w,
  );
  const row = clamp(
    Math.round((cursorY - mon.workY) / unitH - h / 2),
    0,
    grid.rows - h,
  );
  return { col, row, w, h };
}
