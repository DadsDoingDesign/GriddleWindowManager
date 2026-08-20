// Spec 2026-08-20 (template shapes): a template is a *shape*, not a lattice.
// "Two columns" authored on 12x6 is a 2x1 layout and must say so — while
// applying it must not collapse the user's grid to 2x1, which is what
// critique round 3 removed. Show the shape; scale on apply.

import { describe, expect, it } from 'vitest';
import { builtinTemplates, templateShape } from '../src/templates';
import { WindowManagerBrain } from '../src/brain';
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  StateSnapshot,
  Template,
  WindowInfo,
} from '../src/types';

const MON1_ID = '\\\\.\\DISPLAY1@0,0';
const GRID1_ID = `grid:${MON1_ID}`;

function makeMonitor(): MonitorInfo {
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
  };
}

function makeWindow(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: 'app.exe',
    x: 0,
    y: 48,
    width: 400,
    height: 400,
    monitorId: MON1_ID,
    minimized: false,
    resizable: true,
    ...overrides,
  };
}

function gridCfg(overrides: Partial<GridSettings> = {}): GridSettings {
  return {
    id: GRID1_ID,
    monitorIds: [MON1_ID],
    cols: 12,
    rows: 6,
    mode: 'push',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

function harness() {
  const applies: ApplyLayout[] = [];
  const snapshots: StateSnapshot[] = [];
  const brain = new WindowManagerBrain({
    onApply: (l) => applies.push(l),
    onPreview: () => {},
    onSnapshot: (s) => snapshots.push(s),
  });
  brain.setMonitors([makeMonitor()]);
  return { brain, applies, snapshots };
}

function last<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

const byId = (id: string): Template => {
  const t = builtinTemplates().find((b) => b.id === id);
  expect(t).toBeDefined();
  return t!;
};

describe('templateShape', () => {
  it('reduces each built-in to the layout its name describes', () => {
    expect(templateShape(byId('tpl:2col'))).toMatchObject({ cols: 2, rows: 1 });
    expect(templateShape(byId('tpl:3col'))).toMatchObject({ cols: 3, rows: 1 });
    expect(templateShape(byId('tpl:2x2'))).toMatchObject({ cols: 2, rows: 2 });
    expect(templateShape(byId('tpl:rows2'))).toMatchObject({ cols: 1, rows: 2 });
  });

  it('reduces the slots alongside the dims', () => {
    const shape = templateShape(byId('tpl:2col'));
    expect(shape.slots).toEqual([
      { col: 0, row: 0, w: 1, h: 1 },
      { col: 1, row: 0, w: 1, h: 1 },
    ]);
  });

  it('leaves an already-minimal template untouched', () => {
    const tpl: Template = {
      id: 't',
      name: 'T',
      cols: 3,
      rows: 2,
      slots: [{ col: 0, row: 0, w: 1, h: 1 }],
      builtin: false,
    };
    expect(templateShape(tpl)).toMatchObject({ cols: 3, rows: 2 });
  });

  it('reduces each axis independently', () => {
    // Main + side is 7:5 across, full height: nothing divides the columns,
    // but both slots span every row — so it is a *one-row* layout that needs
    // 12 columns to express the split. 12x1 is the honest shape.
    expect(templateShape(byId('tpl:main-side'))).toMatchObject({ cols: 12, rows: 1 });
    const capture: Template = {
      id: 'c',
      name: 'C',
      cols: 12,
      rows: 6,
      slots: [
        { col: 0, row: 0, w: 5, h: 6 },
        { col: 5, row: 0, w: 7, h: 6 },
      ],
      builtin: false,
    };
    expect(templateShape(capture)).toMatchObject({ cols: 12, rows: 1 });
  });

  it('leaves a genuinely irregular capture alone on both axes', () => {
    const capture: Template = {
      id: 'c2',
      name: 'C2',
      cols: 12,
      rows: 6,
      // Odd widths (5, 7) and a 1-row band: nothing divides either axis.
      slots: [
        { col: 0, row: 0, w: 5, h: 1 },
        { col: 5, row: 0, w: 7, h: 6 },
        { col: 0, row: 1, w: 5, h: 5 },
      ],
      builtin: false,
    };
    expect(templateShape(capture)).toMatchObject({ cols: 12, rows: 6 });
  });
});

describe('applyTemplate scales into the current grid', () => {
  it('keeps the grid dims and multiplies the slots when they divide', () => {
    const h = harness();
    // A 4x2 grid, deliberately NOT the template's 12x6: today's code would
    // re-grid to 12x6, and the 2x1 shape scales into 4x2 by (2, 2).
    h.brain.enableGrid(gridCfg({ cols: 4, rows: 2 }), [
      makeWindow('A'),
      makeWindow('B', { x: 1000 }),
    ]);

    h.brain.applyTemplate(GRID1_ID, 'tpl:2col');

    const snap = last(h.snapshots);
    const grid = snap.grids.find((g) => g.id === GRID1_ID)!;
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(2);
    const tiles = snap.tiles[GRID1_ID]!;
    expect(tiles).toHaveLength(2);
    // Two halves of the 4x2 grid: 2 wide, full height.
    for (const t of tiles) {
      expect(t.slot.w).toBe(2);
      expect(t.slot.h).toBe(2);
    }
    expect(tiles.map((t) => t.slot.col).sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it('scales a 2x2 shape into a finer grid', () => {
    const h = harness();
    h.brain.enableGrid(gridCfg({ cols: 8, rows: 4 }), [
      makeWindow('A'),
      makeWindow('B', { x: 500 }),
      makeWindow('C', { x: 1000 }),
      makeWindow('D', { x: 1400 }),
    ]);

    h.brain.applyTemplate(GRID1_ID, 'tpl:2x2');

    const snap = last(h.snapshots);
    const grid = snap.grids.find((g) => g.id === GRID1_ID)!;
    expect(grid.cols).toBe(8);
    expect(grid.rows).toBe(4);
    const tiles = snap.tiles[GRID1_ID]!;
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.slot.w).toBe(4);
      expect(t.slot.h).toBe(2);
    }
  });

  it('still re-grids when the dims do not divide', () => {
    const h = harness();
    // A 5x5 grid cannot host a 2x1 shape by scaling (5 % 2 !== 0).
    h.brain.enableGrid(gridCfg({ cols: 5, rows: 5 }), [makeWindow('A')]);

    h.brain.applyTemplate(GRID1_ID, 'tpl:2col');

    const grid = last(h.snapshots).grids.find((g) => g.id === GRID1_ID)!;
    expect(grid.cols).toBe(12);
    expect(grid.rows).toBe(6);
  });

  it('records the applied template either way', () => {
    const h = harness();
    h.brain.enableGrid(gridCfg({ cols: 8, rows: 4 }), [makeWindow('A')]);
    h.brain.applyTemplate(GRID1_ID, 'tpl:2x2');
    const grid = last(h.snapshots).grids.find((g) => g.id === GRID1_ID)!;
    expect(grid.activeTemplateId).toBe('tpl:2x2');
    expect(grid.cols).toBe(8);
  });
});
