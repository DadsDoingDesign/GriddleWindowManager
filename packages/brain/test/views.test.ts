// Startup views (spec v0.2 §3/§4): a View captures every enabled grid's
// settings (incl. gap/padding) plus each tiled window's exe+slot — exes, not
// hwnds, so a view survives a reboot. Applying a view reconfigures the grids
// and registers the assignments as pending claims for CLAIM_WINDOW_MS:
// windows appearing during the window are first-come-first-claimed per
// assignment (beating app rules); after the timeout or once every claim is
// taken, normal placement rules resume. Time is injected (opts.now) — no
// real timers anywhere in these tests.

import { describe, expect, it } from 'vitest';
import { CLAIM_WINDOW_MS, WindowManagerBrain } from '../src/brain';
import { cellRect, MAX_SPACING_PX } from '../src/coords';
import { defaultConfig, parseConfig, sanitizeConfig, serializeConfig } from '../src/persist';
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

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const MON2_ID = '\\\\.\\DISPLAY2@1920,0';
const GRID_ID = `grid:${MON_ID}`;

function makeMonitor(): MonitorInfo {
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
  };
}

/** Second monitor to the right of the first — never gridded in these tests. */
function makeMonitor2(): MonitorInfo {
  return {
    id: MON2_ID,
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080,
    workX: 1920,
    workY: 0,
    workWidth: 1920,
    workHeight: 1080,
    dpi: 96,
    primary: false,
  };
}

// Default window: 500×400 at the work-area origin → 3×2 cells on 12×6.
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
    mode: 'collision',
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
  clock: { t: number };
}

function harness(cfg?: AppConfig, monitors?: MonitorInfo[]): Harness {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const previews: PreviewState[] = [];
  const clock = { t: 1_000_000 };
  const brain = new WindowManagerBrain(
    {
      onApply: (l) => applies.push(l),
      onPreview: (p) => previews.push(p),
      onSnapshot: (s) => snapshots.push(s),
    },
    cfg,
    { now: () => clock.t },
  );
  const mon = makeMonitor();
  brain.setMonitors(monitors ?? [mon]);
  return { brain, applies, snapshots, previews, mon, clock };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

function tileSlots(snap: StateSnapshot, gridId: string = GRID_ID): Map<string, Slot> {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return new Map(tiles!.map((t) => [t.hwnd, t.slot]));
}

describe('captureView', () => {
  it('snapshots enabled grid settings (incl. spacing) and tiled exes+slots', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings({ gap: 8, padding: 16 }), [
      makeWindow('1', { exe: 'a.exe' }),
      makeWindow('2', { exe: 'b.exe' }),
    ]);
    const view = brain.captureView('Work');
    expect(view.id).toBe('view:1');
    expect(view.name).toBe('Work');
    expect(view.grids).toHaveLength(1);
    const vg = view.grids[0]!;
    expect(vg.settings).toEqual(makeGridSettings({ gap: 8, padding: 16 }));
    expect(vg.assignments).toEqual([
      { exe: 'a.exe', slot: { col: 0, row: 0, w: 3, h: 2 } },
      { exe: 'b.exe', slot: { col: 3, row: 0, w: 3, h: 2 } },
    ]);
  });

  it('appears in the snapshot and exportConfig, with unique sequential ids', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.captureView('One');
    brain.captureView('Two');
    const snap = last(snapshots);
    expect(snap.views.map((v) => v.id)).toEqual(['view:1', 'view:2']);
    expect(snap.startupViewId).toBeNull();
    expect(brain.exportConfig().views.map((v) => v.name)).toEqual(['One', 'Two']);
  });

  it('reuses the smallest free id after a delete', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.captureView('One');
    brain.captureView('Two');
    expect(brain.deleteView('view:1')).toBe(true);
    const v = brain.captureView('Three');
    expect(v.id).toBe('view:1');
  });

  it('throws when no grid is enabled', () => {
    const { brain } = harness();
    expect(() => brain.captureView('Nope')).toThrow();
  });

  it('returns a deep copy — mutating it never touches the stored view', () => {
    const { brain } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'a.exe' })]);
    const view = brain.captureView('Work');
    view.name = 'Mutated';
    view.grids[0]!.assignments[0]!.slot.col = 99;
    const stored = brain.exportConfig().views[0]!;
    expect(stored.name).toBe('Work');
    expect(stored.grids[0]!.assignments[0]!.slot.col).toBe(0);
  });
});

describe('applyView', () => {
  it('restores captured settings and re-places current windows by exe', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ gap: 8 }), [
      makeWindow('1', { exe: 'a.exe' }),
      makeWindow('2', { exe: 'b.exe' }),
    ]);
    brain.moveTileFromEditor(GRID_ID, '2', { col: 6, row: 4, w: 3, h: 2 });
    const view = brain.captureView('Work');

    // Wreck the layout and the settings.
    brain.reflowGrid(GRID_ID, 6, 3);
    brain.setSpacing(GRID_ID, 0, 32);

    expect(
      brain.applyView(view.id, [
        makeWindow('1', { exe: 'a.exe' }),
        makeWindow('2', { exe: 'b.exe' }),
      ]),
    ).toBe(true);
    const snap = last(snapshots);
    const grid = snap.grids.find((g) => g.id === GRID_ID)!;
    expect(grid.cols).toBe(12);
    expect(grid.rows).toBe(6);
    expect(grid.gap).toBe(8);
    expect(grid.padding ?? 0).toBe(0);
    const slots = tileSlots(snap);
    expect(slots.get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots.get('2')).toEqual({ col: 6, row: 4, w: 3, h: 2 });
  });

  it('survives a config round-trip into a fresh brain (reboot path)', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [
      makeWindow('10', { exe: 'a.exe' }),
      makeWindow('11', { exe: 'b.exe' }),
    ]);
    a.brain.moveTileFromEditor(GRID_ID, '11', { col: 9, row: 0, w: 3, h: 2 });
    const view = a.brain.captureView('Work');
    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()));
    expect(cfg).not.toBeNull();
    expect(cfg!.views).toHaveLength(1);

    // Fresh boot: new hwnds, same exes, reversed appearance order.
    const b = harness(cfg!);
    expect(
      b.brain.applyView(view.id, [
        makeWindow('21', { exe: 'b.exe' }),
        makeWindow('20', { exe: 'a.exe' }),
      ]),
    ).toBe(true);
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('20')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots.get('21')).toEqual({ col: 9, row: 0, w: 3, h: 2 });
  });

  it('multi-instance apps claim assignments first-come-first-claimed', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [
      makeWindow('1', { exe: 'multi.exe' }),
      makeWindow('2', { exe: 'multi.exe' }),
    ]);
    const view = a.brain.captureView('Work'); // slots (0,0) then (3,0)

    const b = harness(parseConfig(serializeConfig(a.brain.exportConfig()))!);
    b.brain.applyView(view.id, [
      makeWindow('31', { exe: 'multi.exe' }),
      makeWindow('32', { exe: 'multi.exe' }),
    ]);
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('31')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    expect(slots.get('32')).toEqual({ col: 3, row: 0, w: 3, h: 2 });
  });

  it('windows matching no assignment auto-place', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'a.exe' })]);
    a.brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 0, w: 3, h: 2 });
    const view = a.brain.captureView('Work');

    const b = harness(parseConfig(serializeConfig(a.brain.exportConfig()))!);
    b.brain.applyView(view.id, [
      makeWindow('40', { exe: 'a.exe' }),
      makeWindow('41', { exe: 'stranger.exe' }),
    ]);
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('40')).toEqual({ col: 6, row: 0, w: 3, h: 2 });
    // Auto-place: first free 3×2 in reading order.
    expect(slots.get('41')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('returns false (and emits nothing) for an unknown view id', () => {
    const { brain, snapshots, applies } = harness();
    brain.enableGrid(makeGridSettings(), []);
    const snapsBefore = snapshots.length;
    const appliesBefore = applies.length;
    expect(brain.applyView('view:404', [makeWindow('1')])).toBe(false);
    expect(snapshots.length).toBe(snapsBefore);
    expect(applies.length).toBe(appliesBefore);
  });

  it('windows tiled on grids outside the view stay untouched', () => {
    // Grid on MON1 captured into the view; a second window is tiled on a
    // MON2 grid that the view does not cover.
    const mon2Grid = makeGridSettings({ id: `grid:${MON2_ID}`, monitorIds: [MON2_ID] });
    const { brain, snapshots } = harness(undefined, [makeMonitor(), makeMonitor2()]);
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'a.exe' })]);
    const view = brain.captureView('Work');
    brain.enableGrid(mon2Grid, [
      makeWindow('2', { exe: 'other.exe', monitorId: MON2_ID, x: 1920, y: 0 }),
    ]);
    const before = tileSlots(last(snapshots), mon2Grid.id);

    brain.applyView(view.id, [
      makeWindow('1', { exe: 'a.exe' }),
      makeWindow('2', { exe: 'other.exe', monitorId: MON2_ID, x: 1920, y: 0 }),
    ]);
    expect(tileSlots(last(snapshots), mon2Grid.id)).toEqual(before);
  });
});

describe('pending claims (120 s window, injected clock)', () => {
  /** View with one assignment: claimed.exe at (6,2,4,3); grid 12×6. */
  function claimSetup(appRuleSlot?: Slot) {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'claimed.exe' })]);
    a.brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 2, w: 4, h: 3 });
    const view = a.brain.captureView('Work');
    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()))!;
    const b = harness(cfg);
    if (appRuleSlot) {
      b.brain.setAppRule({ exe: 'claimed.exe', gridId: null, slot: appRuleSlot });
    }
    // Apply with an empty sweep: the assignment stays an unclaimed pending
    // claim for windows that appear later.
    expect(b.brain.applyView(view.id, [])).toBe(true);
    return b;
  }

  it('a window appearing during the claim window takes the assignment slot, beating its app rule', () => {
    const b = claimSetup({ col: 0, row: 0, w: 2, h: 2 });
    b.clock.t += CLAIM_WINDOW_MS - 1;
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    expect(tileSlots(last(b.snapshots)).get('50')).toEqual({ col: 6, row: 2, w: 4, h: 3 });
  });

  it('each assignment is claimed once — the next window falls back to normal rules', () => {
    const b = claimSetup({ col: 0, row: 4, w: 2, h: 2 });
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    b.brain.windowAppeared(makeWindow('51', { exe: 'claimed.exe' }));
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('50')).toEqual({ col: 6, row: 2, w: 4, h: 3 });
    expect(slots.get('51')).toEqual({ col: 0, row: 4, w: 2, h: 2 }); // app rule
  });

  it('claims lapse after CLAIM_WINDOW_MS — the app rule wins again', () => {
    const b = claimSetup({ col: 0, row: 0, w: 2, h: 2 });
    b.clock.t += CLAIM_WINDOW_MS;
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    expect(tileSlots(last(b.snapshots)).get('50')).toEqual({ col: 0, row: 0, w: 2, h: 2 });
  });

  it('non-matching exes during the claim window place normally', () => {
    const b = claimSetup();
    b.brain.windowAppeared(makeWindow('60', { exe: 'stranger.exe' }));
    expect(tileSlots(last(b.snapshots)).get('60')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('a claim pulls a matching window in from an ungridded monitor', () => {
    const a = harness(undefined, [makeMonitor(), makeMonitor2()]);
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'claimed.exe' })]);
    const view = a.brain.captureView('Work');
    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()))!;
    const b = harness(cfg, [makeMonitor(), makeMonitor2()]);
    b.brain.applyView(view.id, []);
    // Appears on the ungridded second monitor — without the claim this
    // window would stay unmanaged.
    b.brain.windowAppeared(
      makeWindow('70', { exe: 'claimed.exe', monitorId: MON2_ID, x: 2000, y: 100 }),
    );
    expect(tileSlots(last(b.snapshots)).get('70')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    const move = last(b.applies).moves.find((m) => m.hwnd === '70')!;
    expect(move).toEqual({
      hwnd: '70',
      ...cellRect(b.mon, { cols: 12, rows: 6 }, { col: 0, row: 0, w: 3, h: 2 }),
    });
  });

  it('manual apply consumes claims for current windows immediately', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'claimed.exe' })]);
    a.brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 2, w: 4, h: 3 });
    const view = a.brain.captureView('Work');
    const b = harness(parseConfig(serializeConfig(a.brain.exportConfig()))!);
    b.brain.applyView(view.id, [makeWindow('80', { exe: 'claimed.exe' })]);
    // The single assignment was claimed by the present window; a later
    // arrival of the same exe places normally.
    b.brain.windowAppeared(makeWindow('81', { exe: 'claimed.exe' }));
    const slots = tileSlots(last(b.snapshots));
    expect(slots.get('80')).toEqual({ col: 6, row: 2, w: 4, h: 3 });
    expect(slots.get('81')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('re-applying a view resets the claim set and the timeout', () => {
    const b = claimSetup();
    b.clock.t += CLAIM_WINDOW_MS; // first window lapses
    expect(b.brain.applyView(b.brain.exportConfig().views[0]!.id, [])).toBe(true);
    b.clock.t += CLAIM_WINDOW_MS - 1; // still inside the *new* window
    b.brain.windowAppeared(makeWindow('90', { exe: 'claimed.exe' }));
    expect(tileSlots(last(b.snapshots)).get('90')).toEqual({ col: 6, row: 2, w: 4, h: 3 });
  });
});

describe('renameView / deleteView / setStartupView', () => {
  function withViews(): Harness {
    const h = harness();
    h.brain.enableGrid(makeGridSettings(), []);
    h.brain.captureView('One');
    h.brain.captureView('Two');
    return h;
  }

  it('renames with trimming and reports the change via snapshot', () => {
    const h = withViews();
    expect(h.brain.renameView('view:1', '  Focus  ')).toBe(true);
    expect(last(h.snapshots).views.find((v) => v.id === 'view:1')!.name).toBe('Focus');
  });

  it('refuses empty names, unknown ids, and no-op renames silently', () => {
    const h = withViews();
    const before = h.snapshots.length;
    expect(h.brain.renameView('view:1', '   ')).toBe(false);
    expect(h.brain.renameView('view:404', 'X')).toBe(false);
    expect(h.brain.renameView('view:1', 'One')).toBe(false);
    expect(h.snapshots.length).toBe(before);
  });

  it('deletes a view and reports a miss without a snapshot', () => {
    const h = withViews();
    expect(h.brain.deleteView('view:1')).toBe(true);
    expect(last(h.snapshots).views.map((v) => v.id)).toEqual(['view:2']);
    const before = h.snapshots.length;
    expect(h.brain.deleteView('view:1')).toBe(false);
    expect(h.snapshots.length).toBe(before);
  });

  it('setStartupView round-trips through snapshot and exportConfig', () => {
    const h = withViews();
    h.brain.setStartupView('view:2');
    expect(last(h.snapshots).startupViewId).toBe('view:2');
    expect(h.brain.exportConfig().startupViewId).toBe('view:2');
    h.brain.setStartupView(null);
    expect(last(h.snapshots).startupViewId).toBeNull();
  });

  it('ignores an unknown startup id and repeat assignments', () => {
    const h = withViews();
    h.brain.setStartupView('view:1');
    const before = h.snapshots.length;
    h.brain.setStartupView('view:404');
    h.brain.setStartupView('view:1');
    expect(h.snapshots.length).toBe(before);
    expect(h.brain.exportConfig().startupViewId).toBe('view:1');
  });

  it('deleting the startup view clears startupViewId', () => {
    const h = withViews();
    h.brain.setStartupView('view:1');
    h.brain.deleteView('view:1');
    expect(last(h.snapshots).startupViewId).toBeNull();
    expect(h.brain.exportConfig().startupViewId).toBeNull();
  });
});

describe('AppConfig v2 migration (spec v0.2 §4)', () => {
  it('migrates a v1 config: empty appRules/views, null startupViewId', () => {
    const cfg = sanitizeConfig({
      version: 1,
      grids: [makeGridSettings()],
      templates: [],
      exclusions: ['slack.exe'],
      layouts: {},
      hotkey: DEFAULT_HOTKEY_STR,
      autostart: true,
      paused: false,
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(3);
    expect(cfg!.appRules).toEqual([]);
    expect(cfg!.views).toEqual([]);
    expect(cfg!.startupViewId).toBeNull();
    // Everything the v1 config carried survives.
    expect(cfg!.grids).toEqual([makeGridSettings()]);
    expect(cfg!.exclusions).toEqual(['slack.exe']);
    expect(cfg!.autostart).toBe(true);
    // The migrated config round-trips stable.
    expect(parseConfig(serializeConfig(cfg!))).toEqual(cfg);
  });

  it('rejects unknown future versions (host quarantines as .bak)', () => {
    expect(sanitizeConfig({ ...defaultConfig(), version: 4 })).toBeNull();
  });

  it('defaultConfig is v3 and round-trips', () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(3);
    expect(cfg.views).toEqual([]);
    expect(cfg.startupViewId).toBeNull();
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it('drops malformed views/assignments but keeps valid ones', () => {
    const goodGrid = makeGridSettings();
    const cfg = sanitizeConfig({
      ...defaultConfig(),
      views: [
        {
          id: 'view:1',
          name: 'Ok',
          grids: [
            {
              settings: goodGrid,
              assignments: [
                { exe: '  Code.EXE ', slot: { col: 0, row: 0, w: 3, h: 2 } },
                { exe: '', slot: { col: 0, row: 0, w: 1, h: 1 } }, // empty exe
                { exe: 'x.exe', slot: { col: 0, row: 0, w: 0, h: 1 } }, // w < 1
                { exe: 'y.exe' }, // no slot
                'garbage',
              ],
            },
            { settings: { id: '', monitorIds: [], cols: 0, rows: 0 } }, // bad grid
            'garbage',
          ],
        },
        { id: 'view:1', name: 'Dup', grids: [] }, // duplicate id
        { id: '', name: 'NoId', grids: [] },
        { id: 'view:2', name: 'NoGrids' }, // grids not an array
        null,
      ],
      startupViewId: 'view:1',
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.views).toEqual([
      {
        id: 'view:1',
        name: 'Ok',
        grids: [
          {
            settings: goodGrid,
            assignments: [{ exe: 'code.exe', slot: { col: 0, row: 0, w: 3, h: 2 } }],
          },
        ],
      },
    ]);
    expect(cfg!.startupViewId).toBe('view:1');
  });

  it('resets a startupViewId that points at no surviving view', () => {
    const cfg = sanitizeConfig({ ...defaultConfig(), startupViewId: 'view:9' });
    expect(cfg).not.toBeNull();
    expect(cfg!.startupViewId).toBeNull();
  });

  it('a loaded config seeds views and startupViewId into the brain', () => {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'a.exe' })]);
    a.brain.captureView('Work');
    a.brain.setStartupView('view:1');
    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()))!;

    const b = harness(cfg);
    const out = b.brain.exportConfig();
    expect(out.views).toEqual(cfg.views);
    expect(out.startupViewId).toBe('view:1');
  });
});

// ── critique round: claims × the monitor-hotplug revive path ───────────────
// The autostart scenario spec v0.2 §3 promises to support: at logon the
// startup view's grid lives on a monitor the docking station enumerates a few
// seconds later. `applyView` leaves that grid inert and registers its
// assignments as claims; when `monitors-changed` fires, the revive sweep runs
// through `enableGrid`, which must honour the claims instead of auto-placing.

describe('pending claims × monitor hotplug', () => {
  /** View on the MON2 grid, captured while MON2 was present. */
  function viewOnMon2(): { cfg: AppConfig; viewId: string } {
    const grid2 = makeGridSettings({ id: `grid:${MON2_ID}`, monitorIds: [MON2_ID] });
    const a = harness(undefined, [makeMonitor(), makeMonitor2()]);
    a.brain.enableGrid(grid2, [
      makeWindow('1', { exe: 'claimed.exe', monitorId: MON2_ID, x: 1920, y: 0 }),
    ]);
    a.brain.moveTileFromEditor(grid2.id, '1', { col: 6, row: 2, w: 4, h: 3 });
    const view = a.brain.captureView('Docked');
    return {
      cfg: parseConfig(serializeConfig(a.brain.exportConfig()))!,
      viewId: view.id,
    };
  }

  it('a monitor arriving inside the claim window honours the assignments', () => {
    const { cfg, viewId } = viewOnMon2();
    // Boot with the external monitor still absent: the grid stays inert and
    // the assignment becomes a pending claim.
    const b = harness(cfg, [makeMonitor()]);
    expect(b.brain.applyView(viewId, [])).toBe(true);

    // Dock: the monitor (and the app's window) show up together.
    b.clock.t += 5_000;
    b.brain.setMonitors(
      [makeMonitor(), makeMonitor2()],
      [makeWindow('90', { exe: 'claimed.exe', monitorId: MON2_ID, x: 1920, y: 0 })],
    );

    const slots = tileSlots(last(b.snapshots), `grid:${MON2_ID}`);
    expect(slots.get('90')).toEqual({ col: 6, row: 2, w: 4, h: 3 });
  });

  it('after the claim window lapses the revive sweep auto-places again', () => {
    const { cfg, viewId } = viewOnMon2();
    const b = harness(cfg, [makeMonitor()]);
    expect(b.brain.applyView(viewId, [])).toBe(true);

    b.clock.t += CLAIM_WINDOW_MS;
    b.brain.setMonitors(
      [makeMonitor(), makeMonitor2()],
      [
        makeWindow('90', {
          exe: 'claimed.exe',
          monitorId: MON2_ID,
          x: 1920,
          y: 0,
          width: 500,
          height: 400,
        }),
      ],
    );
    // Auto-placed at the first free 3×2 instead of the view's 4×3 slot.
    const slots = tileSlots(last(b.snapshots), `grid:${MON2_ID}`);
    expect(slots.get('90')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });
});

// ── critique round: claims × pause ─────────────────────────────────────────

describe('pending claims × pause', () => {
  function claimedView(): { cfg: AppConfig; viewId: string } {
    const a = harness();
    a.brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'claimed.exe' })]);
    a.brain.moveTileFromEditor(GRID_ID, '1', { col: 6, row: 2, w: 4, h: 3 });
    const view = a.brain.captureView('Work');
    return {
      cfg: parseConfig(serializeConfig(a.brain.exportConfig()))!,
      viewId: view.id,
    };
  }

  it('a pause longer than the claim window does not consume it', () => {
    // Boot paused (a persisted pause survives restarts), apply the startup
    // view, resume after more than two minutes: the claims are still live,
    // because pause suppressed every window-appeared that could take them.
    const { cfg, viewId } = claimedView();
    const b = harness({ ...cfg, paused: true });
    expect(b.brain.applyView(viewId, [])).toBe(true);

    b.clock.t += 5 * CLAIM_WINDOW_MS;
    b.brain.setShellPrefs({ paused: false });
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    expect(tileSlots(last(b.snapshots)).get('50')).toEqual({
      col: 6,
      row: 2,
      w: 4,
      h: 3,
    });
  });

  it('the frozen window still lapses on the running clock after the resume', () => {
    const { cfg, viewId } = claimedView();
    const b = harness({ ...cfg, paused: true });
    expect(b.brain.applyView(viewId, [])).toBe(true);
    b.clock.t += 5 * CLAIM_WINDOW_MS;
    b.brain.setShellPrefs({ paused: false });

    b.clock.t += CLAIM_WINDOW_MS;
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    // Lapsed: normal auto-placement, not the view's slot.
    expect(tileSlots(last(b.snapshots)).get('50')).toEqual({
      col: 0,
      row: 0,
      w: 3,
      h: 2,
    });
  });

  it('claims that lapsed before the pause began stay lapsed', () => {
    const { cfg, viewId } = claimedView();
    const b = harness(cfg);
    expect(b.brain.applyView(viewId, [])).toBe(true);
    b.clock.t += CLAIM_WINDOW_MS; // lapsed while running
    b.brain.setShellPrefs({ paused: true });
    b.clock.t += 10_000;
    b.brain.setShellPrefs({ paused: false });
    b.brain.windowAppeared(makeWindow('50', { exe: 'claimed.exe' }));
    expect(tileSlots(last(b.snapshots)).get('50')).toEqual({
      col: 0,
      row: 0,
      w: 3,
      h: 2,
    });
  });
});

// ── critique round: constructor intake normalization ───────────────────────
// The shipped read path is Rust serde straight into the constructor —
// `sanitizeConfig` only runs in tests — so the brain must hold its own
// invariants for a hand-edited but serde-valid config.

describe('constructor intake normalization', () => {
  it('lowercases app-rule exes so they can actually match tracker exes', () => {
    const cfg: AppConfig = {
      ...defaultConfig(),
      appRules: [{ exe: '  Slack.EXE ', gridId: null, slot: { col: 4, row: 0, w: 2, h: 2 } }],
    };
    const { brain, snapshots } = harness(cfg);
    expect(brain.exportConfig().appRules).toEqual([
      { exe: 'slack.exe', gridId: null, slot: { col: 4, row: 0, w: 2, h: 2 } },
    ]);
    brain.enableGrid(makeGridSettings(), []);
    brain.windowAppeared(makeWindow('1', { exe: 'slack.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({
      col: 4,
      row: 0,
      w: 2,
      h: 2,
    });
  });

  it('drops an app rule whose gridId is the empty string (any-grid collision)', () => {
    const cfg: AppConfig = {
      ...defaultConfig(),
      appRules: [
        { exe: 'a.exe', gridId: '', slot: { col: 1, row: 1, w: 1, h: 1 } },
        { exe: 'b.exe', gridId: null, slot: { col: 2, row: 0, w: 1, h: 1 } },
      ],
    };
    const { brain } = harness(cfg);
    expect(brain.exportConfig().appRules).toEqual([
      { exe: 'b.exe', gridId: null, slot: { col: 2, row: 0, w: 1, h: 1 } },
    ]);
  });

  it('clamps out-of-range grid spacing instead of echoing it forever', () => {
    const cfg: AppConfig = {
      ...defaultConfig(),
      grids: [makeGridSettings({ gap: 999, padding: -5 })],
    };
    const { brain, snapshots } = harness(cfg);
    const stored = brain.exportConfig().grids[0]!;
    expect(stored.gap).toBe(MAX_SPACING_PX);
    expect(stored.padding).toBe(0);
    expect(last(snapshots).grids[0]!.gap).toBe(MAX_SPACING_PX);
  });

  it('leaves absent spacing absent (a v1 config round-trips unchanged)', () => {
    const cfg: AppConfig = { ...defaultConfig(), grids: [makeGridSettings()] };
    const { brain } = harness(cfg);
    const stored = brain.exportConfig().grids[0]!;
    expect('gap' in stored).toBe(false);
    expect('padding' in stored).toBe(false);
  });

  it('normalizes view-assignment exes and view grid spacing', () => {
    const cfg: AppConfig = {
      ...defaultConfig(),
      views: [
        {
          id: 'view:1',
          name: 'Hand-edited',
          grids: [
            {
              settings: makeGridSettings({ gap: 999 }),
              assignments: [
                { exe: ' Code.EXE ', slot: { col: 6, row: 0, w: 3, h: 2 } },
                { exe: '   ', slot: { col: 0, row: 0, w: 1, h: 1 } },
              ],
            },
          ],
        },
      ],
    };
    const { brain, snapshots } = harness(cfg);
    const view = brain.exportConfig().views[0]!;
    expect(view.grids[0]!.settings.gap).toBe(MAX_SPACING_PX);
    expect(view.grids[0]!.assignments).toEqual([
      { exe: 'code.exe', slot: { col: 6, row: 0, w: 3, h: 2 } },
    ]);
    // …and the normalized exe actually claims.
    expect(brain.applyView('view:1', [makeWindow('9', { exe: 'code.exe' })])).toBe(true);
    expect(tileSlots(last(snapshots)).get('9')).toEqual({
      col: 6,
      row: 0,
      w: 3,
      h: 2,
    });
  });
});

const DEFAULT_HOTKEY_STR = 'Ctrl+Super+G';
