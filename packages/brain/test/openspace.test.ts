// Spec 2026-08-31 (drag fill placement) — the pure open-space finder: given
// the grid's blocked-cell mask, the cursor's cell and the window's minimum
// footprint, pick the rectangle of free cells a new tile should fill.

import { describe, expect, it } from 'vitest';
import { bestOpenSlot } from '../src/openspace';

/** Flat row*cols+col indexes for every cell of the given slots. */
function blockCells(
  cols: number,
  slots: { col: number; row: number; w: number; h: number }[],
): Set<number> {
  const out = new Set<number>();
  for (const s of slots) {
    for (let r = s.row; r < s.row + s.h; r++) {
      for (let c = s.col; c < s.col + s.w; c++) out.add(r * cols + c);
    }
  }
  return out;
}

const NO_MIN = { w: 1, h: 1 };

describe('bestOpenSlot', () => {
  it('an empty grid fills whole', () => {
    const slot = bestOpenSlot({
      cols: 4,
      rows: 3,
      blocked: new Set(),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 0, row: 0, w: 4, h: 3 });
  });

  it('fills the largest free rectangle beside a tile', () => {
    // Col 0 fully occupied on a 4x4: the open space is the right 3x4.
    const slot = bestOpenSlot({
      cols: 4,
      rows: 4,
      blocked: blockCells(4, [{ col: 0, row: 0, w: 1, h: 4 }]),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 1, row: 0, w: 3, h: 4 });
  });

  it('a fully blocked grid yields null', () => {
    const slot = bestOpenSlot({
      cols: 2,
      rows: 2,
      blocked: blockCells(2, [{ col: 0, row: 0, w: 2, h: 2 }]),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toBeNull();
  });

  it('the cursor hovering a free region targets that region', () => {
    // Middle column blocked on 5x2: two 2x2 regions left and right.
    const blocked = blockCells(5, [{ col: 2, row: 0, w: 1, h: 2 }]);
    const right = bestOpenSlot({
      cols: 5,
      rows: 2,
      blocked,
      cursor: { col: 3, row: 1 },
      min: NO_MIN,
    });
    expect(right).toEqual({ col: 3, row: 0, w: 2, h: 2 });
    const left = bestOpenSlot({
      cols: 5,
      rows: 2,
      blocked,
      cursor: { col: 0, row: 0 },
      min: NO_MIN,
    });
    expect(left).toEqual({ col: 0, row: 0, w: 2, h: 2 });
  });

  it('the cursor over an occupied cell falls back to the largest region', () => {
    // Blocked col 1 on 4x2: 1x2 region left, 2x2 region right. Cursor on the
    // blocked column must not pin the choice — biggest wins.
    const slot = bestOpenSlot({
      cols: 4,
      rows: 2,
      blocked: blockCells(4, [{ col: 1, row: 0, w: 1, h: 2 }]),
      cursor: { col: 1, row: 0 },
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 2, row: 0, w: 2, h: 2 });
  });

  it('candidates below the minimum footprint are rejected', () => {
    // Every free region is 1 cell wide, but the window needs 2.
    const slot = bestOpenSlot({
      cols: 3,
      rows: 2,
      blocked: blockCells(3, [{ col: 1, row: 0, w: 1, h: 2 }]),
      cursor: null,
      min: { w: 2, h: 1 },
    });
    expect(slot).toBeNull();
  });

  it('a hovered region too small for the minimum yields the fitting one', () => {
    // Left region 1 wide, right region 2 wide; min width 2. Hovering the left
    // region must not refuse while a fitting region exists.
    const slot = bestOpenSlot({
      cols: 4,
      rows: 2,
      blocked: blockCells(4, [{ col: 1, row: 0, w: 1, h: 2 }]),
      cursor: { col: 0, row: 0 },
      min: { w: 2, h: 1 },
    });
    expect(slot).toEqual({ col: 2, row: 0, w: 2, h: 2 });
  });

  it('an L-shaped free region fills its largest inner rectangle', () => {
    // 3x3 with cells (col 1, row 0), (col 2, row 0), (col 2, row 1) blocked:
    // the free cells form an L whose largest rectangle is the 2x2 at
    // (col 0, row 1) — bigger than either full arm (1x3 column, 3x1 row).
    const slot = bestOpenSlot({
      cols: 3,
      rows: 3,
      blocked: new Set([1, 2, 5]),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 0, row: 1, w: 2, h: 2 });
  });

  it('equal areas break the tie by cursor distance', () => {
    // Two 2x2 regions; the cursor sits on the blocked band between them,
    // one column nearer the right region.
    const slot = bestOpenSlot({
      cols: 6,
      rows: 2,
      blocked: blockCells(6, [{ col: 2, row: 0, w: 2, h: 2 }]),
      cursor: { col: 3, row: 0 },
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 4, row: 0, w: 2, h: 2 });
  });

  it('with no cursor at all the topmost-leftmost of equal areas wins', () => {
    const slot = bestOpenSlot({
      cols: 5,
      rows: 2,
      blocked: blockCells(5, [{ col: 2, row: 0, w: 1, h: 2 }]),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 0, row: 0, w: 2, h: 2 });
  });

  it('spanning dead-space cells block like tiles', () => {
    // Bottom-right cell dead on a 2x2: best is the top row.
    const slot = bestOpenSlot({
      cols: 2,
      rows: 2,
      blocked: new Set([3]),
      cursor: null,
      min: NO_MIN,
    });
    expect(slot).toEqual({ col: 0, row: 0, w: 2, h: 1 });
  });
});
