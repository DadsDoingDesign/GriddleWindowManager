import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import {
  DEFAULT_HOTKEY,
  defaultConfig,
  extractLayoutTiles,
  parseConfig,
  sanitizeConfig,
  serializeConfig,
} from '../src/persist';
import { builtinTemplates } from '../src/templates';
import type {
  AppConfig,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '../src/types';

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const GRID_ID = `grid:${MON_ID}`;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: MON_ID,
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

// Default window: 500×400 → snaps to 3×2 on the 12×6 grid.
function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 500,
    height: 400,
    monitorId: MON_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function makeGridSettings(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID_ID,
    monitorIds: [MON_ID],
    cols: 12,
    rows: 6,
    mode: 'push',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

interface Harness {
  brain: WindowManagerBrain;
  applies: ApplyLayout[];
  snapshots: StateSnapshot[];
  previews: PreviewState[];
  mon: MonitorInfo;
}

function harness(cfg?: AppConfig): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
    },
    cfg,
  );
  const mon = makeMonitor();
  brain.setMonitors([mon]);
  return { brain, applies, snapshots, previews, mon };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function tileSlots(snap: StateSnapshot, gridId: string = GRID_ID) {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return new Map(tiles!.map((t) => [t.hwnd, t.slot]));
}

describe('serializeConfig / parseConfig', () => {
  it('round-trips the default config', () => {
    const cfg = defaultConfig();
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it('round-trips a populated config', () => {
    const cfg: AppConfig = {
      version: 4,
      grids: [makeGridSettings(), makeGridSettings({ id: 'grid:other', enabled: false })],
      templates: [
        {
          id: 'tpl:user:1',
          name: 'Mine',
          cols: 4,
          rows: 2,
          slots: [
            { col: 0, row: 0, w: 2, h: 2 },
            { col: 2, row: 0, w: 2, h: 1 },
          ],
          builtin: false,
        },
      ],
      exclusions: ['slack.exe'],
      layouts: { [GRID_ID]: { version: 1, config: {}, tiles: [] } },
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
              settings: makeGridSettings(),
              assignments: [
                { exe: 'code.exe', slot: { col: 0, row: 0, w: 6, h: 6 } },
              ],
            },
          ],
        },
      ],
      startupViewId: 'view:1',
      autoCheckUpdates: true,
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it('returns null for corrupt JSON, non-objects, and wrong versions', () => {
    expect(parseConfig('{ not json')).toBeNull();
    expect(parseConfig('null')).toBeNull();
    expect(parseConfig('42')).toBeNull();
    expect(parseConfig('[]')).toBeNull();
    expect(parseConfig('{"version":5}')).toBeNull();
    expect(parseConfig('{}')).toBeNull();
  });

  it('drops invalid entries but keeps valid ones', () => {
    const cfg = sanitizeConfig({
      version: 1,
      grids: [
        makeGridSettings(),
        { id: '', monitorIds: [MON_ID], cols: 1, rows: 1, mode: 'push' },
        { id: 'grid:x', monitorIds: [], cols: 1, rows: 1, mode: 'push' },
        { id: 'grid:y', monitorIds: [MON_ID], cols: 0, rows: 1, mode: 'push' },
        { id: 'grid:z', monitorIds: [MON_ID], cols: 2, rows: 2, mode: 'weird' },
        'garbage',
        makeGridSettings(), // duplicate id — dropped
      ],
      templates: [
        { id: 'tpl:user:1', name: 'ok', cols: 2, rows: 1, slots: [{ col: 0, row: 0, w: 2, h: 1 }] },
        { id: 'tpl:user:2', name: 'slot out of bounds', cols: 2, rows: 1, slots: [{ col: 1, row: 0, w: 2, h: 1 }] },
        { id: 'tpl:user:3', name: 'bad slot type', cols: 2, rows: 1, slots: [{ col: 0.5, row: 0, w: 1, h: 1 }] },
        null,
      ],
      exclusions: ['Slack.EXE', 'slack.exe', 7, ''],
      layouts: 'not an object',
      hotkey: '',
      autostart: 'yes',
      paused: 1,
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.grids.map((g) => g.id)).toEqual([GRID_ID]);
    expect(cfg!.templates.map((t) => t.id)).toEqual(['tpl:user:1']);
    expect(cfg!.exclusions).toEqual(['slack.exe']);
    expect(cfg!.layouts).toEqual({});
    expect(cfg!.hotkey).toBe(DEFAULT_HOTKEY);
    expect(cfg!.autostart).toBe(false);
    expect(cfg!.paused).toBe(false);
  });
});

describe('spacing migration (spec v0.2 §4 groundwork)', () => {
  it('a v1 config without gap/padding loads unchanged (absent means 0)', () => {
    const cfg = sanitizeConfig({
      version: 1,
      grids: [makeGridSettings()],
      templates: [],
      exclusions: [],
      layouts: {},
      hotkey: DEFAULT_HOTKEY,
      autostart: false,
      paused: false,
    });
    expect(cfg).not.toBeNull();
    const grid = cfg!.grids[0]!;
    expect(grid.gap).toBeUndefined();
    expect(grid.padding).toBeUndefined();
    // The migrated shape survives a disk round-trip byte-stable.
    expect(parseConfig(serializeConfig(cfg!))).toEqual(cfg);
  });

  it('preserves explicit gap/padding through a round-trip', () => {
    const cfg: AppConfig = {
      ...defaultConfig(),
      grids: [makeGridSettings({ gap: 8, padding: 16 })],
    };
    const parsed = parseConfig(serializeConfig(cfg));
    expect(parsed).toEqual(cfg);
    expect(parsed!.grids[0]!.gap).toBe(8);
    expect(parsed!.grids[0]!.padding).toBe(16);
  });

  it('clamps out-of-range spacing into 0..64 and drops non-numeric values', () => {
    const cfg = sanitizeConfig({
      version: 1,
      grids: [
        makeGridSettings({ id: 'grid:a', gap: 999, padding: -3 }),
        makeGridSettings({ id: 'grid:b', gap: 12.7 }),
        { ...makeGridSettings({ id: 'grid:c' }), gap: 'huge', padding: null },
      ],
    });
    expect(cfg).not.toBeNull();
    const [a, b, c] = cfg!.grids;
    expect(a).toMatchObject({ gap: 64, padding: 0 });
    expect(b!.gap).toBe(12);
    expect(b!.padding).toBeUndefined();
    expect(c!.gap).toBeUndefined();
    expect(c!.padding).toBeUndefined();
  });
});

describe('extractLayoutTiles', () => {
  it('extracts in-flow and absolute tiles from a Grid.toJSON snapshot', () => {
    const tiles = extractLayoutTiles({
      version: 1,
      config: { cols: 12, rows: 6 },
      tiles: [
        { id: '1', col: 0, row: 0, w: 3, h: 2 },
        { id: '2', col: 9, row: 4, w: 3, h: 2, position: 'absolute', pinned: { x: 8, y: 3 } },
      ],
    });
    expect(tiles).toEqual([
      { id: '1', slot: { col: 0, row: 0, w: 3, h: 2 }, absolute: false },
      { id: '2', slot: { col: 8, row: 3, w: 3, h: 2 }, absolute: true },
    ]);
  });

  it('returns null for corrupt snapshots', () => {
    expect(extractLayoutTiles(undefined)).toBeNull();
    expect(extractLayoutTiles(null)).toBeNull();
    expect(extractLayoutTiles('garbage')).toBeNull();
    expect(extractLayoutTiles({})).toBeNull();
    expect(extractLayoutTiles({ version: 2, tiles: [] })).toBeNull();
    expect(extractLayoutTiles({ version: 1, tiles: 'nope' })).toBeNull();
  });

  it('skips malformed and duplicate tiles but keeps the rest', () => {
    const tiles = extractLayoutTiles({
      version: 1,
      config: {},
      tiles: [
        { id: '1', col: 0, row: 0, w: 3, h: 2 },
        { id: '1', col: 5, row: 0, w: 3, h: 2 }, // duplicate id
        { id: '', col: 0, row: 2, w: 1, h: 1 }, // empty id
        { id: '2', col: 0, row: 2, w: 0, h: 1 }, // w < 1
        { id: '3', col: -1, row: 0, w: 1, h: 1 }, // negative col
        { id: '4', col: 0.5, row: 0, w: 1, h: 1 }, // non-integer
        { id: '5', w: 1, h: 1, position: 'absolute' }, // absolute without pinned
        { id: '6', col: 3, row: 2, w: 2, h: 2 },
        'garbage',
      ],
    });
    expect(tiles).toEqual([
      { id: '1', slot: { col: 0, row: 0, w: 3, h: 2 }, absolute: false },
      { id: '6', slot: { col: 3, row: 2, w: 2, h: 2 }, absolute: false },
    ]);
  });
});

describe('exportConfig / constructor round-trip', () => {
  it('round-trips grids, templates, exclusions, and layouts through a new brain', () => {
    const base = defaultConfig();
    base.exclusions = ['excluded.exe'];
    const a = harness(base);
    const windows = [makeWindow('101'), makeWindow('102'), makeWindow('103')];
    a.brain.enableGrid(makeGridSettings(), windows);
    a.brain.captureTemplate(GRID_ID, 'My layout');
    const slotsA = tileSlots(last(a.snapshots));

    const cfg = a.brain.exportConfig();
    expect(cfg.version).toBe(4);
    expect(cfg.grids).toEqual([makeGridSettings()]);
    expect(cfg.exclusions).toEqual(['excluded.exe']);
    expect(cfg.templates.filter((t) => !t.builtin).map((t) => t.name)).toEqual([
      'My layout',
    ]);
    const layoutTiles = extractLayoutTiles(cfg.layouts[GRID_ID]);
    expect(layoutTiles).not.toBeNull();
    expect(layoutTiles!.map((t) => t.id).sort()).toEqual(['101', '102', '103']);

    // The config survives disk serialization untouched.
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);

    // A new brain built from the config reproduces everything.
    const b = harness(cfg);
    b.brain.enableGrid(cfg.grids[0]!, windows);
    const snapB = last(b.snapshots);
    expect(tileSlots(snapB)).toEqual(slotsA);
    expect(snapB.templates).toEqual(last(a.snapshots).templates);
    const cfgB = b.brain.exportConfig();
    expect(cfgB.grids).toEqual(cfg.grids);
    expect(cfgB.templates).toEqual(cfg.templates);
    expect(cfgB.exclusions).toEqual(cfg.exclusions);
  });

  it('restores stored slots even when windows arrive in a different order', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    const slotsA = tileSlots(last(a.snapshots));
    expect(slotsA.get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slotsA.get('2')).toEqual({ col: 3, row: 0, w: 3, h: 2 });

    const cfg = a.brain.exportConfig();
    const b = harness(cfg);
    // Reversed order: fresh placement would put '2' at (0,0). Restore must not.
    b.brain.enableGrid(cfg.grids[0]!, [makeWindow('2'), makeWindow('1')]);
    expect(tileSlots(last(b.snapshots))).toEqual(slotsA);
  });

  it('restores absolute tiles for non-resizable windows and overlay grids', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings({ mode: 'stack' }), [
      makeWindow('1', { x: 640, y: 220 }),
      makeWindow('N', { x: 600, y: 300, resizable: false }),
    ]);
    const slotsA = tileSlots(last(a.snapshots));

    const cfg = a.brain.exportConfig();
    const b = harness(cfg);
    b.brain.enableGrid(cfg.grids[0]!, [
      makeWindow('1', { x: 640, y: 220 }),
      makeWindow('N', { x: 600, y: 300, resizable: false }),
    ]);
    expect(tileSlots(last(b.snapshots))).toEqual(slotsA);
    // Non-resizable window still keeps its own size on apply.
    const nMove = last(b.applies).moves.find((m) => m.hwnd === 'N');
    if (nMove) {
      expect(nMove.width).toBe(500);
      expect(nMove.height).toBe(400);
    }
  });

  it('ignores stored tiles for windows that are gone and places the rest', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    const cfg = a.brain.exportConfig();

    const b = harness(cfg);
    b.brain.enableGrid(cfg.grids[0]!, [makeWindow('2'), makeWindow('9')]);
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('2')).toEqual({ col: 3, row: 0, w: 3, h: 2 }); // restored
    expect(slots.get('9')).toEqual({ col: 0, row: 0, w: 3, h: 2 }); // fresh first-fit
    expect(slots.has('1')).toBe(false);
  });

  it('re-enable after disable restores the previous layout in the same brain', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1'), makeWindow('2')]);
    const slotsBefore = tileSlots(last(snapshots));

    brain.disableGrid(GRID_ID);
    brain.enableGrid(makeGridSettings(), [makeWindow('2'), makeWindow('1')]);
    expect(tileSlots(last(snapshots))).toEqual(slotsBefore);
  });

  it('starts the grid empty (no throw) on a corrupt layouts entry', () => {
    const cfg = defaultConfig();
    cfg.grids = [makeGridSettings()];
    cfg.layouts = {
      [GRID_ID]: { version: 99, tiles: 'garbage' },
    };
    const { brain, applies, snapshots } = harness(cfg);
    expect(() =>
      brain.enableGrid(cfg.grids[0]!, [makeWindow('1'), makeWindow('2')]),
    ).not.toThrow();
    // Fresh placement still happens.
    expect(applies).toHaveLength(1);
    const slots = tileSlots(last(snapshots));
    expect(slots.get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots.get('2')).toEqual({ col: 3, row: 0, w: 3, h: 2 });
  });

  it('starts the grid empty (no throw) on a missing layouts entry', () => {
    const cfg = defaultConfig();
    cfg.grids = [makeGridSettings()];
    const { brain, snapshots } = harness(cfg);
    expect(() => brain.enableGrid(cfg.grids[0]!, [makeWindow('1')])).not.toThrow();
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('skips stored slots that no longer fit the grid dims', () => {
    const cfg = defaultConfig();
    cfg.grids = [makeGridSettings({ cols: 4, rows: 2 })];
    cfg.layouts = {
      [GRID_ID]: {
        version: 1,
        config: { cols: 12, rows: 6 },
        tiles: [
          { id: '1', col: 0, row: 0, w: 2, h: 1 }, // fits the 4×2 grid
          { id: '2', col: 8, row: 4, w: 3, h: 2 }, // out of bounds now
        ],
      },
    };
    const { brain, snapshots } = harness(cfg);
    // 100×100 windows snap to 1×1 when placed fresh.
    brain.enableGrid(cfg.grids[0]!, [
      makeWindow('1', { width: 100, height: 100 }),
      makeWindow('2', { width: 100, height: 100 }),
    ]);
    const slots = tileSlots(last(snapshots));
    expect(slots.get('1')).toEqual({ col: 0, row: 0, w: 2, h: 1 }); // restored
    expect(slots.get('2')).toEqual({ col: 2, row: 0, w: 1, h: 1 }); // placed fresh
  });

  it('exportConfig keeps builtin templates exactly once through repeated round-trips', () => {
    const a = harness();
    const cfg1 = a.brain.exportConfig();
    const b = harness(cfg1);
    const cfg2 = b.brain.exportConfig();
    const builtinIds = builtinTemplates().map((t) => t.id);
    expect(cfg2.templates.filter((t) => t.builtin).map((t) => t.id)).toEqual(builtinIds);
    expect(cfg2.templates).toEqual(cfg1.templates);
  });
});
