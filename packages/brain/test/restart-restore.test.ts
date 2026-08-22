// Surviving a restart (field report 2026-08-22).
//
// After a reboot a browser came back rendered as a collapsed, half-painted
// frame, and the release log explained why: 88 moves with a non-positive size
// had reached `SetWindowPos` over three days — 68 of them `0x0`, 19 `396x0`,
// one `-221x-41`.
//
// The trail runs backwards from there. At boot the displays arrive one at a
// time ("display change detected: 1 monitor(s)" then "2 monitor(s)", twice a
// second), and while that settles Windows can report an *empty work area*.
// `effectiveSpacing` divides the work area into cells, so a zero extent turns
// into zero-sized cells and then into zero-sized windows, faithfully, with
// nothing in the chain objecting.
//
// The same boot is also when the window set is least trustworthy: the tracker
// seeded with as few as 2 eligible windows on the bad run, against 10-12 on a
// settled one, because apps had not finished creating their windows yet.
//
// These are the evals for both halves: never emit geometry that would destroy
// a window, and converge on the real desktop as it finishes appearing.

import { describe, expect, it } from "vitest";
import { WindowManagerBrain } from "../src/brain";
import { defaultConfig, parseConfig, serializeConfig } from "../src/persist";
import type {
  ApplyLayout,
  GridSettings,
  MonitorInfo,
  StateSnapshot,
  WindowInfo,
} from "../src/types";

const MON1_ID = "\\\\.\\DISPLAY1@0,0";
const GRID1_ID = `grid:${MON1_ID}`;

function monitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: MON1_ID,
    x: 0,
    y: 0,
    width: 3840,
    height: 2160,
    workX: 0,
    workY: 0,
    workWidth: 3840,
    workHeight: 2112,
    dpi: 96,
    primary: true,
    ...overrides,
  };
}

function win(hwnd: string, overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd,
    title: `Window ${hwnd}`,
    exe: "app.exe",
    x: 100,
    y: 100,
    width: 900,
    height: 700,
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
    cols: 3,
    rows: 3,
    mode: "push",
    enabled: true,
    activeTemplateId: null,
    gap: 8,
    padding: 8,
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
  return { brain, applies, snapshots };
}

/** Every move the brain has asked for, flattened. */
const allMoves = (applies: ApplyLayout[]) => applies.flatMap((a) => a.moves);

/** The moves that would collapse a window if the OS accepted them. */
const destructive = (applies: ApplyLayout[]) =>
  allMoves(applies).filter((m) => m.width <= 0 || m.height <= 0);

describe("a monitor Griddle cannot measure", () => {
  // The exact shape seen at boot: the work area comes back empty while the
  // display topology is still settling.
  const DEGENERATE: Array<[string, Partial<MonitorInfo>]> = [
    ["empty work area", { workWidth: 0, workHeight: 0 }],
    ["zero height only", { workHeight: 0 }],
    ["zero width only", { workWidth: 0 }],
    ["inverted work rect", { workWidth: -221, workHeight: -41 }],
  ];

  for (const [name, patch] of DEGENERATE) {
    it(`never produces a window-destroying move — ${name}`, () => {
      const h = harness();
      h.brain.setMonitors([monitor(patch)]);
      h.brain.enableGrid(gridCfg(), [win("A"), win("B"), win("C")]);
      h.brain.windowAppeared(win("D"));

      expect(
        destructive(h.applies),
        `emitted ${JSON.stringify(destructive(h.applies))}`,
      ).toEqual([]);
    });
  }

  it("recovers once the display reports a real work area", () => {
    const h = harness();
    // Boot order, as logged: a degenerate reading, then the truth.
    h.brain.setMonitors([monitor({ workWidth: 0, workHeight: 0 })]);
    h.brain.enableGrid(gridCfg(), [win("A"), win("B")]);
    // The host pairs `monitors-changed` with a fresh window sweep, so the
    // grid revives against the desktop as it is now, not as it was.
    h.brain.setMonitors([monitor()], [win("A"), win("B")]);

    expect(destructive(h.applies)).toEqual([]);
    // And it does not just stay silent forever — real geometry follows.
    const good = allMoves(h.applies).filter((m) => m.width > 0 && m.height > 0);
    expect(
      good.length,
      "a measurable monitor must actually get a layout",
    ).toBeGreaterThan(0);
  });
});

describe("the boot race: windows that are not there yet", () => {
  it("places the windows present at seed and the ones that arrive later", () => {
    const h = harness();
    h.brain.setMonitors([monitor()]);
    // The bad run seeded with 2 of 12 — apps had not finished starting.
    h.brain.enableGrid(gridCfg(), [win("early-1"), win("early-2")]);

    const seeded = h.snapshots.at(-1)!.tiles[GRID1_ID] ?? [];
    expect(seeded.map((t) => t.hwnd).sort()).toEqual(["early-1", "early-2"]);

    for (const hwnd of ["late-1", "late-2", "late-3"])
      h.brain.windowAppeared(win(hwnd));

    const after = h.snapshots.at(-1)!.tiles[GRID1_ID] ?? [];
    expect(
      after.map((t) => t.hwnd).sort(),
      "late arrivals must join the grid, not be stranded",
    ).toEqual(["early-1", "early-2", "late-1", "late-2", "late-3"]);
    expect(destructive(h.applies)).toEqual([]);
  });

  it("gives every window its own cell rather than stacking them in push mode", () => {
    const h = harness();
    h.brain.setMonitors([monitor()]);
    h.brain.enableGrid(gridCfg(), [win("A")]);
    for (const hwnd of ["B", "C", "D"]) h.brain.windowAppeared(win(hwnd));

    const tiles = h.snapshots.at(-1)!.tiles[GRID1_ID] ?? [];
    const seen = new Set(tiles.map((t) => `${t.slot.col},${t.slot.row}`));
    expect(seen.size, "two windows sharing an origin means one is hidden").toBe(
      tiles.length,
    );
  });
});

describe("config survives the restart boundary", () => {
  it("reproduces the same layout in a brain built from the written config", () => {
    const before = harness();
    before.brain.setMonitors([monitor()]);
    before.brain.enableGrid(gridCfg({ cols: 3, rows: 3, gap: 8, padding: 8 }), [
      win("A"),
      win("B"),
      win("C"),
    ]);
    const rectsBefore = allMoves(before.applies).at(-3)!;

    // Quit: serialize. Boot: parse. This is the whole survival path.
    const onDisk = serializeConfig(before.brain.exportConfig());
    const restored = parseConfig(onDisk);
    expect(restored, "a config we just wrote must parse").not.toBeNull();

    const after = harness();
    const grid = restored!.grids.find((g) => g.id === GRID1_ID)!;
    after.brain.setMonitors([monitor()]);
    after.brain.enableGrid(grid, [win("A"), win("B"), win("C")]);

    expect(grid.cols).toBe(3);
    expect(grid.rows).toBe(3);
    expect(grid.gap).toBe(8);
    expect(grid.padding).toBe(8);
    expect(allMoves(after.applies).at(-3)).toEqual(rectsBefore);
    expect(destructive(after.applies)).toEqual([]);
  });

  it("a default config is loadable by a fresh brain", () => {
    const cfg = defaultConfig();
    const round = parseConfig(serializeConfig(cfg));
    expect(round).toEqual(cfg);
  });
});
