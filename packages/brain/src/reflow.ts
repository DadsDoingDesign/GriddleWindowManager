// Minimal-move reflow solver.
//
// The drop-with-displacement path in the brain hands collisions to
// @griddle/core's `addTileWithDisplacement`, which resolves them with its own
// push ruleset. This module answers a different question: *the dropped tile
// lands exactly where the user aimed — now reorganise the others, moving as
// few of them as possible.*
//
// PURITY IS THE POINT. This file imports nothing but a type. No @griddle/core,
// no Tauri, no DOM, no Node — plain serialisable data in, plain serialisable
// data out. The marketing site bundles this exact file so the animation on the
// landing page and the window manager on the user's desktop run one algorithm,
// not two that drift.
//
// Objective, in order:
//   1. fewest tiles moved,
//   2. then smallest total Manhattan distance moved.
// Determinism is a hard requirement: the same input always yields the same
// output, and the solver is insensitive to the order tiles arrive in (it sorts
// them by id first).
//
// Strategy: iterative deepening on "how many tiles may move". Level k explores
// every arrangement that moves at most k tiles, so the first level that
// succeeds is optimal in count; within a level, branch-and-bound on distance
// picks the cheapest arrangement. Displaced tiles are discovered rather than
// guessed — placing a tile onto cells held by others *lifts* those others into
// the work queue — which keeps the branching factor tied to the real geometry
// instead of to C(n, k) subsets.
//
// The search is bounded by a node cap and never throws: an unsolvable board
// (or one that outruns the cap) comes back as `{ok: false}` so the caller can
// fall back to the existing push behaviour.

import type { Slot } from './types';

/** A tile on the grid: a C1 `Slot` plus the identity the caller tracks it by. */
export type ReflowTile = Slot & { id: string };

/** Grid extent in cells. */
export interface ReflowDims {
  cols: number;
  rows: number;
}

/** Where one displaced tile ends up. Sizes never change, so only the origin moves. */
export interface ReflowMove {
  id: string;
  col: number;
  row: number;
}

export interface ReflowOptions {
  /**
   * Hard ceiling on candidate positions examined across the whole solve.
   * Reaching it ends the search: the best arrangement found so far is
   * returned, or `{ok: false}` if there was none. Defaults to
   * `REFLOW_DEFAULT_MAX_NODES`.
   */
  maxNodes?: number;
  /**
   * Ceiling on how many tiles may move. Defaults to "all of them"; set it to
   * 0 to ask for a strictly non-disruptive drop.
   */
  maxMoves?: number;
}

export interface ReflowResult {
  /** True when `moves` is a complete, valid arrangement. */
  ok: boolean;
  /** Displaced tiles only — never the target — sorted by id. */
  moves: ReflowMove[];
  /** `moves.length`, restated for callers that only need the count. */
  movedCount: number;
  /** Total Manhattan distance the displaced tiles travel. */
  distance: number;
  /** Candidate positions examined. Diagnostic; bounded by `maxNodes`. */
  nodes: number;
}

/**
 * Default ceiling on candidate positions examined. Sized so even a pathological
 * 12x6 board with 20 tiles gives up inside a 16 ms drag frame; every drop that
 * a human would call reasonable resolves in a few hundred nodes.
 */
export const REFLOW_DEFAULT_MAX_NODES = 400_000;

const FREE = -1;
const TARGET = -2;

/** Largest grid the solver will touch (64x64). Beyond this the input is nonsense. */
const MAX_GRID_CELLS = 4096;

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** In-bounds, positive-sized, integer-aligned. */
function fits(t: ReflowTile, cols: number, rows: number): boolean {
  return (
    isNonNegInt(t.col) &&
    isNonNegInt(t.row) &&
    isPosInt(t.w) &&
    isPosInt(t.h) &&
    t.col + t.w <= cols &&
    t.row + t.h <= rows
  );
}

/**
 * Reorganise `tiles` so `target` occupies exactly the cells it asks for, moving
 * as few other tiles as possible.
 *
 * Returns `null` when the *input* is nonsense — non-integer or non-positive
 * dims, a tile or target that does not fit the grid, duplicate ids, an empty
 * id, or tiles that already overlap each other. That is a caller bug and is
 * deliberately distinguished from "I could not find an arrangement", which is
 * `{ok: false, moves: []}`.
 *
 * A `target.id` that matches an existing tile means *that* tile is being
 * dragged: it is lifted, re-placed at the requested slot (with the requested
 * size), and never appears in `moves` — the caller already knows where it put
 * it. `moves` lists only the tiles that had to get out of the way.
 */
export function solveMinimalMoves(
  tiles: readonly ReflowTile[],
  target: ReflowTile,
  dims: ReflowDims,
  opts: ReflowOptions = {},
): ReflowResult | null {
  // ---- validate ----------------------------------------------------------
  if (!dims || !isPosInt(dims.cols) || !isPosInt(dims.rows)) return null;
  const cols = dims.cols;
  const rows = dims.rows;
  if (!tiles || typeof (tiles as { length?: unknown }).length !== 'number') return null;
  if (!target || typeof target.id !== 'string' || target.id === '') return null;
  if (!fits(target, cols, rows)) return null;

  const others: ReflowTile[] = [];
  const ids = new Set<string>();
  for (const raw of tiles) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') return null;
    if (ids.has(raw.id)) return null;
    ids.add(raw.id);
    if (!fits(raw, cols, rows)) return null;
    if (raw.id === target.id) continue; // the dragged tile — re-placed, not displaced
    others.push({ id: raw.id, col: raw.col, row: raw.row, w: raw.w, h: raw.h });
  }
  // Sort by id so the answer depends on the board, not on the caller's array
  // order. Every downstream tie-break keys off this order.
  others.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = others.length;
  const cellCount = cols * rows;
  // The solver allocates per cell, and "never throw" is part of the contract:
  // refuse absurd dims rather than risk a RangeError on allocation. 64x64 is
  // an order of magnitude past any grid a person would tile windows on.
  if (cellCount > MAX_GRID_CELLS) return null;
  const baseOcc = new Int32Array(cellCount).fill(FREE);
  for (let i = 0; i < n; i++) {
    const t = others[i]!;
    for (let r = t.row; r < t.row + t.h; r++) {
      for (let c = t.col; c < t.col + t.w; c++) {
        const k = r * cols + c;
        if (baseOcc[k] !== FREE) return null; // input already overlaps
        baseOcc[k] = i;
      }
    }
  }

  const nothingToDo = (ok: boolean, nodes: number): ReflowResult => ({
    ok,
    moves: [],
    movedCount: 0,
    distance: 0,
    nodes,
  });

  // ---- cheap global feasibility -----------------------------------------
  // Total area is invariant under moves, so this rules out whole boards in O(n).
  let area = target.w * target.h;
  for (let i = 0; i < n; i++) area += others[i]!.w * others[i]!.h;
  if (area > cellCount) return nothingToDo(false, 0);

  // ---- who *must* move ---------------------------------------------------
  const mustMove: number[] = [];
  const isMust = new Uint8Array(n);
  for (let r = target.row; r < target.row + target.h; r++) {
    for (let c = target.col; c < target.col + target.w; c++) {
      const v = baseOcc[r * cols + c]!;
      if (v >= 0 && !isMust[v]) {
        isMust[v] = 1;
        mustMove.push(v);
      }
    }
  }
  // Lift them, then nail the target down for the rest of the solve.
  for (const i of mustMove) {
    const t = others[i]!;
    for (let r = t.row; r < t.row + t.h; r++) {
      for (let c = t.col; c < t.col + t.w; c++) baseOcc[r * cols + c] = FREE;
    }
  }
  for (let r = target.row; r < target.row + target.h; r++) {
    for (let c = target.col; c < target.col + target.w; c++) baseOcc[r * cols + c] = TARGET;
  }

  if (mustMove.length === 0) return nothingToDo(true, 0);

  const maxNodes = isPosInt(opts.maxNodes) ? opts.maxNodes : REFLOW_DEFAULT_MAX_NODES;
  const maxMoves = Math.min(isNonNegInt(opts.maxMoves) ? opts.maxMoves : n, n);
  if (mustMove.length > maxMoves) return nothingToDo(false, 0);

  // ---- search state ------------------------------------------------------
  const origCol = new Int32Array(n);
  const origRow = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    origCol[i] = others[i]!.col;
    origRow[i] = others[i]!.row;
  }
  const posCol = new Int32Array(n);
  const posRow = new Int32Array(n);
  const occ = new Int32Array(cellCount);
  const everLifted = new Uint8Array(n);
  const pending: number[] = [];

  // Every legal home for every tile, precomputed once and ordered cheapest
  // first. The ordering never changes during the search — only which entries
  // are currently usable does — so the hot loop is a scan, with no per-node
  // allocation and no per-node sort.
  const candC: Int32Array[] = [];
  const candR: Int32Array[] = [];
  const candD: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const t = others[i]!;
    const oc = t.col;
    const orow = t.row;
    const slots: number[] = [];
    for (let r = 0; r + t.h <= rows; r++) {
      for (let c = 0; c + t.w <= cols; c++) {
        if (c === oc && r === orow) continue; // a queued tile has to actually move
        slots.push(r * cols + c);
      }
    }
    const dist = (enc: number): number => {
      const c = enc % cols;
      return Math.abs(c - oc) + Math.abs((enc - c) / cols - orow);
    };
    slots.sort((a, b) => dist(a) - dist(b) || (a % cols) - (b % cols) || a - b);
    const cc = new Int32Array(slots.length);
    const rr = new Int32Array(slots.length);
    const dd = new Int32Array(slots.length);
    for (let p = 0; p < slots.length; p++) {
      const enc = slots[p]!;
      const c = enc % cols;
      cc[p] = c;
      rr[p] = (enc - c) / cols;
      dd[p] = dist(enc);
    }
    candC.push(cc);
    candR.push(rr);
    candD.push(dd);
  }

  // Scratch for the blockers of the candidate under consideration, one slice
  // per search depth. A placement can lift at most as many tiles as it has
  // cells, and never more than exist.
  let maxArea = 1;
  for (let i = 0; i < n; i++) {
    const a = others[i]!.w * others[i]!.h;
    if (a > maxArea) maxArea = a;
  }
  const blockStride = Math.min(n, maxArea);
  const blockBuf = new Int32Array(n * blockStride);

  let nodes = 0;
  let capped = false;
  let bestDist = -1;
  let bestMoved: number[] = [];
  let bestCol = new Int32Array(n);
  let bestRow = new Int32Array(n);

  function stamp(i: number, col: number, row: number, value: number): void {
    const t = others[i]!;
    for (let r = row; r < row + t.h; r++) {
      const base = r * cols;
      for (let c = col; c < col + t.w; c++) occ[base + c] = value;
    }
  }

  function dfs(head: number, curDist: number, budget: number): void {
    if (head === pending.length) {
      if (bestDist < 0 || curDist < bestDist) {
        bestDist = curDist;
        bestMoved = pending.slice();
        bestCol = Int32Array.from(posCol);
        bestRow = Int32Array.from(posRow);
      }
      return;
    }
    const i = pending[head]!;
    const t = others[i]!;
    const cc = candC[i]!;
    const rr = candR[i]!;
    const dd = candD[i]!;
    const bOff = head * blockStride;

    for (let p = 0; p < cc.length; p++) {
      const dist = dd[p]!;
      // Candidates are distance-ordered and the tiles still queued can only
      // add distance, so once the bound is hit nothing further in this list
      // can help.
      if (bestDist >= 0 && curDist + dist >= bestDist) break;
      if (nodes >= maxNodes) {
        capped = true;
        return;
      }
      nodes++;

      const col = cc[p]!;
      const row = rr[p]!;
      // Usable? A cell held by the target, or by a tile already lifted and
      // re-placed, disqualifies the position: a second lift would double-count
      // the budget, and any arrangement it could reach is reachable by lifting
      // that tile once, in the other order.
      let usable = true;
      let nb = 0;
      for (let r = row; r < row + t.h && usable; r++) {
        const base = r * cols;
        for (let c = col; c < col + t.w; c++) {
          const v = occ[base + c]!;
          if (v === FREE) continue;
          if (v === TARGET || everLifted[v]) {
            usable = false;
            break;
          }
          let seen = false;
          for (let q = 0; q < nb; q++) {
            if (blockBuf[bOff + q] === v) {
              seen = true;
              break;
            }
          }
          if (seen) continue;
          if (nb >= budget) {
            usable = false;
            break;
          }
          blockBuf[bOff + nb++] = v;
        }
      }
      if (!usable) continue;

      for (let q = 0; q < nb; q++) {
        const b = blockBuf[bOff + q]!;
        stamp(b, posCol[b]!, posRow[b]!, FREE);
        everLifted[b] = 1;
        pending.push(b);
      }
      stamp(i, col, row, i);
      posCol[i] = col;
      posRow[i] = row;

      dfs(head + 1, curDist + dist, budget - nb);

      stamp(i, col, row, FREE);
      for (let q = nb - 1; q >= 0; q--) {
        const b = blockBuf[bOff + q]!;
        pending.pop();
        everLifted[b] = 0;
        // Only never-lifted tiles can block, so a blocker is always back at
        // its original slot.
        posCol[b] = origCol[b]!;
        posRow[b] = origRow[b]!;
        stamp(b, posCol[b]!, posRow[b]!, b);
      }
      if (capped) return;
    }
  }

  // ---- iterative deepening on the move budget ----------------------------
  for (let k = mustMove.length; k <= maxMoves; k++) {
    occ.set(baseOcc);
    posCol.set(origCol);
    posRow.set(origRow);
    everLifted.fill(0);
    pending.length = 0;
    for (const i of mustMove) {
      everLifted[i] = 1;
      pending.push(i);
    }
    bestDist = -1;
    bestMoved = [];

    dfs(0, 0, k - mustMove.length);

    if (bestDist >= 0) break; // first level that succeeds is optimal in count
    if (capped) break;
  }

  if (bestDist < 0) return nothingToDo(false, nodes);

  const moves: ReflowMove[] = [];
  for (const i of bestMoved) {
    moves.push({ id: others[i]!.id, col: bestCol[i]!, row: bestRow[i]! });
  }
  moves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, moves, movedCount: moves.length, distance: bestDist, nodes };
}
