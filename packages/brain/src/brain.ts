// WindowManagerBrain — pure TS layout brain (contract §C3). Zero Tauri/DOM
// imports; the host wires native events in and applies emitted layouts out.
//
// One @griddle/core Grid per enabled grid. Collision mode uses in-flow tiles
// (first-fit placement, addTileWithDisplacement fallback); non-resizable
// windows are always `absolute` tiles (position snaps, size is left alone).

import { Grid } from '@griddle/core';
import type { CellRect, Tile } from '@griddle/core';
import {
  cellRect,
  type GridDims,
  type Rect,
  slotFromCursor,
  snapRectToSlot,
} from './coords';
import type {
  AppConfig,
  ApplyLayout,
  DragPos,
  FloatingWindow,
  GhostMove,
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

interface DragState {
  hwnd: Hwnd;
  /** Grid holding the tile when the drag started. */
  sourceGridId: string;
  startSlot: Slot;
  /** Window rect when the drag started, to tell moves from resizes. */
  startRect: Rect;
  absolute: boolean;
  /** Grid the currently visible preview was emitted for, if any. */
  previewGridId: string | null;
  lastFootprint: Slot | null;
  lastGhosts: GhostMove[];
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

function sameSlot(a: Slot, b: Slot): boolean {
  return a.col === b.col && a.row === b.row && a.w === b.w && a.h === b.h;
}

function sameGhosts(a: GhostMove[], b: GhostMove[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => {
    const o = b[i]!;
    return g.hwnd === o.hwnd && sameSlot(g.from, o.from) && sameSlot(g.to, o.to);
  });
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
  /** In-progress user drag (between moveSizeStart and moveSizeEnd). */
  private drag: DragState | null = null;

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
    this.cancelDrag(hwnd);
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
    this.cancelDrag(hwnd);
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

  // ── drag pipeline ──────────────────────────────────────────────────────

  moveSizeStart(hwnd: Hwnd): void {
    const gridId = this.tileGrid.get(hwnd);
    if (gridId === undefined) return;
    const mg = this.grids.get(gridId);
    const tile = mg?.grid.getTile(hwnd);
    if (!mg || !tile) return;

    const slot = tileSlotOf(tile);
    const info = this.windows.get(hwnd);
    const mon = this.monitorFor(mg.settings);
    const startRect: Rect =
      this.appliedRects.get(hwnd) ??
      (info
        ? { x: info.x, y: info.y, width: info.width, height: info.height }
        : mon
          ? cellRect(mon, this.dims(mg.settings), slot)
          : { x: 0, y: 0, width: 0, height: 0 });

    this.drag = {
      hwnd,
      sourceGridId: gridId,
      startSlot: slot,
      startRect,
      absolute: tile.position === 'absolute',
      previewGridId: gridId,
      lastFootprint: slot,
      lastGhosts: [],
    };
    this.cb.onPreview({ gridId, visible: true, footprint: slot, ghosts: [] });
  }

  dragMoved(p: DragPos): void {
    const d = this.drag;
    if (!d || d.hwnd !== p.hwnd) return;

    const target = this.gridAtPoint(p.cursorX, p.cursorY);
    if (!target) {
      // Cursor over an ungridded area: nothing to preview.
      this.hidePreview(d);
      return;
    }
    const { mg, mon } = target;
    const dims = this.dims(mg.settings);
    const rect: Rect = { x: p.x, y: p.y, width: p.width, height: p.height };
    const resizing =
      !d.absolute &&
      (p.width !== d.startRect.width || p.height !== d.startRect.height);

    let footprint: Slot;
    if (resizing) {
      footprint = snapRectToSlot(mon, dims, rect);
    } else {
      const size =
        mg.settings.id === d.sourceGridId
          ? { w: d.startSlot.w, h: d.startSlot.h }
          : snapRectToSlot(mon, dims, rect); // footprint in the target grid's cells
      footprint = slotFromCursor(mon, dims, p.cursorX, p.cursorY, size);
    }

    const ghosts = d.absolute ? [] : this.simulateGhosts(mg, d, footprint, resizing);

    const unchanged =
      d.previewGridId === mg.settings.id &&
      d.lastFootprint !== null &&
      sameSlot(d.lastFootprint, footprint) &&
      sameGhosts(d.lastGhosts, ghosts);
    if (unchanged) return;

    if (d.previewGridId !== null && d.previewGridId !== mg.settings.id) {
      this.cb.onPreview({
        gridId: d.previewGridId,
        visible: false,
        footprint: null,
        ghosts: [],
      });
    }
    d.previewGridId = mg.settings.id;
    d.lastFootprint = footprint;
    d.lastGhosts = ghosts;
    this.cb.onPreview({ gridId: mg.settings.id, visible: true, footprint, ghosts });
  }

  moveSizeEnd(
    hwnd: Hwnd,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const d = this.drag;
    if (!d || d.hwnd !== hwnd) return;
    this.drag = null;
    this.hidePreview(d);

    const source = this.grids.get(d.sourceGridId);
    if (!source || !source.grid.getTile(hwnd)) return; // grid vanished mid-drag

    const targetMon =
      this.monitorAt(rect.x + rect.width / 2, rect.y + rect.height / 2) ??
      this.monitorFor(source.settings);
    if (!targetMon) return;

    const info = this.windows.get(hwnd);
    if (info) {
      this.windows.set(hwnd, {
        ...info,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        monitorId: targetMon.id,
      });
    }

    const target = this.gridForMonitor(targetMon.id);
    if (!target) {
      // Dropped on an ungridded monitor: the window becomes unmanaged and
      // stays exactly where the user left it — no move emitted.
      source.grid.removeTile(hwnd);
      this.tileGrid.delete(hwnd);
      this.windows.delete(hwnd);
      this.remembered.delete(hwnd);
      this.appliedRects.delete(hwnd);
      this.flush();
      this.emitSnapshot();
      return;
    }

    const mon = this.monitorFor(target.settings);
    if (!mon) return;
    const snapped = snapRectToSlot(mon, this.dims(target.settings), rect);

    if (target === source) {
      this.commitSameGrid(source, d, snapped);
    } else {
      this.commitTransfer(source, target, d, snapped);
    }
    // Always re-emit the dragged window: even an unchanged slot must snap the
    // physically-moved window back onto its cell.
    this.appliedRects.delete(hwnd);
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

  private monitorAt(x: number, y: number): MonitorInfo | undefined {
    for (const m of this.monitors.values()) {
      if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
        return m;
      }
    }
    return undefined;
  }

  private gridAtPoint(
    x: number,
    y: number,
  ): { mg: ManagedGrid; mon: MonitorInfo } | undefined {
    const hit = this.monitorAt(x, y);
    if (!hit) return undefined;
    const mg = this.gridForMonitor(hit.id);
    if (!mg) return undefined;
    const mon = this.monitorFor(mg.settings);
    if (!mon) return undefined;
    return { mg, mon };
  }

  /** Emit a hide for the grid whose preview is currently visible, if any. */
  private hidePreview(d: DragState): void {
    if (d.previewGridId === null) return;
    this.cb.onPreview({
      gridId: d.previewGridId,
      visible: false,
      footprint: null,
      ghosts: [],
    });
    d.previewGridId = null;
    d.lastFootprint = null;
    d.lastGhosts = [];
  }

  /** Abort an in-progress drag (window destroyed/minimized, grid torn down). */
  private cancelDrag(hwnd?: Hwnd): void {
    const d = this.drag;
    if (!d) return;
    if (hwnd !== undefined && d.hwnd !== hwnd) return;
    this.drag = null;
    this.hidePreview(d);
  }

  /**
   * Ghost preview: run the would-be commit on a clone (toJSON → fromJSON) and
   * diff every other in-flow tile's slot. The live grid is never mutated.
   */
  private simulateGhosts(
    target: ManagedGrid,
    d: DragState,
    footprint: Slot,
    resizing: boolean,
  ): GhostMove[] {
    const clone = Grid.fromJSON(target.grid.toJSON());
    const before = new Map<string, Slot>();
    for (const t of clone.tiles) {
      if (t.id === d.hwnd) continue;
      if (t.position === 'absolute' || t.position === 'fixed') continue;
      before.set(t.id, tileSlotOf(t));
    }
    const sameGrid = target.settings.id === d.sourceGridId;
    if (sameGrid && !resizing) {
      clone.moveTile(d.hwnd, { col: footprint.col, row: footprint.row });
    } else {
      if (sameGrid) clone.removeTile(d.hwnd);
      clone.addTileWithDisplacement({
        id: d.hwnd,
        col: footprint.col,
        row: footprint.row,
        w: footprint.w,
        h: footprint.h,
      });
    }
    const ghosts: GhostMove[] = [];
    for (const t of clone.tiles) {
      const prev = before.get(t.id);
      if (!prev) continue;
      const now = tileSlotOf(t);
      if (!sameSlot(prev, now)) ghosts.push({ hwnd: t.id, from: prev, to: now });
    }
    return ghosts;
  }

  /** Commit a drop that stays on the same grid: move, resize, or pin update. */
  private commitSameGrid(mg: ManagedGrid, d: DragState, snapped: Slot): void {
    const hwnd = d.hwnd;
    const tile = mg.grid.getTile(hwnd);
    if (!tile) return;

    if (tile.position === 'absolute') {
      mg.grid.setTilePinned(hwnd, { x: snapped.col, y: snapped.row });
      return;
    }

    const cur = tileSlotOf(tile);
    const sizeChanged = snapped.w !== cur.w || snapped.h !== cur.h;
    if (!sizeChanged) {
      // moveTile returning false leaves the grid unchanged → flush snaps the
      // window back to its original cell.
      mg.grid.moveTile(hwnd, { col: snapped.col, row: snapped.row });
      return;
    }
    if (snapped.col === cur.col && snapped.row === cur.row) {
      if (mg.grid.resizeTile(hwnd, { w: snapped.w, h: snapped.h })) return;
    }
    // Origin+size changed (or in-place resize failed): re-add with displacement.
    mg.grid.removeTile(hwnd);
    const ok = mg.grid.addTileWithDisplacement({
      id: hwnd,
      col: snapped.col,
      row: snapped.row,
      w: snapped.w,
      h: snapped.h,
    });
    if (!ok) {
      mg.grid.addTile({ id: hwnd, col: cur.col, row: cur.row, w: cur.w, h: cur.h });
    }
  }

  /** Commit a drop onto a different gridded monitor: transfer the tile. */
  private commitTransfer(
    source: ManagedGrid,
    target: ManagedGrid,
    d: DragState,
    snapped: Slot,
  ): void {
    const hwnd = d.hwnd;
    source.grid.removeTile(hwnd);
    this.tileGrid.delete(hwnd);
    const info = this.windows.get(hwnd);

    if (d.absolute || (info && !info.resizable)) {
      target.grid.addTile({
        id: hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
        position: 'absolute',
        pinned: { x: snapped.col, y: snapped.row },
      });
      this.tileGrid.set(hwnd, target.settings.id);
      return;
    }
    const ok = target.grid.addTileWithDisplacement({
      id: hwnd,
      col: snapped.col,
      row: snapped.row,
      w: snapped.w,
      h: snapped.h,
    });
    if (ok) {
      this.tileGrid.set(hwnd, target.settings.id);
      return;
    }
    // Drop slot unusable: fall back to first-fit / displacement / floating.
    if (info) this.placeWindow(target, info);
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
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();
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
