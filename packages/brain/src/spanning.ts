// Spanning grids (spec §5.7, plan Task 17) — pure helpers for grids that
// cover several monitors. A spanning grid does all its cell math against a
// synthetic "union monitor" whose work area is the bounding box of the
// members' work areas; cells that fall in the dead space of an L-shaped
// union (area covered by no monitor) are unusable and excluded from
// placement, snapping, and previews. All pixel values are physical
// virtual-desktop pixels, matching coords.ts.

import { cellRect, type GridDims, type Rect } from './coords';
import type { MonitorInfo, Slot } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Canonical spanning-grid id (plan global constraints): sorted ids, "+"-joined. */
export function spanGridId(monitorIds: string[]): string {
  return `grid:span:${[...monitorIds].sort().join('+')}`;
}

/**
 * Synthetic MonitorInfo for a spanning grid: the work area is the bounding
 * box of the members' work areas (the grid's coordinate space), the full
 * bounds are the bounding box of the members' full bounds. DPI comes from
 * the primary member if present, else the first — per spec §5.7 all layout
 * math stays in physical pixels, so this value is informational only.
 */
export function unionWorkArea(mons: MonitorInfo[]): MonitorInfo {
  if (mons.length === 0) {
    throw new Error('unionWorkArea: at least one monitor required');
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let wx0 = Infinity;
  let wy0 = Infinity;
  let wx1 = -Infinity;
  let wy1 = -Infinity;
  for (const m of mons) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.width);
    y1 = Math.max(y1, m.y + m.height);
    wx0 = Math.min(wx0, m.workX);
    wy0 = Math.min(wy0, m.workY);
    wx1 = Math.max(wx1, m.workX + m.workWidth);
    wy1 = Math.max(wy1, m.workY + m.workHeight);
  }
  const lead = mons.find((m) => m.primary) ?? mons[0]!;
  return {
    id: mons
      .map((m) => m.id)
      .sort()
      .join('+'),
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    workX: wx0,
    workY: wy0,
    workWidth: wx1 - wx0,
    workHeight: wy1 - wy0,
    dpi: lead.dpi,
    primary: mons.some((m) => m.primary),
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Whether `rect` is fully covered by the union of `covers` (rect subtraction:
 * peel off the part covered by one rect, recurse on the up-to-4 remainder
 * strips). Adjacent covers with no gap jointly cover a rect that straddles
 * their seam.
 */
function rectCovered(rect: Rect, covers: Rect[]): boolean {
  const stack: Rect[] = [rect];
  while (stack.length > 0) {
    const r = stack.pop()!;
    if (r.width <= 0 || r.height <= 0) continue;
    const c = covers.find((v) => intersects(r, v));
    if (!c) return false;
    const ix0 = Math.max(r.x, c.x);
    const iy0 = Math.max(r.y, c.y);
    const ix1 = Math.min(r.x + r.width, c.x + c.width);
    const iy1 = Math.min(r.y + r.height, c.y + c.height);
    // Remainder: full-width strips above/below, side strips within the band.
    if (iy0 > r.y) stack.push({ x: r.x, y: r.y, width: r.width, height: iy0 - r.y });
    if (iy1 < r.y + r.height) {
      stack.push({ x: r.x, y: iy1, width: r.width, height: r.y + r.height - iy1 });
    }
    if (ix0 > r.x) stack.push({ x: r.x, y: iy0, width: ix0 - r.x, height: iy1 - iy0 });
    if (ix1 < r.x + r.width) {
      stack.push({ x: ix1, y: iy0, width: r.x + r.width - ix1, height: iy1 - iy0 });
    }
  }
  return true;
}

/** Whether a pixel rect lies fully inside the union of the monitors' work areas. */
export function rectCoveredByWorkAreas(rect: Rect, mons: MonitorInfo[]): boolean {
  return rectCovered(
    rect,
    mons.map((m) => ({
      x: m.workX,
      y: m.workY,
      width: m.workWidth,
      height: m.workHeight,
    })),
  );
}

/** Flat index of a cell, matching the sets built by computeUnusableCells. */
export function cellIndex(dims: GridDims, col: number, row: number): number {
  return row * dims.cols + col;
}

/**
 * Indexes (row * cols + col) of grid cells not fully covered by the union of
 * the monitors' work areas — the dead space of an L-shaped spanning grid.
 * A single-monitor grid always yields an empty set (its grid is defined on
 * exactly its own work area).
 */
export function computeUnusableCells(
  union: MonitorInfo,
  dims: GridDims,
  mons: MonitorInfo[],
): Set<number> {
  const out = new Set<number>();
  const covers = mons.map((m) => ({
    x: m.workX,
    y: m.workY,
    width: m.workWidth,
    height: m.workHeight,
  }));
  for (let row = 0; row < dims.rows; row++) {
    for (let col = 0; col < dims.cols; col++) {
      const rect = cellRect(union, dims, { col, row, w: 1, h: 1 });
      if (!rectCovered(rect, covers)) out.add(cellIndex(dims, col, row));
    }
  }
  return out;
}

/** True when `slot` is fully inside the grid and touches no unusable cell. */
export function slotUsable(
  dims: GridDims,
  unusable: ReadonlySet<number>,
  slot: Slot,
): boolean {
  if (slot.w < 1 || slot.h < 1) return false;
  if (slot.col < 0 || slot.row < 0) return false;
  if (slot.col + slot.w > dims.cols || slot.row + slot.h > dims.rows) return false;
  if (unusable.size === 0) return true;
  for (let r = slot.row; r < slot.row + slot.h; r++) {
    for (let c = slot.col; c < slot.col + slot.w; c++) {
      if (unusable.has(cellIndex(dims, c, r))) return false;
    }
  }
  return true;
}

/**
 * The usable slot nearest to `slot`: the same footprint if any position of
 * it is fully usable, else the footprint shrinks one cell at a time (larger
 * dimension first) until a position exists. Nearness is squared center
 * distance in cell units; ties break toward the smaller row, then column
 * (deterministic). Returns null only when the grid has no usable cell at
 * all — a degenerate spanning setup.
 */
export function nearestUsableSlot(
  dims: GridDims,
  unusable: ReadonlySet<number>,
  slot: Slot,
): Slot | null {
  const cx = slot.col + slot.w / 2;
  const cy = slot.row + slot.h / 2;
  let w = clamp(Math.round(slot.w), 1, dims.cols);
  let h = clamp(Math.round(slot.h), 1, dims.rows);
  for (;;) {
    let best: Slot | null = null;
    let bestD = Infinity;
    for (let row = 0; row + h <= dims.rows; row++) {
      for (let col = 0; col + w <= dims.cols; col++) {
        const cand: Slot = { col, row, w, h };
        if (!slotUsable(dims, unusable, cand)) continue;
        const dx = col + w / 2 - cx;
        const dy = row + h / 2 - cy;
        const d = dx * dx + dy * dy;
        if (d < bestD - 1e-9) {
          bestD = d;
          best = cand;
        }
      }
    }
    if (best) return best;
    if (w === 1 && h === 1) return null;
    if (w >= h && w > 1) w--;
    else h--;
  }
}
