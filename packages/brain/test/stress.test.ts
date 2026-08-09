// Stress + resilience gate (plan Task 20, spec §8):
//   1. 60 simulated windows tile across two gridded monitors,
//   2. rapid create/destroy/minimize/restore churn (deterministic script),
//   3. monitor topology flaps (unplug/replug + work-area geometry changes),
//   4. spanning-grid topology flaps (member monitor vanishes mid-flight),
//   5. drag-event flood at 120 Hz through a 20-tile collision grid,
//   6. apply latency < 50 ms for a 20-window repack,
//   7. brain-webview death → respawn from persisted config rehydrates the
//      exact same layout with no window jumping (spec §6 self-healing; the
//      automatable core of the "kill brain window" scenario).
// After every phase the suite asserts the same invariants as the fuzz gate:
// emitted rects in bounds, no in-flow overlap in collision grids, no hwnd
// tiled twice, floating ∩ tiled = ∅.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { parseConfig, serializeConfig } from '../src/persist';
import { rectCoveredByWorkAreas, spanGridId } from '../src/spanning';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  Move,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

// packages/brain compiles with "types": [] to enforce its zero-DOM/zero-Node
// constraint on src/. Tests DO run under Node (vitest), so declare the host
// global this file needs instead of pulling in @types/node.
declare const performance: { now(): number };

const MON1: MonitorInfo = {
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
};
const MON2: MonitorInfo = {
  id: '\\\\.\\DISPLAY2@1920,0',
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  workX: 1920,
  workY: 0,
  workWidth: 2560,
  workHeight: 1400,
  dpi: 144,
  primary: false,
};
/** MON2 with a shifted work area (taskbar moved) — same id, new geometry. */
const MON2_SHIFTED: MonitorInfo = {
  ...MON2,
  workY: 40,
  workHeight: 1360,
};
const GRID1 = `grid:${MON1.id}`;
const GRID2 = `grid:${MON2.id}`;

/** Deterministic 32-bit PRNG (mulberry32), same as the fuzz gate. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  brain: WindowManagerBrain;
  applies: ApplyLayout[];
  previews: PreviewState[];
  snapshots: StateSnapshot[];
  /** Last emitted rect per hwnd (what the real windows would sit at). */
  applied: Map<string, Move>;
}

function makeHarness(cfg?: AppConfig): Harness {
  const applies: ApplyLayout[] = [];
  const previews: PreviewState[] = [];
  const snapshots: StateSnapshot[] = [];
  const applied = new Map<string, Move>();
  const brain = new WindowManagerBrain(
    {
      onApply(l) {
        applies.push(l);
        for (const m of l.moves) applied.set(m.hwnd, m);
      },
      onPreview(p) {
        previews.push(p);
      },
      onSnapshot(s) {
        snapshots.push(s);
      },
    },
    cfg,
  );
  return { brain, applies, previews, snapshots, applied };
}

function gridSettings(
  id: string,
  monitorIds: string[],
  cols: number,
  rows: number,
  mode: 'collision' | 'overlay' = 'collision',
): GridSettings {
  return { id, monitorIds, cols, rows, mode, enabled: true, activeTemplateId: null };
}

let hwndCounter = 0;
function makeWindow(
  mon: MonitorInfo,
  width: number,
  height: number,
  opts?: { resizable?: boolean },
): WindowInfo {
  hwndCounter += 1;
  return {
    hwnd: String(hwndCounter),
    title: `Stress ${hwndCounter}`,
    exe: 'stress.exe',
    x: mon.workX + 10,
    y: mon.workY + 10,
    width,
    height,
    monitorId: mon.id,
    minimized: false,
    resizable: opts?.resizable ?? true,
  };
}

/** Every move since `from` lies inside some allowed work area, non-empty. */
function assertMovesInBounds(
  applies: ApplyLayout[],
  from: number,
  allowed: MonitorInfo[],
): void {
  for (let i = from; i < applies.length; i++) {
    for (const m of applies[i]!.moves) {
      expect(m.width, `move ${JSON.stringify(m)} has empty width`).toBeGreaterThan(0);
      expect(m.height, `move ${JSON.stringify(m)} has empty height`).toBeGreaterThan(0);
      const inSome = allowed.some(
        (mon) =>
          m.x >= mon.workX &&
          m.y >= mon.workY &&
          m.x + m.width <= mon.workX + mon.workWidth &&
          m.y + m.height <= mon.workY + mon.workHeight,
      );
      expect(inSome, `rect out of every work area: ${JSON.stringify(m)}`).toBe(true);
    }
  }
}

interface LayoutTileRaw {
  id: string;
  col: number;
  row: number;
  w: number;
  h: number;
  position?: string;
  pinned?: { x: number; y: number };
}

function slotOfRaw(t: LayoutTileRaw): { col: number; row: number; w: number; h: number } {
  if (t.position === 'absolute' && t.pinned) {
    return { col: t.pinned.x, row: t.pinned.y, w: t.w, h: t.h };
  }
  return { col: t.col, row: t.row, w: t.w, h: t.h };
}

/**
 * Structural invariants over the brain's own layouts (same walk as the fuzz
 * gate): tiles in bounds, no hwnd tiled twice, no in-flow overlap in
 * collision grids, floating ∩ tiled = ∅.
 */
function assertGridConsistency(brain: WindowManagerBrain, lastSnapshot?: StateSnapshot): void {
  const cfg = brain.exportConfig();
  const tiledIds = new Set<string>();
  for (const g of cfg.grids) {
    if (!g.enabled) continue;
    const snap = cfg.layouts[g.id] as { tiles?: LayoutTileRaw[] } | undefined;
    if (!snap || !Array.isArray(snap.tiles)) continue; // grid inert (monitor absent)
    const inFlow: Array<{ id: string; col: number; row: number; w: number; h: number }> = [];
    for (const t of snap.tiles) {
      const s = slotOfRaw(t);
      expect(
        s.col >= 0 && s.row >= 0 && s.col + s.w <= g.cols && s.row + s.h <= g.rows,
        `tile ${t.id} out of ${g.cols}x${g.rows} bounds in ${g.id}: ${JSON.stringify(s)}`,
      ).toBe(true);
      expect(tiledIds.has(t.id), `hwnd ${t.id} tiled in two grids`).toBe(false);
      tiledIds.add(t.id);
      if (t.position === undefined || t.position === 'static') {
        inFlow.push({ id: t.id, ...s });
      }
    }
    if (g.mode === 'collision') {
      for (let i = 0; i < inFlow.length; i++) {
        for (let j = i + 1; j < inFlow.length; j++) {
          const a = inFlow[i]!;
          const b = inFlow[j]!;
          const overlap =
            a.col < b.col + b.w &&
            b.col < a.col + a.w &&
            a.row < b.row + b.h &&
            b.row < a.row + a.h;
          expect(
            overlap,
            `overlapping in-flow tiles in ${g.id}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
          ).toBe(false);
        }
      }
    }
  }
  if (lastSnapshot) {
    for (const f of lastSnapshot.floating) {
      expect(tiledIds.has(f.hwnd), `hwnd ${f.hwnd} both floating and tiled`).toBe(false);
    }
  }
}

function lastSnap(h: Harness): StateSnapshot {
  const s = h.snapshots[h.snapshots.length - 1];
  expect(s, 'expected at least one snapshot').toBeDefined();
  return s!;
}

/** Sizes that snap to a 1×1 footprint on both monitors' 12×6 / 8×4 grids. */
function smallSize(rnd: () => number): { width: number; height: number } {
  return {
    width: 160 + Math.floor(rnd() * 70), // 160..229 px
    height: 150 + Math.floor(rnd() * 100), // 150..249 px
  };
}

describe('stress: 60-window load', () => {
  it('tiles 60 windows across two grids with all invariants intact', () => {
    const h = makeHarness();
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);
    h.brain.enableGrid(gridSettings(GRID2, [MON2.id], 8, 4, 'overlay'), []);

    const rnd = mulberry32(0x5eed);
    const on1: string[] = [];
    const on2: string[] = [];
    for (let i = 0; i < 60; i++) {
      const mon = i < 40 ? MON1 : MON2;
      const { width, height } = smallSize(rnd);
      const w = makeWindow(mon, width, height, { resizable: rnd() > 0.05 });
      (mon === MON1 ? on1 : on2).push(w.hwnd);
      h.brain.windowAppeared(w);
    }

    const snap = lastSnap(h);
    // 40 one-cell tiles fit a 12×6 collision grid outright; overlay never
    // rejects. Nothing floats, nothing is lost.
    expect(snap.tiles[GRID1]!.length).toBe(40);
    expect(snap.tiles[GRID2]!.length).toBe(20);
    expect(snap.floating.length).toBe(0);
    const tiledHwnds = new Set(
      [...snap.tiles[GRID1]!, ...snap.tiles[GRID2]!].map((t) => t.hwnd),
    );
    for (const hw of [...on1, ...on2]) expect(tiledHwnds.has(hw)).toBe(true);

    assertMovesInBounds(h.applies, 0, [MON1, MON2]);
    assertGridConsistency(h.brain, snap);
  });
});

describe('stress: create/destroy/minimize churn', () => {
  it('600 scripted churn ops over ~60 windows leave a coherent state', () => {
    const h = makeHarness();
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);
    h.brain.enableGrid(gridSettings(GRID2, [MON2.id], 8, 4, 'overlay'), []);

    const rnd = mulberry32(0xc4c41a);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const model = new Map<string, { info: WindowInfo; minimized: boolean }>();

    const appear = () => {
      const mon = rnd() < 0.6 ? MON1 : MON2;
      const { width, height } = smallSize(rnd);
      const w = makeWindow(mon, width, height, { resizable: rnd() > 0.1 });
      model.set(w.hwnd, { info: w, minimized: false });
      h.brain.windowAppeared(w);
    };
    for (let i = 0; i < 60; i++) appear();

    for (let op = 0; op < 600; op++) {
      const r = rnd();
      const before = h.applies.length;
      if (r < 0.3) {
        appear();
      } else if (r < 0.55) {
        const alive = [...model.keys()];
        if (alive.length > 0) {
          const hw = pick(alive);
          model.delete(hw);
          h.brain.windowDestroyed(hw);
        }
      } else if (r < 0.8) {
        const vis = [...model.entries()].filter(([, m]) => !m.minimized).map(([k]) => k);
        if (vis.length > 0) {
          const hw = pick(vis);
          model.get(hw)!.minimized = true;
          h.brain.windowMinimized(hw);
        }
      } else {
        const min = [...model.entries()].filter(([, m]) => m.minimized).map(([k]) => k);
        if (min.length > 0) {
          const hw = pick(min);
          const m = model.get(hw)!;
          m.minimized = false;
          h.brain.windowRestored({ ...m.info, minimized: false });
        }
      }
      assertMovesInBounds(h.applies, before, [MON1, MON2]);
      if (op % 25 === 0) assertGridConsistency(h.brain, lastSnap(h));
    }
    assertGridConsistency(h.brain, lastSnap(h));

    // Coherence: every visible modeled window is tiled or floating; nothing
    // dead or minimized lingers in the snapshot.
    const snap = lastSnap(h);
    const tiled = new Set(
      Object.values(snap.tiles).flatMap((ts) => ts.map((t) => t.hwnd)),
    );
    const floating = new Set(snap.floating.map((f) => f.hwnd));
    const visible = [...model.entries()].filter(([, m]) => !m.minimized).map(([k]) => k);
    expect(visible.length).toBeGreaterThan(20); // the run kept real load
    for (const hw of visible) {
      expect(
        tiled.has(hw) || floating.has(hw),
        `visible window ${hw} is neither tiled nor floating`,
      ).toBe(true);
    }
    for (const hw of tiled) {
      const m = model.get(hw);
      expect(m !== undefined && !m.minimized, `tile for dead/minimized hwnd ${hw}`).toBe(
        true,
      );
    }
  });
});

describe('stress: monitor topology flaps', () => {
  it('40 unplug/replug + geometry flaps never violate invariants', () => {
    const h = makeHarness();
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);
    h.brain.enableGrid(gridSettings(GRID2, [MON2.id], 8, 4), []);

    const rnd = mulberry32(0xf1a9);
    const on1: string[] = [];
    for (let i = 0; i < 30; i++) {
      const mon = i < 20 ? MON1 : MON2;
      const { width, height } = smallSize(rnd);
      const w = makeWindow(mon, width, height);
      if (mon === MON1) on1.push(w.hwnd);
      h.brain.windowAppeared(w);
    }

    const allowed = [MON1, MON2, MON2_SHIFTED];
    for (let flap = 0; flap < 40; flap++) {
      const before = h.applies.length;
      if (flap % 2 === 0) {
        // Unplug MON2.
        h.brain.setMonitors([MON1]);
        // Windows keep appearing while the monitor is gone — on the missing
        // monitor they are simply not placeable (no throw, no bad rect).
        const { width, height } = smallSize(rnd);
        h.brain.windowAppeared(makeWindow(MON2, width, height));
        const w1 = makeWindow(MON1, width, height);
        on1.push(w1.hwnd);
        h.brain.windowAppeared(w1);
      } else {
        // Replug, alternating work-area geometry (taskbar flipped).
        h.brain.setMonitors([MON1, flap % 4 === 1 ? MON2_SHIFTED : MON2]);
        // A drag on MON1 forces a flush while MON2's geometry just changed.
        const hw = on1[Math.floor(rnd() * on1.length)]!;
        h.brain.moveSizeStart(hw);
        h.brain.moveSizeEnd(hw, {
          x: MON1.workX + Math.floor(rnd() * 1200),
          y: MON1.workY + Math.floor(rnd() * 700),
          width: 200,
          height: 200,
        });
      }
      assertMovesInBounds(h.applies, before, allowed);
      assertGridConsistency(h.brain, lastSnap(h));
    }

    // Final replug: MON2's grid adopts a fresh window again.
    h.brain.setMonitors([MON1, MON2]);
    const w = makeWindow(MON2, 300, 220);
    h.brain.windowAppeared(w);
    const snap = lastSnap(h);
    expect(snap.tiles[GRID2]!.some((t) => t.hwnd === w.hwnd)).toBe(true);
    assertGridConsistency(h.brain, snap);
  });

  it('spanning grid survives a member monitor flapping away and back', () => {
    const h = makeHarness();
    const spanId = spanGridId([MON1.id, MON2.id]);
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(spanId, [MON1.id, MON2.id], 10, 4), []);

    const rnd = mulberry32(0x59a2);
    const placedDuringPresence: string[] = [];
    for (let i = 0; i < 10; i++) {
      const mon = i % 2 === 0 ? MON1 : MON2;
      const w = makeWindow(mon, 350, 300);
      placedDuringPresence.push(w.hwnd);
      h.brain.windowAppeared(w);
    }

    for (let flap = 0; flap < 10; flap++) {
      const before = h.applies.length;
      // Member vanishes: the spanning grid goes inert (spec §5.7) — feeding
      // it more windows must neither throw nor emit rects.
      h.brain.setMonitors([MON1]);
      h.brain.windowAppeared(makeWindow(MON1, 350, 300));
      expect(h.applies.length, 'inert spanning grid emitted moves').toBe(before);

      // Member returns: placement works again and every emitted rect lies
      // fully inside the union of the members' work areas (dead space
      // excluded — L-shaped union here since workY 48 vs 0).
      h.brain.setMonitors([MON1, MON2]);
      const w = makeWindow(rnd() < 0.5 ? MON1 : MON2, 350, 300);
      h.brain.windowAppeared(w);
      for (let i = before; i < h.applies.length; i++) {
        for (const m of h.applies[i]!.moves) {
          expect(
            rectCoveredByWorkAreas(
              { x: m.x, y: m.y, width: m.width, height: m.height },
              [MON1, MON2],
            ),
            `spanning rect leaked into dead space: ${JSON.stringify(m)}`,
          ).toBe(true);
        }
      }
      assertGridConsistency(h.brain, lastSnap(h));
    }
  });
});

describe('stress: drag flood at 120 Hz', () => {
  it('1200 drag-pos events through a 20-tile grid stay cheap and deduped', () => {
    const h = makeHarness();
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);
    h.brain.enableGrid(gridSettings(GRID2, [MON2.id], 8, 4), []);

    const rnd = mulberry32(0xd7a9);
    let dragged = '';
    for (let i = 0; i < 20; i++) {
      const { width, height } = smallSize(rnd);
      const w = makeWindow(MON1, width, height);
      dragged = w.hwnd; // last one — it sits in a tile like the rest
      h.brain.windowAppeared(w);
    }

    const before = h.applies.length;
    const previewsBefore = h.previews.length;
    h.brain.moveSizeStart(dragged);

    // 1200 events = 10 s of a 120 Hz pump, sweeping the cursor across both
    // monitors (including the seam and off-desktop excursions).
    const EVENTS = 1200;
    const t0 = performance.now();
    for (let i = 0; i < EVENTS; i++) {
      const cursorX = -200 + Math.floor((i / EVENTS) * 4800);
      const cursorY = 100 + Math.floor(600 * Math.abs(Math.sin(i / 40)));
      h.brain.dragMoved({
        hwnd: dragged,
        cursorX,
        cursorY,
        x: cursorX - 100,
        y: cursorY - 20,
        width: 200,
        height: 200,
      });
    }
    const elapsed = performance.now() - t0;
    h.brain.moveSizeEnd(dragged, {
      x: MON2.workX + 600,
      y: MON2.workY + 300,
      width: 200,
      height: 200,
    });

    // Keeping up with 120 Hz means processing 10 s of events in far less
    // than 10 s; give slow CI lots of slack while still catching an O(n²)
    // regression or a livelock.
    expect(elapsed, `1200 dragMoved took ${elapsed.toFixed(1)} ms`).toBeLessThan(5000);

    // Preview de-dup: 1200 events over ~30 distinct cells must not emit
    // 1200 previews.
    const emitted = h.previews.length - previewsBefore;
    expect(emitted, 'preview flood not deduped').toBeLessThan(400);
    for (const p of h.previews.slice(previewsBefore)) {
      if (!p.visible || p.footprint === null) continue;
      const g = p.gridId === GRID1 ? { cols: 12, rows: 6 } : { cols: 8, rows: 4 };
      expect(p.footprint.col).toBeGreaterThanOrEqual(0);
      expect(p.footprint.row).toBeGreaterThanOrEqual(0);
      expect(p.footprint.col + p.footprint.w).toBeLessThanOrEqual(g.cols);
      expect(p.footprint.row + p.footprint.h).toBeLessThanOrEqual(g.rows);
    }

    // The drop committed: the dragged window transferred to MON2's grid.
    const snap = lastSnap(h);
    expect(snap.tiles[GRID2]!.some((t) => t.hwnd === dragged)).toBe(true);
    assertMovesInBounds(h.applies, before, [MON1, MON2]);
    assertGridConsistency(h.brain, snap);

    // And the brain still takes new work afterwards (no wedged drag state).
    const w = makeWindow(MON1, 300, 220);
    h.brain.windowAppeared(w);
    expect(lastSnap(h).tiles[GRID1]!.some((t) => t.hwnd === w.hwnd)).toBe(true);
  });
});

describe('stress: apply latency', () => {
  it('a 20-window repack (reflow 12x6 -> 10x4) lands in < 50 ms', () => {
    const h = makeHarness();
    h.brain.setMonitors([MON1, MON2]);
    h.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);

    const rnd = mulberry32(0x1a7e);
    for (let i = 0; i < 20; i++) {
      const { width, height } = smallSize(rnd);
      h.brain.windowAppeared(makeWindow(MON1, width, height));
    }
    expect(lastSnap(h).tiles[GRID1]!.length).toBe(20);

    // Warm-up pass (JIT), then measure three full repacks and take the best —
    // the budget bounds the work, not scheduler noise on a loaded CI box.
    h.brain.reflowGrid(GRID1, 11, 5);
    const dims: Array<[number, number]> = [
      [10, 4],
      [12, 6],
      [10, 4],
    ];
    let best = Infinity;
    let lastApply: ApplyLayout | undefined;
    for (const [cols, rows] of dims) {
      const before = h.applies.length;
      const t0 = performance.now();
      h.brain.reflowGrid(GRID1, cols, rows);
      const dt = performance.now() - t0;
      best = Math.min(best, dt);
      lastApply = h.applies[h.applies.length - 1];
      expect(h.applies.length, 'repack emitted no apply').toBeGreaterThan(before);
    }
    // Every one of the 20 windows moved in a single batched apply.
    expect(lastApply!.moves.length).toBe(20);
    expect(best, `20-window repack took ${best.toFixed(2)} ms`).toBeLessThan(50);
    assertGridConsistency(h.brain, lastSnap(h));
  });
});

describe('resilience: brain death -> respawn rehydration', () => {
  it('a respawned brain restores identical slots and rects from the persisted config', () => {
    // ---- Session A: live brain with a scrambled two-grid layout. ----------
    const a = makeHarness();
    a.brain.setMonitors([MON1, MON2]);
    a.brain.enableGrid(gridSettings(GRID1, [MON1.id], 12, 6), []);
    a.brain.enableGrid(gridSettings(GRID2, [MON2.id], 8, 4, 'overlay'), []);

    const rnd = mulberry32(0xdead);
    const windows: WindowInfo[] = [];
    for (let i = 0; i < 12; i++) {
      const mon = i < 8 ? MON1 : MON2;
      const { width, height } = smallSize(rnd);
      const w = makeWindow(mon, width, height, { resizable: i !== 3 });
      windows.push(w);
      a.brain.windowAppeared(w);
    }
    // Scramble via the editor path so slots are not just first-fit order.
    a.brain.moveTileFromEditor(GRID1, windows[0]!.hwnd, { col: 8, row: 4, w: 3, h: 2 });
    a.brain.moveTileFromEditor(GRID1, windows[5]!.hwnd, { col: 0, row: 3, w: 2, h: 2 });
    a.brain.moveTileFromEditor(GRID2, windows[10]!.hwnd, { col: 5, row: 1, w: 2, h: 2 });

    const snapA = lastSnap(a);
    const slotsA = new Map<string, string>();
    for (const [gid, tiles] of Object.entries(snapA.tiles)) {
      for (const t of tiles) slotsA.set(t.hwnd, `${gid}:${JSON.stringify(t.slot)}`);
    }
    expect(slotsA.size).toBe(12);

    // ---- The webview dies. What survives is exactly the persisted config
    // (serialize -> disk -> parse round-trip) and the real windows sitting at
    // their last applied rects (the tracker re-reports them on respawn). ----
    const persisted = parseConfig(serializeConfig(a.brain.exportConfig()));
    expect(persisted).not.toBeNull();
    const swept: WindowInfo[] = windows.map((w) => {
      const r = a.applied.get(w.hwnd);
      return r ? { ...w, x: r.x, y: r.y, width: r.width, height: r.height } : { ...w };
    });

    // ---- Session B: respawn — same boot sequence as the brain host
    // (config -> monitors -> enableGrid per enabled grid with a sweep). -----
    const b = makeHarness(persisted!);
    b.brain.setMonitors([MON1, MON2]);
    for (const g of persisted!.grids) {
      if (g.enabled) b.brain.enableGrid(g, swept);
    }

    const snapB = lastSnap(b);
    const slotsB = new Map<string, string>();
    for (const [gid, tiles] of Object.entries(snapB.tiles)) {
      for (const t of tiles) slotsB.set(t.hwnd, `${gid}:${JSON.stringify(t.slot)}`);
    }
    // Every window is managed again, in the same grid, at the same slot.
    expect(slotsB).toEqual(slotsA);
    expect(snapB.floating.length).toBe(0);

    // No window jumps: everything the respawned brain emits equals the rect
    // the window is already sitting at.
    for (const l of b.applies) {
      for (const m of l.moves) {
        const prev = a.applied.get(m.hwnd);
        expect(prev, `respawn emitted a move for unknown hwnd ${m.hwnd}`).toBeDefined();
        expect(
          { x: m.x, y: m.y, width: m.width, height: m.height },
          `respawn moved window ${m.hwnd}`,
        ).toEqual({ x: prev!.x, y: prev!.y, width: prev!.width, height: prev!.height });
      }
    }
    assertGridConsistency(b.brain, snapB);

    // The respawned brain persists the same state it loaded (grids,
    // templates, exclusions round-trip losslessly through death).
    const again = b.brain.exportConfig();
    expect(again.grids).toEqual(persisted!.grids);
    expect(again.exclusions).toEqual(persisted!.exclusions);
    expect(again.hotkey).toEqual(persisted!.hotkey);
  });
});
