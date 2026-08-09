// px ⇄ cell mapping. All pixel values are physical virtual-desktop pixels.
// Cell edges use floor-accumulate (edge(i) = floor(i * extent / count)) so that
// adjacent cells tile exactly, every edge is an integer, and the last
// column/row absorbs the remainder of a non-integer division.
//
// v0.2.0 spacing (spec §1): a grid may carry `padding` (insets the usable
// area on all four sides) and `gap` (space between adjacent cells). All cell
// math runs on the *effective* work area — the work area shrunk by padding —
// with `unitW = (effWidth - gap*(cols-1)) / cols`; a w-cell footprint spans
// `w*unitW + (w-1)*gap` (interior gaps belong to the tile's rect, so
// neighbors always sit exactly `gap` apart). Floor-accumulate runs over the
// gap-free content extent, keeping every edge an integer and the last
// column/row flush with the effective far edge. A gap too large for the
// extent is coerced down so cells keep at least MIN_UNIT_PX; with gap 0 and
// padding 0 every function below reproduces the v0.1.0 math exactly.

import type { MonitorInfo, Slot } from './types';

export interface GridDims {
  cols: number;
  rows: number;
  /** Space between adjacent cells, physical px (spec v0.2 §1). Default 0. */
  gap?: number;
  /** Inset of the usable area from every work-area edge, physical px. Default 0. */
  padding?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest cell content size the gap coercion protects (spec v0.2 §5). */
export const MIN_UNIT_PX = 16;
/** Upper bound of the gap/padding settings range (spec v0.2 §1: 0–64). */
export const MAX_SPACING_PX = 64;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Normalize a raw gap/padding value: integer px in 0..MAX_SPACING_PX. */
export function clampSpacing(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp(Math.floor(v), 0, MAX_SPACING_PX);
}

/**
 * The effective work area of a grid on `mon` plus the per-axis gaps actually
 * in force. Padding is clamped so the area never collapses below 1px per
 * axis; the gap is coerced down per axis (spec v0.2 §1) so
 * `unit = (extent - gap*(count-1)) / count` stays >= MIN_UNIT_PX — as far as
 * gap 0 allows.
 */
export interface EffectiveArea {
  x: number;
  y: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
}

export function effectiveSpacing(mon: MonitorInfo, grid: GridDims): EffectiveArea {
  const pad = clampSpacing(grid.padding);
  const padX = Math.min(pad, Math.max(0, Math.floor((mon.workWidth - 1) / 2)));
  const padY = Math.min(pad, Math.max(0, Math.floor((mon.workHeight - 1) / 2)));
  const width = mon.workWidth - 2 * padX;
  const height = mon.workHeight - 2 * padY;
  const gap = clampSpacing(grid.gap);
  return {
    x: mon.workX + padX,
    y: mon.workY + padY,
    width,
    height,
    gapX: coerceGap(gap, grid.cols, width),
    gapY: coerceGap(gap, grid.rows, height),
  };
}

/**
 * The largest gap (<= wanted) keeping `unit >= MIN_UNIT_PX` over `extent`
 * split into `count` cells. Never negative; when even gap 0 cannot reach
 * MIN_UNIT_PX the gap collapses to 0 (tiny monitors keep working exactly as
 * they did without spacing).
 */
function coerceGap(wanted: number, count: number, extent: number): number {
  if (count <= 1 || wanted === 0) return 0;
  if ((extent - wanted * (count - 1)) / count >= MIN_UNIT_PX) return wanted;
  const max = Math.floor((extent - MIN_UNIT_PX * count) / (count - 1));
  return Math.max(0, Math.min(wanted, max));
}

/**
 * Gap-free content offset of grid line `i` out of `count` over the effective
 * extent (floor-accumulate over `extent - gap*(count-1)`).
 */
function contentEdge(extent: number, count: number, gap: number, i: number): number {
  const content = extent - gap * (count - 1);
  if (i >= count) return content; // last line lands exactly on the far edge
  return Math.floor((i * content) / count);
}

/** Offset (effective-area-relative) where cell `i` starts. */
function cellStart(extent: number, count: number, gap: number, i: number): number {
  return contentEdge(extent, count, gap, i) + i * gap;
}

/**
 * Offset where the content of cell `i - 1` ends — the far edge of a
 * footprint whose exclusive end index is `i`. Interior gaps up to that cell
 * are included, the trailing gap is not (it belongs to the neighbor seam).
 */
function cellFarEdge(extent: number, count: number, gap: number, i: number): number {
  return contentEdge(extent, count, gap, i) + Math.max(0, i - 1) * gap;
}

/**
 * Absolute virtual-desktop pixel rect covered by `slot` on `mon`'s work area,
 * honoring the grid's gap/padding. A multi-cell footprint owns its interior
 * gaps (spec v0.2 §1), so two adjacent footprints are always `gap` apart.
 * Assumes the slot is within grid bounds.
 */
export function cellRect(mon: MonitorInfo, grid: GridDims, slot: Slot): Rect {
  const eff = effectiveSpacing(mon, grid);
  const x0 = cellStart(eff.width, grid.cols, eff.gapX, slot.col);
  const x1 = cellFarEdge(eff.width, grid.cols, eff.gapX, slot.col + slot.w);
  const y0 = cellStart(eff.height, grid.rows, eff.gapY, slot.row);
  const y1 = cellFarEdge(eff.height, grid.rows, eff.gapY, slot.row + slot.h);
  return {
    x: eff.x + x0,
    y: eff.y + y0,
    width: x1 - x0,
    height: y1 - y0,
  };
}

/**
 * Snap a pixel rect to the nearest grid slot: nearest-cell rounding of origin
 * and size on the gapped pitch (`unit + gap`), minimum footprint 1×1,
 * clamped so the slot lies fully in bounds.
 */
export function snapRectToSlot(mon: MonitorInfo, grid: GridDims, rect: Rect): Slot {
  const eff = effectiveSpacing(mon, grid);
  const unitW = (eff.width - eff.gapX * (grid.cols - 1)) / grid.cols;
  const unitH = (eff.height - eff.gapY * (grid.rows - 1)) / grid.rows;
  const pitchW = unitW + eff.gapX;
  const pitchH = unitH + eff.gapY;

  // A w-cell footprint is w*unit + (w-1)*gap = w*pitch - gap px wide.
  const w = clamp(Math.round((rect.width + eff.gapX) / pitchW), 1, grid.cols);
  const h = clamp(Math.round((rect.height + eff.gapY) / pitchH), 1, grid.rows);
  const col = clamp(Math.round((rect.x - eff.x) / pitchW), 0, grid.cols - w);
  const row = clamp(Math.round((rect.y - eff.y) / pitchH), 0, grid.rows - h);
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
  const eff = effectiveSpacing(mon, grid);
  const unitW = (eff.width - eff.gapX * (grid.cols - 1)) / grid.cols;
  const unitH = (eff.height - eff.gapY * (grid.rows - 1)) / grid.rows;
  const pitchW = unitW + eff.gapX;
  const pitchH = unitH + eff.gapY;

  const w = clamp(footprint.w, 1, grid.cols);
  const h = clamp(footprint.h, 1, grid.rows);
  const col = clamp(
    Math.round((cursorX - eff.x) / pitchW - w / 2),
    0,
    grid.cols - w,
  );
  const row = clamp(
    Math.round((cursorY - eff.y) / pitchH - h / 2),
    0,
    grid.rows - h,
  );
  return { col, row, w, h };
}
