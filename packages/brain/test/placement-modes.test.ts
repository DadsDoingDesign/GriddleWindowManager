// Placement modes (contract C1/C3 extension): the three-way `reflow` / `push`
// / `stack` setting, the v4 config migration that renamed the two original
// modes, and the reflow drop path — the dropped window lands exactly where it
// was aimed and `solveMinimalMoves` reorganises the rest around it, with the
// preview showing that same arrangement before the user lets go.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { defaultConfig, normalizePlacementMode, sanitizeConfig } from '../src/persist';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  Slot,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const MON2_ID = '\\\\.\\DISPLAY2@1920,0';
const GRID1_ID = `grid:${MON1_ID}`;
const GRID2_ID = `grid:${MON2_ID}`;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: MON1_ID,
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

function makeMonitor2(): MonitorInfo {
  return makeMonitor({ id: MON2_ID, x: 1920, workX: 1920, primary: false });
}

/** A window sized to `cells` columns of a 4×1 grid (cell = 480×1032). */
function makeWindow(
  hwnd: string,
  cells = 1,
  overrides: Partial<WindowInfo> = {},
): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 480 * cells,
    height: 1032,
    monitorId: MON1_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function makeGridSettings(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID1_ID,
    monitorIds: [MON1_ID],
    cols: 4,
    rows: 1,
    mode: 'reflow',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

interface Harness {
  brain: WindowManagerBrain;
  applies: ApplyLayout[];
  previews: PreviewState[];
  snapshots: StateSnapshot[];
  mon: MonitorInfo;
  mon2: MonitorInfo;
}

function harness(opts: { twoMonitors?: boolean; cfg?: AppConfig } = {}): Harness {
  const applies: ApplyLayout[] = [];
  const previews: PreviewState[] = [];
  const snapshots: StateSnapshot[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
    },
    opts.cfg,
  );
  const mon = makeMonitor();
  const mon2 = makeMonitor2();
  brain.setMonitors(opts.twoMonitors ? [mon, mon2] : [mon]);
  return { brain, applies, previews, snapshots, mon, mon2 };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function slotsOf(snap: StateSnapshot, gridId = GRID1_ID): Record<string, Slot> {
  const out: Record<string, Slot> = {};
  for (const t of snap.tiles[gridId] ?? []) out[t.hwnd] = t.slot;
  return out;
}

/**
 * The board every drop test uses, on a 4×1 grid:
 *   A(1 wide) at col 0 · B(2 wide) at cols 1–2 · C(1 wide) at col 3.
 * It is completely full — 4 cells, 4 cells of tiles — which is what makes the
 * two in-flow modes disagree: pushing B out of a dropped tile's way has
 * nowhere to go one shove at a time, while a whole-board reorganisation does.
 */
function fullBoard(mode: GridSettings['mode']): Harness {
  const h = harness();
  h.brain.enableGrid(makeGridSettings({ mode }), [
    makeWindow('A', 1),
    makeWindow('B', 2),
    makeWindow('C', 1),
  ]);
  expect(slotsOf(last(h.snapshots))).toEqual({
    A: { col: 0, row: 0, w: 1, h: 1 },
    B: { col: 1, row: 0, w: 2, h: 1 },
    C: { col: 3, row: 0, w: 1, h: 1 },
  });
  return h;
}

/** Drag `hwnd` onto column `col` and release there (cursor-anchored). */
function dragTo(h: Harness, hwnd: string, col: number): void {
  const rect = { x: col * 480, y: 48, width: 480, height: 1032 };
  h.brain.moveSizeStart(hwnd);
  h.brain.dragMoved({
    hwnd,
    cursorX: col * 480 + 240,
    cursorY: 564,
    ...rect,
  });
  h.brain.moveSizeEnd(hwnd, rect);
}

describe('placement mode migration (config v4)', () => {
  it('maps the pre-v4 spellings and rejects nonsense', () => {
    expect(normalizePlacementMode('collision')).toBe('push');
    expect(normalizePlacementMode('overlay')).toBe('stack');
    expect(normalizePlacementMode('reflow')).toBe('reflow');
    expect(normalizePlacementMode('push')).toBe('push');
    expect(normalizePlacementMode('stack')).toBe('stack');
    for (const bad of ['tile', '', null, undefined, 3, {}]) {
      expect(normalizePlacementMode(bad)).toBeNull();
    }
  });

  it('migrates a real v3 config: modes renamed, nothing else touched', () => {
    // Exactly what a v0.2.x install has on disk, modes and all.
    const v3 = {
      version: 3,
      grids: [
        {
          id: GRID1_ID,
          monitorIds: [MON1_ID],
          cols: 12,
          rows: 6,
          mode: 'collision',
          enabled: true,
          activeTemplateId: null,
          gap: 8,
          padding: 16,
        },
        {
          id: GRID2_ID,
          monitorIds: [MON2_ID],
          cols: 8,
          rows: 4,
          mode: 'overlay',
          enabled: false,
          activeTemplateId: 'tpl:2col',
        },
      ],
      templates: [
        {
          id: 'tpl:user:mine',
          name: 'Mine',
          cols: 8,
          rows: 6,
          slots: [{ col: 0, row: 0, w: 5, h: 6 }],
          builtin: false,
        },
      ],
      exclusions: ['slack.exe'],
      layouts: { [GRID1_ID]: { version: 1, tiles: [] } },
      hotkey: 'Ctrl+Alt+G',
      autostart: true,
      paused: true,
      appRules: [
        { exe: 'code.exe', gridId: null, slot: { col: 6, row: 0, w: 6, h: 6 } },
      ],
      views: [
        {
          id: 'view:1',
          name: 'Work',
          grids: [
            {
              settings: {
                id: GRID1_ID,
                monitorIds: [MON1_ID],
                cols: 12,
                rows: 6,
                mode: 'overlay',
                enabled: true,
                activeTemplateId: null,
                gap: 8,
                padding: 16,
              },
              assignments: [{ exe: 'code.exe', slot: { col: 0, row: 0, w: 6, h: 6 } }],
            },
          ],
        },
      ],
      startupViewId: 'view:1',
      autoCheckUpdates: true,
    };

    const cfg = sanitizeConfig(v3);
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(5);

    // The one thing that changes is the spelling of the modes — and the
    // behavior each spelling stood for is preserved exactly.
    expect(cfg!.grids.map((g) => g.mode)).toEqual(['push', 'stack']);
    expect(cfg!.views[0]!.grids[0]!.settings.mode).toBe('stack');
    // Everything else survives byte for byte.
    expect(cfg!.grids[0]).toEqual({ ...v3.grids[0], mode: 'push' });
    expect(cfg!.grids[1]).toEqual({ ...v3.grids[1], mode: 'stack' });
    expect(cfg!.templates).toEqual(v3.templates);
    expect(cfg!.exclusions).toEqual(['slack.exe']);
    expect(cfg!.layouts).toEqual(v3.layouts);
    expect(cfg!.hotkey).toBe('Ctrl+Alt+G');
    expect(cfg!.autostart).toBe(true);
    expect(cfg!.paused).toBe(true);
    expect(cfg!.appRules).toEqual(v3.appRules);
    expect(cfg!.startupViewId).toBe('view:1');
    expect(cfg!.autoCheckUpdates).toBe(true);

    // Stable from here on: the migrated config re-reads identical, and a
    // brain loaded from it exports the same grids.
    expect(sanitizeConfig(cfg)).toEqual(cfg);
    const h = harness({ cfg: cfg! });
    expect(h.brain.exportConfig().grids).toEqual(cfg!.grids);
  });

  it('normalizes legacy modes fed straight to the constructor (Rust read path)', () => {
    // The shipped loader is Rust serde into the constructor, so the brain
    // cannot rely on sanitizeConfig having run.
    const cfg: AppConfig = {
      ...defaultConfig(),
      grids: [
        makeGridSettings({ mode: 'collision' as GridSettings['mode'] }),
        makeGridSettings({
          id: GRID2_ID,
          monitorIds: [MON2_ID],
          mode: 'overlay' as GridSettings['mode'],
        }),
        makeGridSettings({
          id: 'grid:junk',
          monitorIds: ['junk'],
          mode: 'tile' as GridSettings['mode'],
        }),
      ],
    };
    const h = harness({ cfg });
    expect(h.brain.exportConfig().grids.map((g) => g.mode)).toEqual([
      'push',
      'stack',
      'reflow', // unrecognizable → the default, never a broken grid
    ]);
  });

  it('defaultConfig is v4', () => {
    expect(defaultConfig().version).toBe(5);
  });
});

describe('setMode (three-way)', () => {
  it('accepts the legacy names and ignores nonsense', () => {
    const h = fullBoard('reflow');
    h.brain.setMode(GRID1_ID, 'collision');
    expect(last(h.snapshots).grids[0]!.mode).toBe('push');
    h.brain.setMode(GRID1_ID, 'overlay');
    expect(last(h.snapshots).grids[0]!.mode).toBe('stack');

    const before = h.snapshots.length;
    h.brain.setMode(GRID1_ID, 'sideways' as 'push');
    h.brain.setMode(GRID1_ID, 'overlay'); // already stack
    expect(h.snapshots.length).toBe(before);
  });

  it('push ⇄ reflow changes policy only: no tile moves, no apply', () => {
    const h = fullBoard('push');
    const before = slotsOf(last(h.snapshots));
    const applies = h.applies.length;

    h.brain.setMode(GRID1_ID, 'reflow');
    expect(last(h.snapshots).grids[0]!.mode).toBe('reflow');
    expect(slotsOf(last(h.snapshots))).toEqual(before);
    h.brain.setMode(GRID1_ID, 'push');
    expect(slotsOf(last(h.snapshots))).toEqual(before);
    expect(h.applies.length).toBe(applies);
  });

  it('reflow → stack → reflow converts tiles across the stack boundary', () => {
    const h = fullBoard('reflow');
    h.brain.setMode(GRID1_ID, 'stack');
    // Stack tiles are absolute: two windows may now share cells.
    h.brain.moveTileFromEditor(GRID1_ID, 'C', { col: 0, row: 0, w: 1, h: 1 });
    expect(slotsOf(last(h.snapshots))['C']).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(slotsOf(last(h.snapshots))['A']).toEqual({ col: 0, row: 0, w: 1, h: 1 });

    h.brain.setMode(GRID1_ID, 'reflow');
    // Back in flow, nothing overlaps any more.
    const slots = Object.values(slotsOf(last(h.snapshots)));
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const overlaps =
          a.col < b.col + b.w &&
          b.col < a.col + a.w &&
          a.row < b.row + b.h &&
          b.row < a.row + a.h;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe('reflow drops', () => {
  it('lands the window exactly where it was aimed and reorganises the rest', () => {
    const h = fullBoard('reflow');
    const applies = h.applies.length;

    dragTo(h, 'A', 1); // straight onto B's left half

    expect(slotsOf(last(h.snapshots))).toEqual({
      A: { col: 1, row: 0, w: 1, h: 1 }, // exactly the aimed cell
      B: { col: 2, row: 0, w: 2, h: 1 },
      C: { col: 0, row: 0, w: 1, h: 1 },
    });
    // Everything the drop moved lands in ONE batch: the displaced windows are
    // not a second, later apply.
    expect(h.applies.length).toBe(applies + 1);
    const moved = last(h.applies).moves.map((m) => m.hwnd).sort();
    expect(moved).toEqual(['A', 'B', 'C']);
  });

  it('is what the preview promised: the ghosts are the final slots', () => {
    const h = fullBoard('reflow');
    h.brain.moveSizeStart('A');
    h.brain.dragMoved({
      hwnd: 'A',
      cursorX: 720,
      cursorY: 564,
      x: 480,
      y: 48,
      width: 480,
      height: 1032,
    });

    const preview = last(h.previews);
    expect(preview.footprint).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(preview.ghosts).toEqual([
      {
        hwnd: 'B',
        from: { col: 1, row: 0, w: 2, h: 1 },
        to: { col: 2, row: 0, w: 2, h: 1 },
      },
      {
        hwnd: 'C',
        from: { col: 3, row: 0, w: 1, h: 1 },
        to: { col: 0, row: 0, w: 1, h: 1 },
      },
    ]);

    h.brain.moveSizeEnd('A', { x: 480, y: 48, width: 480, height: 1032 });
    const after = slotsOf(last(h.snapshots));
    expect(after['A']).toEqual(preview.footprint);
    for (const g of preview.ghosts) expect(after[g.hwnd]).toEqual(g.to);
  });

  it('push refuses the same drop — which is the whole point of the mode', () => {
    const h = fullBoard('push');
    dragTo(h, 'A', 1);
    // Griddle can only shove B one step at a time and there is nowhere to
    // shove it to, so the drop is refused and A snaps back.
    expect(slotsOf(last(h.snapshots))).toEqual({
      A: { col: 0, row: 0, w: 1, h: 1 },
      B: { col: 1, row: 0, w: 2, h: 1 },
      C: { col: 3, row: 0, w: 1, h: 1 },
    });
  });

  it('falls back to push when the solver cannot help', () => {
    // A 5th window on a 4-cell grid cannot fit in any arrangement, so the
    // solver declines and the drop behaves exactly like push mode: nothing
    // overlaps and the grid stays coherent.
    const h = fullBoard('reflow');
    h.brain.windowAppeared(makeWindow('D', 2));
    expect(last(h.snapshots).floating.map((f) => f.hwnd)).toEqual(['D']);

    dragTo(h, 'A', 3); // C's cell; C is 1 wide, A is 1 wide → a plain swap
    const after = slotsOf(last(h.snapshots));
    expect(after['A']).toEqual({ col: 3, row: 0, w: 1, h: 1 });
    expect(after['C']).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('a resize commits through the solver too', () => {
    // A(1) at col 0, B(2) at cols 1-2, col 3 free.
    const h = harness();
    h.brain.enableGrid(makeGridSettings({ mode: 'reflow' }), [
      makeWindow('A', 1),
      makeWindow('B', 2),
    ]);
    // Grow A from 1 to 2 cells in place: B slides right to make room.
    const rect = { x: 0, y: 48, width: 960, height: 1032 };
    h.brain.moveSizeStart('A');
    h.brain.dragMoved({ hwnd: 'A', cursorX: 240, cursorY: 564, ...rect });
    h.brain.moveSizeEnd('A', rect);

    expect(slotsOf(last(h.snapshots))).toEqual({
      A: { col: 0, row: 0, w: 2, h: 1 },
      B: { col: 2, row: 0, w: 2, h: 1 },
    });
  });

  it('an editor drop reflows the same way a native drop does', () => {
    const h = fullBoard('reflow');
    h.brain.moveTileFromEditor(GRID1_ID, 'A', { col: 1, row: 0, w: 1, h: 1 });
    expect(slotsOf(last(h.snapshots))).toEqual({
      A: { col: 1, row: 0, w: 1, h: 1 },
      B: { col: 2, row: 0, w: 2, h: 1 },
      C: { col: 0, row: 0, w: 1, h: 1 },
    });
  });

  it('a window arriving from another monitor takes its cells too', () => {
    const h = harness({ twoMonitors: true });
    h.brain.enableGrid(makeGridSettings({ mode: 'reflow' }), [
      makeWindow('B', 2),
      makeWindow('C', 1, { x: 1440 }),
    ]);
    h.brain.enableGrid(
      makeGridSettings({ id: GRID2_ID, monitorIds: [MON2_ID], mode: 'reflow' }),
      [makeWindow('A', 1, { monitorId: MON2_ID, x: 1920 })],
    );
    expect(slotsOf(last(h.snapshots))).toEqual({
      B: { col: 0, row: 0, w: 2, h: 1 },
      C: { col: 2, row: 0, w: 1, h: 1 },
    });

    // Drag A off monitor 2 and drop it on monitor 1's second column.
    h.brain.moveSizeStart('A');
    const rect = { x: 480, y: 48, width: 480, height: 1032 };
    h.brain.dragMoved({ hwnd: 'A', cursorX: 720, cursorY: 564, ...rect });
    h.brain.moveSizeEnd('A', rect);

    const after = slotsOf(last(h.snapshots));
    expect(after['A']).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(after['B']).toEqual({ col: 2, row: 0, w: 2, h: 1 });
    expect(after['C']).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    expect(last(h.snapshots).tiles[GRID2_ID]).toEqual([]);
  });

  it('never displaces a non-resizable window (it is out of flow in every mode)', () => {
    const h = harness();
    h.brain.enableGrid(makeGridSettings({ mode: 'reflow' }), [
      makeWindow('A', 1),
      makeWindow('FIXED', 1, { resizable: false, x: 480 }),
    ]);
    expect(slotsOf(last(h.snapshots))['FIXED']).toEqual({ col: 1, row: 0, w: 1, h: 1 });

    dragTo(h, 'A', 1); // straight onto the fixed window's cell
    const after = slotsOf(last(h.snapshots));
    expect(after['A']).toEqual({ col: 1, row: 0, w: 1, h: 1 });
    expect(after['FIXED']).toEqual({ col: 1, row: 0, w: 1, h: 1 }); // unmoved
  });
});
