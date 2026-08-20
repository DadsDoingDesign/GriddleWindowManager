// Templates (spec §5.5) — named layouts with no app bindings: just grid dims
// plus slot footprints in reading order. Capture/apply live on the brain
// (they need grid + recency state); this module owns the pure parts: the
// builtin catalog, slot ordering, and template construction.

import type { Slot, Template } from './types';

/** Reading order: top-to-bottom, then left-to-right (row, then col). */
export function sortSlotsReadingOrder(slots: readonly Slot[]): Slot[] {
  return [...slots]
    .map((s) => ({ ...s }))
    .sort((a, b) => a.row - b.row || a.col - b.col || a.h - b.h || a.w - b.w);
}

interface BuiltinSpec {
  id: string;
  name: string;
  cols: number;
  rows: number;
  slots: Slot[];
}

// Contract (plan Task 6 ids, geometry superseded in critique round 3): all
// five builtins are authored on the 12×6 default lattice so applying one to
// a fresh install never re-dimensions the grid. The plan originally specced
// degenerate dims (2×1, 3×1, 2×2, 8×6, 1×2); since `applyTemplate` re-dims
// the grid to the template's dims, that silently destroyed the user's grid
// granularity on the first Apply click — see docs/deferred.md, "Critique
// round 3".
const BUILTINS: readonly BuiltinSpec[] = [
  {
    id: 'tpl:2col',
    name: 'Two columns',
    cols: 12,
    rows: 6,
    slots: [
      { col: 0, row: 0, w: 6, h: 6 },
      { col: 6, row: 0, w: 6, h: 6 },
    ],
  },
  {
    id: 'tpl:3col',
    name: 'Three columns',
    cols: 12,
    rows: 6,
    slots: [
      { col: 0, row: 0, w: 4, h: 6 },
      { col: 4, row: 0, w: 4, h: 6 },
      { col: 8, row: 0, w: 4, h: 6 },
    ],
  },
  {
    id: 'tpl:2x2',
    name: 'Quad (2×2)',
    cols: 12,
    rows: 6,
    slots: [
      { col: 0, row: 0, w: 6, h: 3 },
      { col: 6, row: 0, w: 6, h: 3 },
      { col: 0, row: 3, w: 6, h: 3 },
      { col: 6, row: 3, w: 6, h: 3 },
    ],
  },
  {
    id: 'tpl:main-side',
    name: 'Main + side',
    cols: 12,
    rows: 6,
    slots: [
      { col: 0, row: 0, w: 7, h: 6 },
      { col: 7, row: 0, w: 5, h: 6 },
    ],
  },
  {
    id: 'tpl:rows2',
    name: 'Two rows',
    cols: 12,
    rows: 6,
    slots: [
      { col: 0, row: 0, w: 12, h: 3 },
      { col: 0, row: 3, w: 12, h: 3 },
    ],
  },
];

/** Greatest common divisor of two non-negative integers. */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * The template's *shape* — its layout reduced to the smallest lattice that
 * expresses it (spec 2026-08-20). "Two columns", authored on 12×6 so that
 * applying it never re-dimensioned a fresh grid, is a 2×1 layout and the UI
 * should say so.
 *
 * Divides the dims and every slot by the GCD of all of them, separately per
 * axis. A layout nothing divides — "Main + side" (7 + 5 columns), or a
 * capture with an odd offset — comes back unchanged, which is correct: that
 * really is a 12-column shape.
 *
 * Pure and total: the caller may render the result or scale it back up, and
 * `applyTemplate` does exactly that.
 */
export function templateShape(tpl: Template): {
  cols: number;
  rows: number;
  slots: Slot[];
} {
  let gx = tpl.cols;
  let gy = tpl.rows;
  for (const s of tpl.slots) {
    gx = gcd(gx, gcd(s.col, s.w));
    gy = gcd(gy, gcd(s.row, s.h));
  }
  // A zero would come from a degenerate template; never divide by it.
  if (gx < 1) gx = 1;
  if (gy < 1) gy = 1;
  return {
    cols: tpl.cols / gx,
    rows: tpl.rows / gy,
    slots: tpl.slots.map((s) => ({
      col: s.col / gx,
      row: s.row / gy,
      w: s.w / gx,
      h: s.h / gy,
    })),
  };
}

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((b) => b.id));

/** The five shipped layouts (fresh deep copies on every call). */
export function builtinTemplates(): Template[] {
  return BUILTINS.map((b) => ({
    id: b.id,
    name: b.name,
    cols: b.cols,
    rows: b.rows,
    slots: b.slots.map((s) => ({ ...s })),
    builtin: true,
  }));
}

export function isBuiltinTemplateId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/**
 * Builtins (canonical, always present, always first) + the given user
 * templates. Stored copies of builtins are dropped so a config round-trip
 * never duplicates them and can never override the shipped catalog.
 */
export function mergeWithBuiltins(templates: readonly Template[]): Template[] {
  const merged = builtinTemplates();
  const seen = new Set<string>(BUILTIN_IDS);
  for (const t of templates) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push({ ...t, slots: t.slots.map((s) => ({ ...s })), builtin: false });
  }
  return merged;
}

/**
 * Build a user template from a live layout: dims + slots sorted in reading
 * order, no window identities. The id is `tpl:user:<n>` with the smallest n
 * not already taken.
 */
export function makeUserTemplate(
  name: string,
  cols: number,
  rows: number,
  slots: readonly Slot[],
  existing: readonly Template[],
): Template {
  const taken = new Set(existing.map((t) => t.id));
  let n = 1;
  while (taken.has(`tpl:user:${n}`)) n++;
  return {
    id: `tpl:user:${n}`,
    name,
    cols,
    rows,
    slots: sortSlotsReadingOrder(slots),
    builtin: false,
  };
}
