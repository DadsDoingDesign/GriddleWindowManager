// Fuzz gate (plan Task 7, spec §8): a seeded PRNG drives 1,000 random ops
// (appear/destroy/minimize/restore/drag/setMode/reflow/applyTemplate) across
// two gridded monitors. After EVERY op the suite asserts:
//   1. every rect ever emitted lies inside some monitor's work area,
//   2. collision grids have no overlapping in-flow tiles (walking
//      grid.toJSON() via exportConfig), and every tile is in grid bounds,
//   3. no hwnd is tiled twice, and floating ∩ tiled = ∅,
//   4. nothing throws.
// Any failure reports the seed (set FUZZ_SEED=<n> to reproduce a run).

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';

// packages/brain compiles with "types": [] to enforce its zero-DOM/zero-Node
// constraint on src/. Tests DO run under Node (vitest), so declare the two
// host globals this file needs instead of pulling in @types/node.
declare const console: { error(msg: string): void };
declare const process: { env: Record<string, string | undefined> };
import { builtinTemplates } from '../src/templates';
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  Move,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

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
const MONITORS = [MON1, MON2];
const GRID1 = `grid:${MON1.id}`;
const GRID2 = `grid:${MON2.id}`;
const GRID_IDS = [GRID1, GRID2];
const TEMPLATE_IDS = builtinTemplates().map((t) => t.id);

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
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

interface ModelWindow {
  info: WindowInfo;
  minimized: boolean;
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

function moveInSomeWorkArea(m: Move): boolean {
  return MONITORS.some(
    (mon) =>
      m.x >= mon.workX &&
      m.y >= mon.workY &&
      m.x + m.width <= mon.workX + mon.workWidth &&
      m.y + m.height <= mon.workY + mon.workHeight,
  );
}

/** Invariants over everything emitted since `fromApply`, plus current state. */
function checkInvariants(
  brain: WindowManagerBrain,
  applies: ApplyLayout[],
  fromApply: number,
  snapshots: StateSnapshot[],
): void {
  // 1. every emitted rect in bounds of some monitor's work area
  for (let i = fromApply; i < applies.length; i++) {
    for (const m of applies[i]!.moves) {
      if (!(m.width > 0 && m.height > 0)) {
        throw new Error(`empty rect emitted: ${JSON.stringify(m)}`);
      }
      if (!moveInSomeWorkArea(m)) {
        throw new Error(`rect out of every work area: ${JSON.stringify(m)}`);
      }
    }
  }

  // 2+3. walk grid.toJSON() per enabled grid via exportConfig
  const cfg = brain.exportConfig();
  const tiledIds = new Set<string>();
  for (const g of cfg.grids) {
    if (!g.enabled) continue;
    const snap = cfg.layouts[g.id] as
      | { config?: { cols?: number; rows?: number }; tiles?: LayoutTileRaw[] }
      | undefined;
    if (!snap || !Array.isArray(snap.tiles)) {
      throw new Error(`enabled grid ${g.id} has no layout snapshot`);
    }
    const cols = snap.config?.cols ?? g.cols;
    const rows = snap.config?.rows ?? g.rows;
    if (cols !== g.cols || rows !== g.rows) {
      throw new Error(
        `grid ${g.id} dims drifted: settings ${g.cols}x${g.rows} vs grid ${cols}x${rows}`,
      );
    }
    const inFlow: Array<{ id: string; col: number; row: number; w: number; h: number }> = [];
    for (const t of snap.tiles) {
      const s = slotOfRaw(t);
      if (s.col < 0 || s.row < 0 || s.col + s.w > cols || s.row + s.h > rows) {
        throw new Error(
          `tile ${t.id} out of ${cols}x${rows} bounds in ${g.id}: ${JSON.stringify(s)}`,
        );
      }
      if (tiledIds.has(t.id)) {
        throw new Error(`hwnd ${t.id} is tiled in two grids`);
      }
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
          if (overlap) {
            throw new Error(
              `overlapping in-flow tiles in collision grid ${g.id}: ` +
                `${a.id}=${JSON.stringify(a)} vs ${b.id}=${JSON.stringify(b)}`,
            );
          }
        }
      }
    }
  }

  // 3b. floating windows are never simultaneously tiled
  const lastSnap = snapshots[snapshots.length - 1];
  if (lastSnap) {
    for (const f of lastSnap.floating) {
      if (tiledIds.has(f.hwnd)) {
        throw new Error(`hwnd ${f.hwnd} is both floating and tiled`);
      }
    }
  }
}

function runFuzz(seed: number, opCount: number): void {
  const rnd = mulberry32(seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: (p) => previews.push(p),
    onSnapshot: (s) => snapshots.push(s),
  });
  brain.setMonitors(MONITORS);
  const g1: GridSettings = {
    id: GRID1,
    monitorIds: [MON1.id],
    cols: 12,
    rows: 6,
    mode: 'collision',
    enabled: true,
    activeTemplateId: null,
  };
  const g2: GridSettings = {
    id: GRID2,
    monitorIds: [MON2.id],
    cols: 8,
    rows: 4,
    mode: 'overlay',
    enabled: true,
    activeTemplateId: null,
  };
  brain.enableGrid(g1, []);
  brain.enableGrid(g2, []);

  const wins = new Map<string, ModelWindow>();
  let hwndCounter = 0;

  const randomWindow = (): WindowInfo => {
    const mon = pick(MONITORS);
    const width = randInt(180, Math.min(1400, mon.workWidth));
    const height = randInt(180, Math.min(1100, mon.workHeight));
    return {
      hwnd: String(++hwndCounter),
      title: `Fuzz ${hwndCounter}`,
      exe: 'fuzz.exe',
      x: mon.workX + randInt(0, Math.max(0, mon.workWidth - width)),
      y: mon.workY + randInt(0, Math.max(0, mon.workHeight - height)),
      width,
      height,
      monitorId: mon.id,
      minimized: false,
      resizable: rnd() < 0.9,
    };
  };

  const aliveHwnds = () => [...wins.keys()];
  const visibleHwnds = () =>
    [...wins.entries()].filter(([, w]) => !w.minimized).map(([h]) => h);
  const minimizedHwnds = () =>
    [...wins.entries()].filter(([, w]) => w.minimized).map(([h]) => h);

  // op name -> weight; drawn each iteration.
  const ops: Array<[string, number]> = [
    ['appear', 22],
    ['destroy', 10],
    ['minimize', 10],
    ['restore', 10],
    ['drag', 25],
    ['setMode', 6],
    ['reflow', 7],
    ['applyTemplate', 10],
  ];
  const totalWeight = ops.reduce((s, [, w]) => s + w, 0);
  const drawOp = (): string => {
    let r = rnd() * totalWeight;
    for (const [name, w] of ops) {
      r -= w;
      if (r < 0) return name;
    }
    return ops[ops.length - 1]![0];
  };

  const recentOps: string[] = [];
  let opIndex = 0;
  try {
    for (opIndex = 0; opIndex < opCount; opIndex++) {
      const beforeApply = applies.length;
      let op = drawOp();
      let desc = op;

      switch (op) {
        case 'appear': {
          const w = randomWindow();
          wins.set(w.hwnd, { info: w, minimized: false });
          desc = `appear ${w.hwnd} on ${w.monitorId} ${w.width}x${w.height}${w.resizable ? '' : ' non-resizable'}`;
          brain.windowAppeared(w);
          break;
        }
        case 'destroy': {
          const alive = aliveHwnds();
          if (alive.length === 0) break;
          const h = pick(alive);
          wins.delete(h);
          desc = `destroy ${h}`;
          brain.windowDestroyed(h);
          break;
        }
        case 'minimize': {
          const vis = visibleHwnds();
          if (vis.length === 0) break;
          const h = pick(vis);
          wins.get(h)!.minimized = true;
          desc = `minimize ${h}`;
          brain.windowMinimized(h);
          break;
        }
        case 'restore': {
          const min = minimizedHwnds();
          if (min.length === 0) break;
          const h = pick(min);
          const model = wins.get(h)!;
          model.minimized = false;
          desc = `restore ${h}`;
          brain.windowRestored({ ...model.info, minimized: false });
          break;
        }
        case 'drag': {
          const vis = visibleHwnds();
          if (vis.length === 0) break;
          const h = pick(vis);
          const info = wins.get(h)!.info;
          desc = `drag ${h}`;
          brain.moveSizeStart(h);
          const steps = randInt(0, 4);
          for (let s = 0; s < steps; s++) {
            // Cursor roams the whole virtual desktop, including dead space.
            const cursorX = randInt(-300, 4800);
            const cursorY = randInt(-300, 1600);
            brain.dragMoved({
              hwnd: h,
              cursorX,
              cursorY,
              x: cursorX - Math.floor(info.width / 2),
              y: cursorY - 20,
              width: info.width,
              height: info.height,
            });
          }
          const dropMon = pick(MONITORS);
          let { width, height } = info;
          if (rnd() < 0.3) {
            width = randInt(180, Math.min(1400, dropMon.workWidth));
            height = randInt(180, Math.min(1100, dropMon.workHeight));
          }
          const wild = rnd() < 0.2;
          const rect = wild
            ? {
                x: randInt(-1000, 5000),
                y: randInt(-1000, 2000),
                width,
                height,
              }
            : {
                x: dropMon.workX + randInt(0, Math.max(0, dropMon.workWidth - width)),
                y: dropMon.workY + randInt(0, Math.max(0, dropMon.workHeight - height)),
                width,
                height,
              };
          desc = `drag ${h} -> ${JSON.stringify(rect)}`;
          brain.moveSizeEnd(h, rect);
          info.x = rect.x;
          info.y = rect.y;
          info.width = rect.width;
          info.height = rect.height;
          const center = MONITORS.find(
            (m) =>
              rect.x + rect.width / 2 >= m.x &&
              rect.x + rect.width / 2 < m.x + m.width &&
              rect.y + rect.height / 2 >= m.y &&
              rect.y + rect.height / 2 < m.y + m.height,
          );
          if (center) info.monitorId = center.id;
          break;
        }
        case 'setMode': {
          const gridId = pick(GRID_IDS);
          const mode = pick(['collision', 'overlay'] as const);
          desc = `setMode ${gridId} ${mode}`;
          brain.setMode(gridId, mode);
          break;
        }
        case 'reflow': {
          const gridId = pick(GRID_IDS);
          const cols = randInt(1, 14);
          const rows = randInt(1, 8);
          desc = `reflow ${gridId} ${cols}x${rows}`;
          brain.reflowGrid(gridId, cols, rows);
          break;
        }
        case 'applyTemplate': {
          const gridId = pick(GRID_IDS);
          const tpl = pick(TEMPLATE_IDS);
          desc = `applyTemplate ${gridId} ${tpl}`;
          brain.applyTemplate(gridId, tpl);
          break;
        }
      }

      recentOps.push(`#${opIndex} ${desc}`);
      if (recentOps.length > 25) recentOps.shift();

      checkInvariants(brain, applies, beforeApply, snapshots);
    }
  } catch (e) {
    const cause = e instanceof Error ? e.stack ?? e.message : String(e);
    const msg =
      `FUZZ FAILURE seed=${seed} at op #${opIndex} of ${opCount}\n` +
      `reproduce with: FUZZ_SEED=${seed} npm run test -w packages/brain\n` +
      `last ops:\n  ${recentOps.join('\n  ')}\n` +
      `cause: ${cause}`;
    console.error(msg);
    throw new Error(msg);
  }

  // Sanity that the run actually exercised the brain.
  expect(hwndCounter).toBeGreaterThan(50);
  expect(applies.length).toBeGreaterThan(0);
}

const envSeed = process.env.FUZZ_SEED;
const randomSeed =
  envSeed !== undefined ? Number(envSeed) >>> 0 : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;

describe('fuzz gate', () => {
  it(
    'fixed seed: 1,000 random ops preserve all invariants',
    () => {
      runFuzz(0xc0ffee, 1000);
    },
    120_000,
  );

  it(
    `random seed ${randomSeed}: 1,000 random ops preserve all invariants`,
    () => {
      runFuzz(randomSeed, 1000);
    },
    120_000,
  );
});
