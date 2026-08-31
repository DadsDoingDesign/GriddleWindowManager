// Spec 2026-08-31 (drag fill placement) — the open-space finder. Pure cell
// math, no brain imports: the brain hands it the blocked mask (in-flow tile
// cells plus spanning dead space), the cursor's cell and the window's
// minimum footprint, and gets back the rectangle a new tile should fill.
//
// Selection rule (the spec's "snap to open space unless I hover over new
// open space"): among the free rectangles large enough for the minimum, a
// rectangle containing the cursor's (free) cell beats every other; then the
// largest area wins; ties go to the rectangle whose center is nearest the
// cursor, then topmost, then leftmost. The minimum filter runs first, so
// hovering a region too small for the window still yields the best fitting
// region elsewhere instead of a refusal.

import type { Slot } from './types';

export interface OpenSpaceQuery {
  cols: number;
  rows: number;
  /** Flat row*cols+col indexes of cells a new tile cannot cover. */
  blocked: ReadonlySet<number>;
  /** Cell under the cursor, or null when the cursor picks nothing. */
  cursor: { col: number; row: number } | null;
  /** Minimum cells the window's OS minimum size needs (>= 1x1). */
  min: { w: number; h: number };
}

/**
 * The rectangle of free cells a new tile should fill, or null when no free
 * rectangle satisfies the minimum. O(cols * rows^2): for every free top-left
 * a downward walk under a running-min of free-run widths enumerates every
 * maximal-width rectangle per height, which includes every maximal rectangle.
 */
export function bestOpenSlot(q: OpenSpaceQuery): Slot | null {
  const { cols, rows, blocked, cursor, min } = q;
  if (cols < 1 || rows < 1) return null;

  // freeRight[r][c] = consecutive free cells rightward from (c, r), 0 when
  // (c, r) itself is blocked.
  const freeRight: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array<number>(cols).fill(0);
    for (let c = cols - 1; c >= 0; c--) {
      if (!blocked.has(r * cols + c)) {
        row[c] = (c + 1 < cols ? row[c + 1]! : 0) + 1;
      }
    }
    freeRight.push(row);
  }

  const cursorFree =
    cursor !== null &&
    cursor.col >= 0 &&
    cursor.col < cols &&
    cursor.row >= 0 &&
    cursor.row < rows &&
    !blocked.has(cursor.row * cols + cursor.col);

  let best: Slot | null = null;
  let bestContains = false;
  let bestArea = 0;
  let bestDist = Infinity;

  const consider = (slot: Slot) => {
    const contains =
      cursorFree &&
      cursor!.col >= slot.col &&
      cursor!.col < slot.col + slot.w &&
      cursor!.row >= slot.row &&
      cursor!.row < slot.row + slot.h;
    const area = slot.w * slot.h;
    const dist =
      cursor === null
        ? 0
        : (slot.col + slot.w / 2 - cursor.col - 0.5) ** 2 +
          (slot.row + slot.h / 2 - cursor.row - 0.5) ** 2;
    if (best !== null) {
      if (bestContains !== contains) {
        if (bestContains) return;
      } else if (area !== bestArea) {
        if (area < bestArea) return;
      } else if (dist !== bestDist) {
        if (dist > bestDist) return;
      } else if (
        slot.row > best.row ||
        (slot.row === best.row && slot.col >= best.col)
      ) {
        return;
      }
    }
    best = slot;
    bestContains = contains;
    bestArea = area;
    bestDist = dist;
  };

  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      if (freeRight[r0]![c0]! === 0) continue;
      let w = Infinity;
      for (let r = r0; r < rows; r++) {
        w = Math.min(w, freeRight[r]![c0]!);
        if (w === 0) break;
        const h = r - r0 + 1;
        if (w >= min.w && h >= min.h) {
          consider({ col: c0, row: r0, w, h });
        }
      }
    }
  }
  return best;
}
