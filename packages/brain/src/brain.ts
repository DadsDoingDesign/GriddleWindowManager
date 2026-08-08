// WindowManagerBrain — pure TS layout brain (contract §C3). Zero Tauri/DOM
// imports; the host wires native events in and applies emitted layouts out.
//
// One @griddle/core Grid per enabled grid. Collision mode uses in-flow tiles
// (first-fit placement, addTileWithDisplacement fallback); non-resizable
// windows are always `absolute` tiles (position snaps, size is left alone).

import { Grid } from '@griddle/core';
import type { CellRect, Tile } from '@griddle/core';
import { cellRect, type GridDims, type Rect, snapRectToSlot } from './coords';
import type {
  AppConfig,
  ApplyLayout,
  FloatingWindow,
  GridSettings,
  Hwnd,
  MonitorInfo,
  Move,
  PreviewState,
  Slot,
  StateSnapshot,
  Template,
  TileSnapshot,
  WindowInfo,
} from './types';

export interface BrainCallbacks {
  onApply(layout: ApplyLayout): void;
  onPreview(p: PreviewState): void;
  onSnapshot(s: StateSnapshot): void;
}

interface ManagedGrid {
  settings: GridSettings;
  grid: Grid;
}

interface RememberedSlot {
  gridId: string;
  slot: Slot;
  absolute: boolean;
}

const DEFAULT_HOTKEY = 'Ctrl+Super+G';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function tileSlotOf(tile: Tile): Slot {
  if (tile.position === 'absolute' && tile.pinned) {
    return { col: tile.pinned.x, row: tile.pinned.y, w: tile.w, h: tile.h };
  }
  return { col: tile.col, row: tile.row, w: tile.w, h: tile.h };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export class WindowManagerBrain {
  private readonly cb: BrainCallbacks;

  private monitors = new Map<string, MonitorInfo>();
  /** Live Griddle instance per *enabled* grid. */
  private grids = new Map<string, ManagedGrid>();
  /** All known grid settings (enabled and disabled), for snapshot + export. */
  private gridSettings = new Map<string, GridSettings>();
  /** Last known info for every window the brain currently cares about. */
  private windows = new Map<Hwnd, WindowInfo>();
  /** hwnd -> gridId of the grid holding its tile. */
  private tileGrid = new Map<Hwnd, string>();
  /** hwnd -> gridId that could not fit it (window floats free). */
  private floating = new Map<Hwnd, string>();
  /** Slots remembered across minimize, for restore. */
  private remembered = new Map<Hwnd, RememberedSlot>();
  /** Last rect emitted per hwnd, so flush() only emits actual changes. */
  private appliedRects = new Map<Hwnd, Rect>();

  private templates: Template[];
  private exclusions: Set<string>;
  /** Layout snapshots for grids that are not live (from config / disable). */
  private storedLayouts: Record<string, unknown>;
  private hotkey: string;
  private autostart: boolean;
  private paused: boolean;

  constructor(cb: BrainCallbacks, cfg?: AppConfig) {
    this.cb = cb;
    this.templates = cfg ? [...cfg.templates] : [];
    this.exclusions = new Set(cfg?.exclusions ?? []);
    this.storedLayouts = { ...(cfg?.layouts ?? {}) };
    this.hotkey = cfg?.hotkey ?? DEFAULT_HOTKEY;
    this.autostart = cfg?.autostart ?? false;
    this.paused = cfg?.paused ?? false;
    for (const g of cfg?.grids ?? []) {
      this.gridSettings.set(g.id, { ...g });
    }
  }

  // ── native inputs ──────────────────────────────────────────────────────

  setMonitors(mons: MonitorInfo[]): void {
    this.monitors = new Map(mons.map((m) => [m.id, m]));
    this.emitSnapshot();
  }

  windowAppeared(w: WindowInfo): void {
    if (w.minimized) return;
    if (this.tileGrid.has(w.hwnd) || this.floating.has(w.hwnd)) return;
    if (this.exclusions.has(w.exe)) return;
    const mg = this.gridForMonitor(w.monitorId);
    if (!mg) return;
    this.windows.set(w.hwnd, { ...w });
    this.placeWindow(mg, w);
    this.flush();
    this.emitSnapshot();
  }

  windowDestroyed(hwnd: Hwnd): void {
    let changed = false;
    const gridId = this.tileGrid.get(hwnd);
    if (gridId !== undefined) {
      this.grids.get(gridId)?.grid.removeTile(hwnd);
      this.tileGrid.delete(hwnd);
      changed = true;
    }
    if (this.floating.delete(hwnd)) changed = true;
    if (this.remembered.delete(hwnd)) changed = true;
    if (this.windows.delete(hwnd)) changed = true;
    this.appliedRects.delete(hwnd);
    if (changed) {
      this.flush();
      this.emitSnapshot();
    }
  }

  windowMinimized(hwnd: Hwnd): void {
    const info = this.windows.get(hwnd);
    if (info) this.windows.set(hwnd, { ...info, minimized: true });

    const gridId = this.tileGrid.get(hwnd);
    if (gridId !== undefined) {
      const mg = this.grids.get(gridId);
      const tile = mg?.grid.getTile(hwnd);
      if (mg && tile) {
        this.remembered.set(hwnd, {
          gridId,
          slot: tileSlotOf(tile),
          absolute: tile.position === 'absolute',
        });
        mg.grid.removeTile(hwnd);
      }
      this.tileGrid.delete(hwnd);
      this.appliedRects.delete(hwnd);
      this.flush(); // no-op unless something else shifted; no auto-compact
      this.emitSnapshot();
      return;
    }
    if (this.floating.delete(hwnd)) {
      this.emitSnapshot();
    }
  }

  windowRestored(w: WindowInfo): void {
    if (this.tileGrid.has(w.hwnd)) return;
    if (this.exclusions.has(w.exe)) return;
    this.floating.delete(w.hwnd); // placement below is the retry

    const rem = this.remembered.get(w.hwnd);
    this.remembered.delete(w.hwnd);

    let mg = rem ? this.grids.get(rem.gridId) : undefined;
    mg ??= this.gridForMonitor(w.monitorId);
    if (!mg) return;

    const info = { ...w, minimized: false };
    this.windows.set(w.hwnd, info);

    let placed = false;
    if (rem && this.grids.get(rem.gridId) === mg) {
      if (rem.absolute) {
        mg.grid.addTile({
          id: w.hwnd,
          col: rem.slot.col,
          row: rem.slot.row,
          w: rem.slot.w,
          h: rem.slot.h,
          position: 'absolute',
          pinned: { x: rem.slot.col, y: rem.slot.row },
        });
        this.tileGrid.set(w.hwnd, mg.settings.id);
        placed = true;
      } else {
        const rect: CellRect = {
          col: rem.slot.col,
          row: rem.slot.row,
          w: rem.slot.w,
          h: rem.slot.h,
        };
        if (mg.grid.rectInBounds(rect) && mg.grid.tilesIn(rect).length === 0) {
          mg.grid.addTile({ id: w.hwnd, ...rect });
          this.tileGrid.set(w.hwnd, mg.settings.id);
          placed = true;
        }
      }
    }
    if (!placed) this.placeWindow(mg, info);
    this.flush();
    this.emitSnapshot();
  }

  // ── user/settings inputs ───────────────────────────────────────────────

  enableGrid(g: GridSettings, windows: WindowInfo[]): void {
    if (this.grids.has(g.id)) this.teardownGrid(g.id);
    const settings: GridSettings = { ...g, enabled: true };
    this.gridSettings.set(g.id, settings);

    const mon = this.monitorFor(settings);
    if (!mon) {
      // Monitor not currently present: keep the settings, activate on rescan.
      this.emitSnapshot();
      return;
    }

    const dims = this.dims(settings);
    const mg: ManagedGrid = {
      settings,
      grid: new Grid({
        cols: dims.cols,
        rows: dims.rows,
        unitWidth: mon.workWidth / dims.cols,
        unitHeight: mon.workHeight / dims.rows,
        gravity: 'none',
        enablePositioning: true,
        pinUnits: 'cells',
      }),
    };
    this.grids.set(g.id, mg);

    for (const w of windows) {
      if (!settings.monitorIds.includes(w.monitorId)) continue;
      if (w.minimized) continue;
      if (this.exclusions.has(w.exe)) continue;
      if (this.tileGrid.has(w.hwnd) || this.floating.has(w.hwnd)) continue;
      this.windows.set(w.hwnd, { ...w });
      this.placeWindow(mg, w);
    }
    this.flush();
    this.emitSnapshot();
  }

  disableGrid(gridId: string): void {
    this.teardownGrid(gridId);
    this.emitSnapshot();
  }

  exportConfig(): AppConfig {
    const layouts: Record<string, unknown> = { ...this.storedLayouts };
    for (const [id, mg] of this.grids) layouts[id] = mg.grid.toJSON();
    return {
      version: 1,
      grids: [...this.gridSettings.values()].map((g) => ({ ...g })),
      templates: [...this.templates],
      exclusions: [...this.exclusions],
      layouts,
      hotkey: this.hotkey,
      autostart: this.autostart,
      paused: this.paused,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private monitorFor(settings: GridSettings): MonitorInfo | undefined {
    const first = settings.monitorIds[0];
    return first === undefined ? undefined : this.monitors.get(first);
  }

  private dims(settings: GridSettings): GridDims {
    return { cols: settings.cols, rows: settings.rows };
  }

  private gridForMonitor(monitorId: string): ManagedGrid | undefined {
    for (const mg of this.grids.values()) {
      if (mg.settings.enabled && mg.settings.monitorIds.includes(monitorId)) {
        return mg;
      }
    }
    return undefined;
  }

  /**
   * Place a window into a grid: absolute for non-resizable windows, else
   * first-fit in reading order, else displacement at the snapped slot. When
   * even displacement fails (grid full) the window is marked floating.
   * Returns whether a tile was created.
   */
  private placeWindow(mg: ManagedGrid, w: WindowInfo): boolean {
    const mon = this.monitorFor(mg.settings);
    if (!mon) return false;
    const dims = this.dims(mg.settings);
    const snapped = snapRectToSlot(mon, dims, w);

    if (!w.resizable) {
      mg.grid.addTile({
        id: w.hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
        position: 'absolute',
        pinned: { x: snapped.col, y: snapped.row },
      });
      this.tileGrid.set(w.hwnd, mg.settings.id);
      return true;
    }

    for (let row = 0; row + snapped.h <= dims.rows; row++) {
      for (let col = 0; col + snapped.w <= dims.cols; col++) {
        const rect: CellRect = { col, row, w: snapped.w, h: snapped.h };
        if (mg.grid.tilesIn(rect).length === 0) {
          mg.grid.addTile({ id: w.hwnd, ...rect });
          this.tileGrid.set(w.hwnd, mg.settings.id);
          return true;
        }
      }
    }

    const ok = mg.grid.addTileWithDisplacement({
      id: w.hwnd,
      col: snapped.col,
      row: snapped.row,
      w: snapped.w,
      h: snapped.h,
    });
    if (ok) {
      this.tileGrid.set(w.hwnd, mg.settings.id);
      return true;
    }
    this.floating.set(w.hwnd, mg.settings.id);
    return false;
  }

  /** Drop a grid instance and everything tracked under it. No snapshot emit. */
  private teardownGrid(gridId: string): void {
    const settings = this.gridSettings.get(gridId);
    if (settings) this.gridSettings.set(gridId, { ...settings, enabled: false });
    const mg = this.grids.get(gridId);
    if (!mg) return;
    this.storedLayouts[gridId] = mg.grid.toJSON();
    for (const [hwnd, gid] of this.tileGrid) {
      if (gid === gridId) {
        this.tileGrid.delete(hwnd);
        this.appliedRects.delete(hwnd);
        this.windows.delete(hwnd);
      }
    }
    for (const [hwnd, gid] of this.floating) {
      if (gid === gridId) {
        this.floating.delete(hwnd);
        this.windows.delete(hwnd);
      }
    }
    for (const [hwnd, rem] of this.remembered) {
      if (rem.gridId === gridId) this.remembered.delete(hwnd);
    }
    this.grids.delete(gridId);
  }

  /** Target pixel rect for a tile. Absolute tiles keep the window's own size. */
  private desiredRect(mon: MonitorInfo, dims: GridDims, tile: Tile): Rect {
    const slot = tileSlotOf(tile);
    const cell = cellRect(mon, dims, slot);
    if (tile.position !== 'absolute') return cell;

    const info = this.windows.get(tile.id);
    if (!info) return cell;
    const width = Math.min(info.width, mon.workWidth);
    const height = Math.min(info.height, mon.workHeight);
    return {
      x: clamp(cell.x, mon.workX, mon.workX + mon.workWidth - width),
      y: clamp(cell.y, mon.workY, mon.workY + mon.workHeight - height),
      width,
      height,
    };
  }

  /** Emit one ApplyLayout containing every tile whose target rect changed. */
  private flush(): void {
    const moves: Move[] = [];
    for (const mg of this.grids.values()) {
      const mon = this.monitorFor(mg.settings);
      if (!mon) continue;
      const dims = this.dims(mg.settings);
      for (const tile of mg.grid.tiles) {
        const rect = this.desiredRect(mon, dims, tile);
        const prev = this.appliedRects.get(tile.id);
        if (!prev || !sameRect(prev, rect)) {
          this.appliedRects.set(tile.id, rect);
          moves.push({ hwnd: tile.id, ...rect });
        }
      }
    }
    if (moves.length > 0) this.cb.onApply({ moves });
  }

  private emitSnapshot(): void {
    const tiles: Record<string, TileSnapshot[]> = {};
    for (const [id, mg] of this.grids) {
      tiles[id] = mg.grid.tiles.map((t) => {
        const info = this.windows.get(t.id);
        return {
          hwnd: t.id,
          title: info?.title ?? '',
          exe: info?.exe ?? '',
          slot: tileSlotOf(t),
        };
      });
    }
    const floating: FloatingWindow[] = [...this.floating.keys()].map((hwnd) => {
      const info = this.windows.get(hwnd);
      return { hwnd, title: info?.title ?? '', exe: info?.exe ?? '' };
    });
    this.cb.onSnapshot({
      grids: [...this.gridSettings.values()].map((g) => ({ ...g })),
      templates: [...this.templates],
      tiles,
      floating,
      paused: this.paused,
    });
  }
}
