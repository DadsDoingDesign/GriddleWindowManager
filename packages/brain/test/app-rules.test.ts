// App rules (spec v0.2 §2): per-app default placement. AppRule = one slot
// per (exe, gridId) — gridId null meaning "any grid" — applied when a window
// of that exe APPEARS (never retroactively). Placement precedence on
// windowAppeared: restore-previous tile → grid-specific rule → any-grid rule
// → active-template empty slot → auto-place. Rule slots clamp into the
// current dims; an occupied rule slot in collision mode displaces
// (addTileWithDisplacement at the rule slot); a rule slot that cannot take
// the tile falls through to the next precedence level.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { cellRect } from '../src/coords';
import { defaultConfig, parseConfig, sanitizeConfig, serializeConfig } from '../src/persist';
import type {
  AppConfig,
  AppRule,
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  PreviewState,
  Slot,
  StateSnapshot,
  Template,
  WindowInfo,
} from '../src/types';

const MON_ID = '\\\\.\\DISPLAY1@0,0';
const GRID_ID = `grid:${MON_ID}`;
const DIMS = { cols: 12, rows: 6 };

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

// Default window: 500×400 at the work-area origin → 3×2 cells on a 12×6 grid.
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

function tileSlots(snap: StateSnapshot, gridId: string = GRID_ID): Map<string, Slot> {
  const tiles = snap.tiles[gridId];
  expect(tiles).toBeDefined();
  return new Map(tiles!.map((t) => [t.hwnd, t.slot]));
}

const RULE_SLOT: Slot = { col: 6, row: 2, w: 4, h: 3 };

function rule(overrides: Partial<AppRule> = {}): AppRule {
  return { exe: 'ruled.exe', gridId: null, slot: { ...RULE_SLOT }, ...overrides };
}

describe('setAppRule / removeAppRule', () => {
  it('stores a normalized rule, visible in snapshot and exportConfig', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ exe: '  Ruled.EXE ' }));
    expect(last(snapshots).appRules).toEqual([rule()]);
    expect(brain.exportConfig().appRules).toEqual([rule()]);
  });

  it('overwrites on the same (exe, gridId) key', () => {
    const { brain } = harness();
    brain.setAppRule(rule());
    brain.setAppRule(rule({ slot: { col: 0, row: 0, w: 2, h: 2 } }));
    expect(brain.exportConfig().appRules).toEqual([
      rule({ slot: { col: 0, row: 0, w: 2, h: 2 } }),
    ]);
  });

  it('keeps grid-specific and any-grid rules for the same exe side by side', () => {
    const { brain } = harness();
    brain.setAppRule(rule());
    brain.setAppRule(rule({ gridId: GRID_ID, slot: { col: 0, row: 0, w: 3, h: 3 } }));
    expect(brain.exportConfig().appRules).toHaveLength(2);
  });

  it('removeAppRule removes exactly the addressed scope and reports it', () => {
    const { brain, snapshots } = harness();
    brain.setAppRule(rule());
    brain.setAppRule(rule({ gridId: GRID_ID }));
    expect(brain.removeAppRule('Ruled.exe', GRID_ID)).toBe(true);
    expect(brain.exportConfig().appRules).toEqual([rule()]);
    const before = snapshots.length;
    expect(brain.removeAppRule('ruled.exe', GRID_ID)).toBe(false);
    expect(brain.removeAppRule('other.exe', null)).toBe(false);
    expect(snapshots.length).toBe(before); // failed removes emit nothing
  });

  it('never moves already-managed windows (rules are not retroactive)', () => {
    const { brain, applies, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'ruled.exe' })]);
    const appliesBefore = applies.length;
    brain.setAppRule(rule());
    expect(applies.length).toBe(appliesBefore); // no apply, only a snapshot
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('ignores invalid rules (empty exe, empty gridId, malformed slot)', () => {
    const { brain, snapshots } = harness();
    const before = snapshots.length;
    brain.setAppRule(rule({ exe: '   ' }));
    brain.setAppRule(rule({ gridId: '' }));
    brain.setAppRule(rule({ slot: { col: 0, row: 0, w: 0, h: 1 } }));
    brain.setAppRule(rule({ slot: { col: Number.NaN, row: 0, w: 1, h: 1 } }));
    expect(brain.exportConfig().appRules).toEqual([]);
    expect(snapshots.length).toBe(before);
  });

  it('re-saving an identical rule is a no-op (no snapshot)', () => {
    const { brain, snapshots } = harness();
    brain.setAppRule(rule());
    const before = snapshots.length;
    brain.setAppRule(rule());
    expect(snapshots.length).toBe(before);
  });
});

describe('placement precedence on windowAppeared', () => {
  it('an any-grid rule places the appearing window at the rule slot', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule());
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual(RULE_SLOT);
    expect(last(applies).moves).toContainEqual({
      hwnd: '1',
      ...cellRect(mon, DIMS, RULE_SLOT),
    });
  });

  it('grid-specific beats any-grid', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    const specific: Slot = { col: 0, row: 4, w: 3, h: 2 };
    brain.setAppRule(rule());
    brain.setAppRule(rule({ gridId: GRID_ID, slot: specific }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual(specific);
  });

  it('a rule scoped to a different grid does not match', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ gridId: 'grid:elsewhere' }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('an unplaceable grid-specific rule falls through to the any-grid rule', () => {
    // 4×1 grid, cell 0 occupied. The grid-specific rule wants all 4 cells —
    // displacement cannot fit 4 + 1 cells into 4 — so the any-grid rule's
    // free 2-cell slot wins.
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 4, rows: 1 }), [
      makeWindow('A', { width: 100, height: 100 }),
    ]);
    brain.setAppRule(rule({ gridId: GRID_ID, slot: { col: 0, row: 0, w: 4, h: 1 } }));
    brain.setAppRule(rule({ slot: { col: 2, row: 0, w: 2, h: 1 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe', width: 100, height: 100 }));
    const slots = tileSlots(last(snapshots));
    expect(slots.get('1')).toEqual({ col: 2, row: 0, w: 2, h: 1 });
    expect(slots.get('A')).toEqual({ col: 0, row: 0, w: 1, h: 1 });
  });

  it('a rule beats the active template\'s empty slot', () => {
    const tpl: Template = {
      id: 'tpl:t',
      name: 'T',
      cols: 12,
      rows: 6,
      slots: [
        { col: 0, row: 0, w: 6, h: 6 },
        { col: 6, row: 0, w: 6, h: 6 },
      ],
      builtin: false,
    };
    const { brain, snapshots } = harness({ ...defaultConfig(), templates: [tpl] });
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.applyTemplate(GRID_ID, 'tpl:t'); // A → slot 0; slot 1 stays empty
    brain.setAppRule(rule({ slot: { col: 9, row: 4, w: 3, h: 2 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 9, row: 4, w: 3, h: 2 });
  });

  it('the active template\'s first empty slot beats auto-place', () => {
    const tpl: Template = {
      id: 'tpl:t',
      name: 'T',
      cols: 12,
      rows: 6,
      slots: [
        { col: 0, row: 0, w: 6, h: 6 },
        { col: 6, row: 0, w: 6, h: 3 },
        { col: 6, row: 3, w: 6, h: 3 },
      ],
      builtin: false,
    };
    const { brain, snapshots } = harness({ ...defaultConfig(), templates: [tpl] });
    brain.enableGrid(makeGridSettings(), [makeWindow('A'), makeWindow('B')]);
    brain.applyTemplate(GRID_ID, 'tpl:t'); // A, B → slots 0-1; slot 2 empty
    brain.windowAppeared(makeWindow('1'));
    // Auto-place would first-fit a 3×2 at the top row; the template's empty
    // slot (6,3,6,3) must win.
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 6, row: 3, w: 6, h: 3 });
  });

  it('a fully occupied active template falls through to auto-place', () => {
    const tpl: Template = {
      id: 'tpl:t',
      name: 'T',
      cols: 12,
      rows: 6,
      slots: [{ col: 0, row: 0, w: 6, h: 6 }],
      builtin: false,
    };
    const { brain, snapshots } = harness({ ...defaultConfig(), templates: [tpl] });
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]);
    brain.applyTemplate(GRID_ID, 'tpl:t'); // the single slot is taken
    brain.windowAppeared(makeWindow('1'));
    // First-fit for a 3×2: reading order lands right of the 6×6 block.
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 6, row: 0, w: 3, h: 2 });
  });

  it('restore-previous beats every rule', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'ruled.exe' })]);
    brain.moveTileFromEditor(GRID_ID, '1', { col: 5, row: 3, w: 3, h: 2 });
    brain.windowMinimized('1'); // remembered at (5,3,3,2)
    brain.setAppRule(rule());
    // Reconcile-style re-entry: the remembered hwnd arrives via
    // windowAppeared, not windowRestored.
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 5, row: 3, w: 3, h: 2 });
  });

  it('rules do not fire on windowRestored (restore fallback auto-places)', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ slot: { col: 6, row: 0, w: 3, h: 2 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' })); // → rule slot (6,0)
    brain.windowMinimized('1'); // remembered at (6,0,3,2)
    brain.windowAppeared(makeWindow('2'));
    brain.moveTileFromEditor(GRID_ID, '2', { col: 6, row: 0, w: 3, h: 2 }); // occupy it
    brain.windowRestored(makeWindow('1', { exe: 'ruled.exe' }));
    const slots = tileSlots(last(snapshots));
    // Rule at the occupied (6,0) would displace '2'; the restore fallback
    // must auto-place instead (first free 3×2 in reading order).
    expect(slots.get('2')).toEqual({ col: 6, row: 0, w: 3, h: 2 });
    expect(slots.get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('rules do not fire on an enableGrid sweep', () => {
    const { brain, snapshots } = harness();
    brain.setAppRule(rule());
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'ruled.exe' })]);
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });

  it('a re-appearance of an already-tiled window changes nothing', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('1', { exe: 'ruled.exe' })]);
    brain.setAppRule(rule());
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
  });
});

describe('rule slot clamping and displacement', () => {
  it('clamps a rule slot that overhangs the grid into bounds', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ slot: { col: 10, row: 4, w: 6, h: 4 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 6, row: 2, w: 6, h: 4 });
  });

  it('clamps a rule saved on bigger dims after the grid shrank', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ gridId: GRID_ID, slot: { col: 4, row: 0, w: 4, h: 6 } }));
    brain.reflowGrid(GRID_ID, 6, 3);
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 2, row: 0, w: 4, h: 3 });
  });

  it('an occupied rule slot in collision mode displaces the tenant', () => {
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings(), [makeWindow('A')]); // A at (0,0,3,2)
    brain.setAppRule(rule({ slot: { col: 0, row: 0, w: 3, h: 2 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    const slots = tileSlots(last(snapshots));
    expect(slots.get('1')).toEqual({ col: 0, row: 0, w: 3, h: 2 });
    const a = slots.get('A')!;
    expect(a).not.toEqual({ col: 0, row: 0, w: 3, h: 2 }); // displaced, kept
    expect(a.w).toBe(3);
    expect(a.h).toBe(2);
  });

  it('an occupied rule slot in overlay mode overlaps freely', () => {
    const { brain, snapshots, mon, applies } = harness();
    brain.enableGrid(makeGridSettings({ mode: 'stack' }), [
      makeWindow('A', { x: 800, y: 400 }),
    ]);
    brain.setAppRule(rule({ slot: { col: 6, row: 2, w: 3, h: 2 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe', x: 800, y: 400 }));
    expect(tileSlots(last(snapshots)).get('1')).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    expect(last(applies).moves).toContainEqual({
      hwnd: '1',
      ...cellRect(mon, DIMS, { col: 6, row: 2, w: 3, h: 2 }),
    });
  });

  it('a non-resizable window position-snaps to the rule slot, size untouched', () => {
    const { brain, applies, snapshots, mon } = harness();
    brain.enableGrid(makeGridSettings(), []);
    brain.setAppRule(rule({ slot: { col: 6, row: 2, w: 3, h: 2 } }));
    brain.windowAppeared(makeWindow('N', { exe: 'ruled.exe', resizable: false }));
    expect(tileSlots(last(snapshots)).get('N')).toEqual({ col: 6, row: 2, w: 3, h: 2 });
    const cell = cellRect(mon, DIMS, { col: 6, row: 2, w: 3, h: 2 });
    expect(last(applies).moves).toContainEqual({
      hwnd: 'N',
      x: cell.x,
      y: cell.y,
      width: 500,
      height: 400,
    });
  });

  it('a rule the grid cannot take at all falls through to auto-place/floating', () => {
    // 2×1 grid fully packed: the rule slot cannot displace (2 + 2 > 2 cells)
    // and no free slot exists either — the window floats, like auto-place.
    const { brain, snapshots } = harness();
    brain.enableGrid(makeGridSettings({ cols: 2, rows: 1 }), [
      makeWindow('A', { width: 100, height: 100 }),
      makeWindow('B', { width: 100, height: 100 }),
    ]);
    brain.setAppRule(rule({ slot: { col: 0, row: 0, w: 2, h: 1 } }));
    brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe', width: 1900, height: 1000 }));
    const snap = last(snapshots);
    expect(snap.floating.map((f) => f.hwnd)).toContain('1');
    expect(tileSlots(snap).has('1')).toBe(false);
  });
});

describe('appRules persistence', () => {
  it('round-trips through serialize/parse and fires from a loaded config', () => {
    const a = harness();
    a.brain.setAppRule(rule());
    a.brain.setAppRule(rule({ gridId: GRID_ID, slot: { col: 0, row: 4, w: 3, h: 2 } }));
    const cfg = parseConfig(serializeConfig(a.brain.exportConfig()));
    expect(cfg).not.toBeNull();
    expect(cfg!.appRules).toEqual(a.brain.exportConfig().appRules);

    const b = harness(cfg!);
    b.brain.enableGrid(makeGridSettings(), []);
    b.brain.windowAppeared(makeWindow('1', { exe: 'ruled.exe' }));
    expect(tileSlots(last(b.snapshots)).get('1')).toEqual({ col: 0, row: 4, w: 3, h: 2 });
  });

  it('a v1 config without appRules migrates to an empty list (spec v0.2 §4)', () => {
    const cfg = sanitizeConfig({
      version: 1,
      grids: [],
      templates: [],
      exclusions: [],
      layouts: {},
      hotkey: 'Ctrl+Super+G',
      autostart: false,
      paused: false,
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.appRules).toEqual([]);
    const { brain } = harness(cfg!);
    expect(brain.exportConfig().appRules).toEqual([]);
  });

  it('sanitizeConfig drops invalid rules, dedupes, and normalizes exe case', () => {
    const cfg = sanitizeConfig({
      ...defaultConfig(),
      appRules: [
        { exe: 'Code.EXE', gridId: null, slot: { col: 20, row: 0, w: 4, h: 3 } },
        { exe: 'code.exe', gridId: null, slot: { col: 0, row: 0, w: 1, h: 1 } }, // dupe
        { exe: 'code.exe', gridId: GRID_ID, slot: { col: 1, row: 1, w: 2, h: 2 } },
        { exe: '', gridId: null, slot: { col: 0, row: 0, w: 1, h: 1 } }, // empty exe
        { exe: 'x.exe', gridId: 7, slot: { col: 0, row: 0, w: 1, h: 1 } }, // bad gridId
        { exe: 'y.exe', gridId: null, slot: { col: 0, row: 0, w: 0, h: 1 } }, // w < 1
        { exe: 'z.exe', gridId: null, slot: { col: -1, row: 0, w: 1, h: 1 } }, // col < 0
        { exe: 'q.exe', gridId: null, slot: { col: 0.5, row: 0, w: 1, h: 1 } }, // non-int
        { exe: 'r.exe', gridId: null }, // no slot
        'garbage',
      ],
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.appRules).toEqual([
      // Out-of-bounds col survives sanitize: it clamps at fire time.
      { exe: 'code.exe', gridId: null, slot: { col: 20, row: 0, w: 4, h: 3 } },
      { exe: 'code.exe', gridId: GRID_ID, slot: { col: 1, row: 1, w: 2, h: 2 } },
    ]);
  });

  it('defaultConfig carries an empty appRules list and round-trips', () => {
    const cfg = defaultConfig();
    expect(cfg.appRules).toEqual([]);
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });
});
