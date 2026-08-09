// WindowManagerBrain — pure TS layout brain (contract §C3). Zero Tauri/DOM
// imports; the host wires native events in and applies emitted layouts out.
//
// One @griddle/core Grid per enabled grid. Collision mode uses in-flow tiles
// (first-fit placement, addTileWithDisplacement fallback); non-resizable
// windows are always `absolute` tiles (position snaps, size is left alone).
// Overlay mode stores every tile as a Griddle `absolute` tile (pinUnits:
// 'cells'): tiles may overlap, nothing displaces, and a brain-wide recency
// counter orders overlay snapshots bottom-to-top (top-most last).

import { Grid } from '@griddle/core';
import type { CellRect, Tile } from '@griddle/core';
import {
  cellRect,
  type GridDims,
  type Rect,
  slotFromCursor,
  snapRectToSlot,
} from './coords';
import { extractLayoutTiles } from './persist';
import {
  computeUnusableCells,
  nearestUsableSlot,
  slotUsable as slotUsableWithin,
  unionWorkArea,
} from './spanning';
import { makeUserTemplate, mergeWithBuiltins } from './templates';
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
  /**
   * Dead-space cells of a spanning grid (flat row * cols + col indexes):
   * cells of the union work area covered by no member monitor (spec §5.7).
   * Always empty for single-monitor grids.
   */
  unusable: Set<number>;
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

/** Shrink/shift a slot so it lies fully inside a cols×rows grid. */
function clampSlot(s: Slot, cols: number, rows: number): Slot {
  const w = clamp(s.w, 1, cols);
  const h = clamp(s.h, 1, rows);
  return {
    col: clamp(s.col, 0, cols - w),
    row: clamp(s.row, 0, rows - h),
    w,
    h,
  };
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
  /** Monotonic interaction order; higher = more recent (top-most in overlay). */
  private recency = new Map<Hwnd, number>();
  private recencyCounter = 0;
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
    this.templates = mergeWithBuiltins(cfg?.templates ?? []);
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
    // Monitor geometry defines a spanning grid's dead space — recompute it.
    for (const mg of this.grids.values()) {
      if (mg.settings.monitorIds.length <= 1) continue;
      const mon = this.monitorFor(mg.settings);
      if (mon) mg.unusable = this.unusableFor(mg.settings, mon);
    }
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
    this.recency.delete(hwnd);
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
        // Grid dims may have changed (reflow/template) while minimized —
        // only reuse the remembered slot if it still fits the grid.
        const rect: CellRect = {
          col: rem.slot.col,
          row: rem.slot.row,
          w: rem.slot.w,
          h: rem.slot.h,
        };
        if (mg.grid.rectInBounds(rect) && this.usable(mg, rem.slot)) {
          mg.grid.addTile({
            id: w.hwnd,
            ...rect,
            position: 'absolute',
            pinned: { x: rect.col, y: rect.row },
          });
          this.tileGrid.set(w.hwnd, mg.settings.id);
          this.touch(w.hwnd);
          placed = true;
        }
      } else {
        const rect: CellRect = {
          col: rem.slot.col,
          row: rem.slot.row,
          w: rem.slot.w,
          h: rem.slot.h,
        };
        if (
          mg.grid.rectInBounds(rect) &&
          this.usable(mg, rem.slot) &&
          mg.grid.tilesIn(rect).length === 0
        ) {
          mg.grid.addTile({ id: w.hwnd, ...rect });
          this.tileGrid.set(w.hwnd, mg.settings.id);
          this.touch(w.hwnd);
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
    // Non-resizable windows never report a size change, so this is safe for
    // absolute tiles too (overlay-mode resizes must re-snap the footprint).
    const resizing =
      p.width !== d.startRect.width || p.height !== d.startRect.height;

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
    // Preview snaps to usable slots exactly like the commit will (spec §5.7).
    const adjusted = this.nearestUsable(mg, footprint);
    if (!adjusted) {
      this.hidePreview(d);
      return;
    }
    footprint = adjusted;

    // Overlay-mode targets never reflow neighbors; absolute tiles displace
    // nothing either way — both preview with no ghosts.
    const ghosts =
      d.absolute || mg.settings.mode === 'overlay'
        ? []
        : this.simulateGhosts(mg, d, footprint, resizing);

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

    const hitMon = this.monitorAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    // A drop whose center lies on no monitor — half off-screen, or in the
    // dead space of an L-shaped spanning grid — stays with the source grid
    // and snaps to its nearest usable slot below.
    const target = hitMon ? this.gridForMonitor(hitMon.id) : source;

    const info = this.windows.get(hwnd);
    if (info) {
      this.windows.set(hwnd, {
        ...info,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        monitorId: hitMon?.id ?? info.monitorId,
      });
    }

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
    // Drops in the dead space of a spanning grid snap to the nearest usable
    // slot (spec §5.7). A grid with zero usable cells cannot take the drop:
    // the tile stays put and the window snaps back to its old cell.
    const snapped = this.nearestUsable(
      target,
      snapRectToSlot(mon, this.dims(target.settings), rect),
    );
    if (!snapped) {
      this.appliedRects.delete(hwnd);
      this.flush();
      this.emitSnapshot();
      return;
    }

    if (target === source) {
      this.commitSameGrid(source, d.hwnd, snapped);
    } else {
      this.commitTransfer(source, target, d, snapped);
    }
    this.touch(hwnd); // the just-dragged window is now the top-most
    // Always re-emit the dragged window: even an unchanged slot must snap the
    // physically-moved window back onto its cell.
    this.appliedRects.delete(hwnd);
    this.flush();
    this.emitSnapshot();
  }

  // ── user/settings inputs ───────────────────────────────────────────────

  enableGrid(g: GridSettings, windows: WindowInfo[]): void {
    if (this.grids.has(g.id)) this.teardownGrid(g.id);
    const settings: GridSettings = { ...g, enabled: true, monitorIds: [...g.monitorIds] };
    this.gridSettings.set(g.id, settings);

    // One live grid per monitor: enabling a grid (spanning or per-monitor)
    // tears down any other live grid sharing one of its monitors — a
    // spanning grid replaces the per-monitor grids it covers and vice versa
    // (plan Task 17).
    for (const id of [...this.grids.keys()]) {
      const other = this.grids.get(id);
      if (!other) continue;
      if (other.settings.monitorIds.some((m) => settings.monitorIds.includes(m))) {
        this.teardownGrid(id);
      }
    }

    const mon = this.monitorFor(settings);
    if (!mon) {
      // Monitor not currently present: keep the settings, activate on rescan.
      this.emitSnapshot();
      return;
    }

    const mg: ManagedGrid = {
      settings,
      grid: this.newGrid(settings, mon),
      unusable: this.unusableFor(settings, mon),
    };
    this.grids.set(g.id, mg);

    // Rehydrate slots from the stored layout snapshot (config round-trip or
    // re-enable) for windows that are still present; corrupt/missing
    // snapshot → grid starts empty and everything places fresh below.
    this.restoreLayout(mg, windows);

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

  setMode(gridId: string, mode: 'collision' | 'overlay'): void {
    const settings = this.gridSettings.get(gridId);
    if (!settings || settings.mode === mode) return;
    const updated: GridSettings = { ...settings, mode };
    this.gridSettings.set(gridId, updated);

    const mg = this.grids.get(gridId);
    if (!mg) {
      this.emitSnapshot();
      return;
    }
    mg.settings = updated;
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();

    if (mode === 'overlay') {
      // Convert in place: every in-flow tile becomes absolute at its own
      // slot. Geometry is unchanged, so no moves are emitted.
      for (const tile of [...mg.grid.tiles]) {
        if (tile.position === 'absolute') continue;
        mg.grid.setTilePosition(tile.id, 'absolute', {
          pinned: { x: tile.col, y: tile.row },
        });
      }
    } else {
      this.convertToCollision(mg);
    }
    this.flush();
    this.emitSnapshot();
  }

  /**
   * Change a grid's dimensions (settings steppers, contract §C3). Every tile
   * is re-placed at its old slot clamped into the new bounds — most recent
   * first, so it wins contested cells — falling back to first-fit /
   * displacement / floating. This grid's floating windows get a retry (a
   * bigger grid may now fit them), and everything lands in one apply.
   */
  reflowGrid(gridId: string, cols: number, rows: number): void {
    const settings = this.gridSettings.get(gridId);
    if (!settings) return;
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (settings.cols === cols && settings.rows === rows) return;
    const updated: GridSettings = {
      ...settings,
      cols,
      rows,
      activeTemplateId: null,
    };
    this.gridSettings.set(gridId, updated);

    const mg = this.grids.get(gridId);
    if (!mg) {
      this.emitSnapshot();
      return;
    }
    mg.settings = updated;
    const mon = this.monitorFor(updated);
    if (!mon) {
      this.emitSnapshot();
      return;
    }
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();

    const byRecency = (a: Hwnd, b: Hwnd) => this.recencyOf(b) - this.recencyOf(a);
    const entries = mg.grid.tiles
      .map((t) => ({ id: t.id, slot: tileSlotOf(t) }))
      .sort((a, b) => byRecency(a.id, b.id));
    const floaters = [...this.floating.entries()]
      .filter(([, gid]) => gid === gridId)
      .map(([hwnd]) => hwnd)
      .sort(byRecency);
    for (const e of entries) this.tileGrid.delete(e.id);
    for (const hwnd of floaters) this.floating.delete(hwnd);

    mg.grid = this.newGrid(updated, mon);
    mg.unusable = this.unusableFor(updated, mon);

    const overlay = updated.mode === 'overlay';
    for (const e of entries) {
      const info = this.windows.get(e.id);
      const slot = clampSlot(e.slot, cols, rows);
      if (this.addAtSlot(mg, e.id, slot, overlay, info)) continue;
      if (info) {
        this.placeWindow(mg, info);
      } else {
        this.floating.set(e.id, gridId);
      }
    }
    for (const hwnd of floaters) {
      const info = this.windows.get(hwnd);
      if (info) {
        this.placeWindow(mg, info);
      } else {
        this.floating.set(hwnd, gridId);
      }
    }
    this.flush();
    this.emitSnapshot();
  }

  /**
   * Snapshot a live grid's layout as a user template (spec §5.5): cols/rows
   * plus every tile's slot in reading order — no window identities.
   */
  captureTemplate(gridId: string, name: string): Template {
    const mg = this.grids.get(gridId);
    if (!mg) {
      throw new Error(`captureTemplate: unknown or disabled grid "${gridId}"`);
    }
    const dims = this.dims(mg.settings);
    const slots = mg.grid.tiles.map((t) => tileSlotOf(t));
    const tpl = makeUserTemplate(name, dims.cols, dims.rows, slots, this.templates);
    this.templates.push(tpl);
    this.emitSnapshot();
    return { ...tpl, slots: tpl.slots.map((s) => ({ ...s })) };
  }

  /**
   * Remove a user template (contract §C3 extension, plan Task 16). Builtins
   * and unknown ids are refused (returns false, no snapshot). Grids whose
   * `activeTemplateId` referenced the deleted template drop the reference;
   * their layout is left exactly as it is — deleting a template never moves
   * windows.
   */
  deleteTemplate(templateId: string): boolean {
    const idx = this.templates.findIndex((t) => t.id === templateId);
    if (idx === -1 || this.templates[idx]!.builtin) return false;
    this.templates.splice(idx, 1);
    for (const [id, settings] of this.gridSettings) {
      if (settings.activeTemplateId !== templateId) continue;
      const updated: GridSettings = { ...settings, activeTemplateId: null };
      this.gridSettings.set(id, updated);
      const mg = this.grids.get(id);
      if (mg) mg.settings = updated;
    }
    this.emitSnapshot();
    return true;
  }

  /**
   * Lay a grid out per a template (spec §5.5): windows map to slots in
   * recency order (most recent → first slot), extras auto-place, floating
   * windows get retried, mode is unchanged, and everything lands in one
   * apply. A template with different cols/rows re-dims the grid first.
   *
   * Note: the plan called for Griddle `reflow` here, but `Grid.reflow` only
   * accepts a column count (no rows) — and every tile is re-placed at a
   * template slot anyway, so the grid is rebuilt at the template's dims
   * instead (see docs/library-feedback.md).
   */
  applyTemplate(gridId: string, templateId: string): void {
    const mg = this.grids.get(gridId);
    const tpl = this.templates.find((t) => t.id === templateId);
    if (!mg || !tpl) return;
    const mon = this.monitorFor(mg.settings);
    if (!mon) return;
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();

    const settings: GridSettings = {
      ...mg.settings,
      cols: tpl.cols,
      rows: tpl.rows,
      activeTemplateId: tpl.id,
    };
    mg.settings = settings;
    this.gridSettings.set(gridId, settings);

    // Assignment order: tiled windows by recency (most recent first), then
    // this grid's floating windows — the template may open room for them.
    const byRecency = (a: Hwnd, b: Hwnd) => this.recencyOf(b) - this.recencyOf(a);
    const tiled = mg.grid.tiles.map((t) => t.id).sort(byRecency);
    const floaters = [...this.floating.entries()]
      .filter(([, gid]) => gid === gridId)
      .map(([hwnd]) => hwnd)
      .sort(byRecency);
    const order = [...tiled, ...floaters];
    for (const hwnd of order) {
      this.tileGrid.delete(hwnd);
      this.floating.delete(hwnd);
    }

    mg.grid = this.newGrid(settings, mon);
    mg.unusable = this.unusableFor(settings, mon);

    const overlay = settings.mode === 'overlay';
    order.forEach((hwnd, i) => {
      const info = this.windows.get(hwnd);
      const slot = i < tpl.slots.length ? tpl.slots[i] : undefined;
      if (slot && this.addAtSlot(mg, hwnd, slot, overlay, info)) return;
      // Extra window beyond the template's slots (or an unusable slot):
      // auto-place with the usual first-fit/displacement/floating rules.
      if (info) {
        this.placeWindow(mg, info);
      } else {
        this.floating.set(hwnd, gridId);
      }
    });
    this.flush();
    this.emitSnapshot();
  }

  /**
   * Editor input (contract §C3, plan Task 13): place an existing tile at an
   * exact slot — settings-editor drops route here via the `settings-move`
   * event. The slot is sanitized and clamped into the grid, then the same
   * commit rules as a native drop apply (move / resize / displacement / pin
   * update) and the real window lands in one apply. An in-flight native drag
   * of the same window is cancelled — the editor's drop wins.
   */
  moveTileFromEditor(gridId: string, hwnd: Hwnd, slot: Slot): void {
    const mg = this.grids.get(gridId);
    if (!mg || !mg.grid.getTile(hwnd)) return;
    const parts = [slot.col, slot.row, slot.w, slot.h];
    if (!parts.every((n) => Number.isFinite(n))) return;
    if (this.drag?.hwnd === hwnd) this.cancelDrag(hwnd);

    const dims = this.dims(mg.settings);
    const snapped = this.nearestUsable(
      mg,
      clampSlot(
        {
          col: Math.round(slot.col),
          row: Math.round(slot.row),
          w: Math.round(slot.w),
          h: Math.round(slot.h),
        },
        dims.cols,
        dims.rows,
      ),
    );
    if (!snapped) return; // spanning grid with zero usable cells
    this.commitSameGrid(mg, hwnd, snapped);
    this.touch(hwnd); // now the most recent (top-most in overlay stacking)
    this.flush();
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

  /**
   * Contract extension (Task 18): shell preferences. `paused` mirrors Rust's
   * authoritative pause flag (the host feeds `paused-changed` events here so
   * the state persists and the settings UI updates via the snapshot);
   * `autostart` and `hotkey` are the settings-window General toggles, which
   * Rust reads back out of the persisted config (autostart registration,
   * hotkey re-bind). Only actual changes re-emit a snapshot; an empty hotkey
   * is ignored (the accelerator must stay non-empty per contract C1).
   */
  setShellPrefs(prefs: { paused?: boolean; autostart?: boolean; hotkey?: string }): void {
    let changed = false;
    if (prefs.paused !== undefined && prefs.paused !== this.paused) {
      this.paused = prefs.paused;
      changed = true;
    }
    if (prefs.autostart !== undefined && prefs.autostart !== this.autostart) {
      this.autostart = prefs.autostart;
      changed = true;
    }
    if (
      prefs.hotkey !== undefined &&
      prefs.hotkey.length > 0 &&
      prefs.hotkey !== this.hotkey
    ) {
      this.hotkey = prefs.hotkey;
      changed = true;
    }
    if (changed) this.emitSnapshot();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Mark `hwnd` as the most recently interacted-with window. */
  private touch(hwnd: Hwnd): void {
    this.recency.set(hwnd, ++this.recencyCounter);
  }

  private recencyOf(hwnd: Hwnd): number {
    return this.recency.get(hwnd) ?? 0;
  }

  /**
   * Overlay → collision: re-add every resizable tile in recency order, most
   * recent first so it claims its slot outright (keeps it preferentially).
   * Older tiles keep their slot if still free, else first-fit, else
   * displacement as a last resort; tiles that no longer fit become floating.
   * Non-resizable windows stay absolute (spec: always absolute).
   */
  private convertToCollision(mg: ManagedGrid): void {
    const gridId = mg.settings.id;
    const dims = this.dims(mg.settings);
    const converts = mg.grid.tiles
      .filter((t) => this.windows.get(t.id)?.resizable ?? true)
      .sort((a, b) => this.recencyOf(b.id) - this.recencyOf(a.id));
    for (const t of converts) mg.grid.removeTile(t.id);
    for (const t of converts) {
      const slot = tileSlotOf(t); // pinned coords for absolute tiles
      const rect: CellRect = { col: slot.col, row: slot.row, w: slot.w, h: slot.h };
      if (
        mg.grid.rectInBounds(rect) &&
        this.usable(mg, slot) &&
        mg.grid.tilesIn(rect).length === 0
      ) {
        mg.grid.addTile({ id: t.id, ...rect });
        continue;
      }
      let placed = false;
      for (let row = 0; row + slot.h <= dims.rows && !placed; row++) {
        for (let col = 0; col + slot.w <= dims.cols && !placed; col++) {
          const cand: CellRect = { col, row, w: slot.w, h: slot.h };
          if (!this.usable(mg, cand)) continue;
          if (mg.grid.tilesIn(cand).length === 0) {
            mg.grid.addTile({ id: t.id, ...cand });
            placed = true;
          }
        }
      }
      if (placed) continue;
      if (this.runEngineOp(mg, (g) => g.addTileWithDisplacement({ id: t.id, ...rect }))) {
        continue;
      }
      this.tileGrid.delete(t.id);
      this.floating.set(t.id, gridId);
      this.appliedRects.delete(t.id);
    }
  }

  /**
   * Add a window's tile at an exact slot (template apply). Overlay grids and
   * non-resizable windows get an absolute pinned tile (never collides);
   * in-flow tiles take the slot outright when free, else displace. Returns
   * whether the tile was created.
   */
  private addAtSlot(
    mg: ManagedGrid,
    hwnd: Hwnd,
    slot: Slot,
    overlay: boolean,
    info: WindowInfo | undefined,
  ): boolean {
    // Dead-space slots are never assigned (spec §5.7); the caller falls back
    // to normal placement, which snaps to the nearest usable slot.
    if (!this.usable(mg, slot)) return false;
    if (overlay || !(info?.resizable ?? true)) {
      mg.grid.addTile({
        id: hwnd,
        col: slot.col,
        row: slot.row,
        w: slot.w,
        h: slot.h,
        position: 'absolute',
        pinned: { x: slot.col, y: slot.row },
      });
      this.tileGrid.set(hwnd, mg.settings.id);
      return true;
    }
    const rect: CellRect = { col: slot.col, row: slot.row, w: slot.w, h: slot.h };
    if (mg.grid.rectInBounds(rect) && mg.grid.tilesIn(rect).length === 0) {
      mg.grid.addTile({ id: hwnd, ...rect });
      this.tileGrid.set(hwnd, mg.settings.id);
      return true;
    }
    if (this.runEngineOp(mg, (g) => g.addTileWithDisplacement({ id: hwnd, ...rect }))) {
      this.tileGrid.set(hwnd, mg.settings.id);
      return true;
    }
    return false;
  }

  /**
   * The monitor a grid lays out against. For a spanning grid this is a
   * synthetic union monitor (bounding box of the members' work areas,
   * spec §5.7); it requires every member to be present — a spanning grid
   * with an unplugged member is inert until the monitor returns.
   */
  private monitorFor(settings: GridSettings): MonitorInfo | undefined {
    if (settings.monitorIds.length === 1) {
      return this.monitors.get(settings.monitorIds[0]!);
    }
    const parts: MonitorInfo[] = [];
    for (const id of settings.monitorIds) {
      const m = this.monitors.get(id);
      if (!m) return undefined;
      parts.push(m);
    }
    return parts.length > 0 ? unionWorkArea(parts) : undefined;
  }

  /** Fresh Griddle instance for a grid's current dims over `mon`'s work area. */
  private newGrid(settings: GridSettings, mon: MonitorInfo): Grid {
    return new Grid({
      cols: settings.cols,
      rows: settings.rows,
      unitWidth: mon.workWidth / settings.cols,
      unitHeight: mon.workHeight / settings.rows,
      gravity: 'none',
      enablePositioning: true,
      pinUnits: 'cells',
    });
  }

  /** Dead-space cell set for a grid (empty for single-monitor grids). */
  private unusableFor(settings: GridSettings, mon: MonitorInfo): Set<number> {
    if (settings.monitorIds.length <= 1) return new Set();
    const parts: MonitorInfo[] = [];
    for (const id of settings.monitorIds) {
      const m = this.monitors.get(id);
      if (m) parts.push(m);
    }
    return computeUnusableCells(mon, this.dims(settings), parts);
  }

  /** Whether `slot` is in bounds and touches no dead-space cell. */
  private usable(mg: ManagedGrid, slot: Slot): boolean {
    return slotUsableWithin(this.dims(mg.settings), mg.unusable, slot);
  }

  /**
   * Snap a slot to the nearest fully usable position (spec §5.7). On
   * single-monitor grids this is just an in-bounds clamp. Returns null only
   * when the grid has no usable cell at all.
   */
  private nearestUsable(mg: ManagedGrid, slot: Slot): Slot | null {
    const dims = this.dims(mg.settings);
    if (mg.unusable.size === 0) return clampSlot(slot, dims.cols, dims.rows);
    return nearestUsableSlot(dims, mg.unusable, slot);
  }

  /**
   * Run a Griddle rules-engine op (moveTile / resizeTile /
   * addTileWithDisplacement) that may displace neighbors. On spanning grids
   * the engine knows nothing about dead-space cells, so the op runs on a
   * clone first and only commits when no in-flow tile ends up covering a
   * dead cell; a rejected op leaves the grid unchanged and returns false,
   * exactly like the engine's own failure mode.
   */
  private runEngineOp(mg: ManagedGrid, op: (g: Grid) => boolean): boolean {
    if (mg.unusable.size === 0) return op(mg.grid);
    const clone = Grid.fromJSON(mg.grid.toJSON());
    if (!op(clone)) return false;
    if (!this.inFlowAvoidsDead(clone, mg)) return false;
    return op(mg.grid);
  }

  /** Whether every in-flow tile of `grid` stays clear of dead-space cells. */
  private inFlowAvoidsDead(grid: Grid, mg: ManagedGrid): boolean {
    for (const t of grid.tiles) {
      if (t.position === 'absolute' || t.position === 'fixed') continue;
      if (!this.usable(mg, { col: t.col, row: t.row, w: t.w, h: t.h })) return false;
    }
    return true;
  }

  /**
   * Public dead-space check (contract §C3 extension, Task 17): whether a
   * slot of `gridId` is fully usable — placement, snapping, and previews all
   * route through the same test. Unknown/disabled grids report false.
   */
  slotUsable(gridId: string, slot: Slot): boolean {
    const mg = this.grids.get(gridId);
    return mg !== undefined && this.usable(mg, slot);
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
    // A displacement that would shove a neighbor into a spanning grid's dead
    // space gets rejected at commit time (runEngineOp), so preview no ghosts.
    if (target.unusable.size > 0 && !this.inFlowAvoidsDead(clone, target)) return [];
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
  private commitSameGrid(mg: ManagedGrid, hwnd: Hwnd, snapped: Slot): void {
    const tile = mg.grid.getTile(hwnd);
    if (!tile) return;

    if (tile.position === 'absolute') {
      const info = this.windows.get(hwnd);
      if ((info?.resizable ?? true) && (snapped.w !== tile.w || snapped.h !== tile.h)) {
        // Overlay-mode resize: footprint snaps to cells too. Absolute tiles
        // never collide, so remove + re-add is side-effect free.
        mg.grid.removeTile(hwnd);
        mg.grid.addTile({
          id: hwnd,
          col: snapped.col,
          row: snapped.row,
          w: snapped.w,
          h: snapped.h,
          position: 'absolute',
          pinned: { x: snapped.col, y: snapped.row },
        });
      } else {
        // The tile's footprint may be larger than the snapped one (e.g. a
        // template assigned a non-resizable window a big slot); clamp the pin
        // so the tile itself stays inside the grid, preferring a usable slot
        // on spanning grids.
        const dims = this.dims(mg.settings);
        const pin0 = clampSlot(
          { col: snapped.col, row: snapped.row, w: tile.w, h: tile.h },
          dims.cols,
          dims.rows,
        );
        const pin = this.nearestUsable(mg, pin0) ?? pin0;
        mg.grid.setTilePinned(hwnd, { x: pin.col, y: pin.row });
      }
      return;
    }

    const cur = tileSlotOf(tile);
    const sizeChanged = snapped.w !== cur.w || snapped.h !== cur.h;
    if (!sizeChanged) {
      // moveTile returning false leaves the grid unchanged → flush snaps the
      // window back to its original cell. On spanning grids the op is also
      // rejected when displacement would push a neighbor into dead space.
      this.runEngineOp(mg, (g) => g.moveTile(hwnd, { col: snapped.col, row: snapped.row }));
      return;
    }
    if (snapped.col === cur.col && snapped.row === cur.row) {
      if (this.runEngineOp(mg, (g) => g.resizeTile(hwnd, { w: snapped.w, h: snapped.h }))) {
        return;
      }
    }
    // Origin+size changed (or in-place resize failed): re-add with displacement.
    mg.grid.removeTile(hwnd);
    const ok = this.runEngineOp(mg, (g) =>
      g.addTileWithDisplacement({
        id: hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
      }),
    );
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

    // Absolute in the target iff the target is overlay-mode or the window
    // itself is non-resizable (d.absolute may just mean "source was overlay").
    const nonResizable = info ? !info.resizable : d.absolute;
    if (target.settings.mode === 'overlay' || nonResizable) {
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
    const ok = this.runEngineOp(target, (g) =>
      g.addTileWithDisplacement({
        id: hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
      }),
    );
    if (ok) {
      this.tileGrid.set(hwnd, target.settings.id);
      return;
    }
    // Drop slot unusable: fall back to first-fit / displacement / floating.
    if (info) this.placeWindow(target, info);
  }

  /**
   * Rehydrate tiles from a stored `Grid.toJSON()` snapshot (config
   * round-trip / re-enable). Only windows that are currently present and
   * eligible get their slot back; every stored tile whose window is gone, or
   * whose slot no longer fits the grid, silently falls through to normal
   * placement. A corrupt or missing snapshot is ignored — the grid simply
   * starts empty (no throw).
   */
  private restoreLayout(mg: ManagedGrid, windows: WindowInfo[]): void {
    const stored = extractLayoutTiles(this.storedLayouts[mg.settings.id]);
    if (!stored || stored.length === 0) return;

    const present = new Map<Hwnd, WindowInfo>();
    for (const w of windows) {
      if (!mg.settings.monitorIds.includes(w.monitorId)) continue;
      if (w.minimized) continue;
      if (this.exclusions.has(w.exe)) continue;
      if (this.tileGrid.has(w.hwnd) || this.floating.has(w.hwnd)) continue;
      present.set(w.hwnd, w);
    }

    const overlay = mg.settings.mode === 'overlay';
    for (const t of stored) {
      const w = present.get(t.id);
      if (!w || this.tileGrid.has(t.id)) continue;
      const rect: CellRect = {
        col: t.slot.col,
        row: t.slot.row,
        w: t.slot.w,
        h: t.slot.h,
      };
      if (!mg.grid.rectInBounds(rect)) continue;
      // Stored slots that fall into dead space (spanning grid whose monitor
      // topology changed since the snapshot) fall through to fresh placement.
      if (!this.usable(mg, t.slot)) continue;
      if (overlay || !w.resizable) {
        mg.grid.addTile({
          id: t.id,
          ...rect,
          position: 'absolute',
          pinned: { x: rect.col, y: rect.row },
        });
      } else {
        // In-flow restore (a tile stored as absolute by an overlay session
        // still makes a fine in-flow target): only if the slot is free.
        if (mg.grid.tilesIn(rect).length > 0) continue;
        mg.grid.addTile({ id: t.id, ...rect });
      }
      this.windows.set(t.id, { ...w });
      this.tileGrid.set(t.id, mg.settings.id);
      this.touch(t.id);
    }
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
   * Place a window into a grid: absolute for non-resizable windows and for
   * overlay-mode grids (snapped in place, overlap allowed), else first-fit in
   * reading order, else displacement at the snapped slot. When even
   * displacement fails (grid full) the window is marked floating.
   * Returns whether a tile was created.
   */
  private placeWindow(mg: ManagedGrid, w: WindowInfo): boolean {
    const mon = this.monitorFor(mg.settings);
    if (!mon) return false;
    const dims = this.dims(mg.settings);
    // Dead-space cells (spanning grids, spec §5.7) are excluded from
    // placement: the raw snap moves to the nearest fully usable slot.
    const snapped = this.nearestUsable(mg, snapRectToSlot(mon, dims, w));
    if (!snapped) {
      // Degenerate spanning grid with zero usable cells: nothing can place.
      this.floating.set(w.hwnd, mg.settings.id);
      return false;
    }

    if (!w.resizable || mg.settings.mode === 'overlay') {
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
      this.touch(w.hwnd);
      return true;
    }

    for (let row = 0; row + snapped.h <= dims.rows; row++) {
      for (let col = 0; col + snapped.w <= dims.cols; col++) {
        const rect: CellRect = { col, row, w: snapped.w, h: snapped.h };
        if (!this.usable(mg, rect)) continue; // skip dead-space candidates
        if (mg.grid.tilesIn(rect).length === 0) {
          mg.grid.addTile({ id: w.hwnd, ...rect });
          this.tileGrid.set(w.hwnd, mg.settings.id);
          this.touch(w.hwnd);
          return true;
        }
      }
    }

    const ok = this.runEngineOp(mg, (g) =>
      g.addTileWithDisplacement({
        id: w.hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
      }),
    );
    if (ok) {
      this.tileGrid.set(w.hwnd, mg.settings.id);
      this.touch(w.hwnd);
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

  /**
   * Target pixel rect for a tile. Resizable windows snap to the cell rect
   * (position and size) whether in flow or absolute (overlay mode);
   * non-resizable absolute tiles keep the window's own size (position snap).
   */
  private desiredRect(mon: MonitorInfo, dims: GridDims, tile: Tile): Rect {
    const slot = tileSlotOf(tile);
    const cell = cellRect(mon, dims, slot);
    if (tile.position !== 'absolute') return cell;

    const info = this.windows.get(tile.id);
    if (!info || info.resizable) return cell;
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
      const gridTiles = [...mg.grid.tiles];
      if (mg.settings.mode === 'overlay') {
        // Overlay stacking order: bottom-to-top, top-most (most recent) last.
        gridTiles.sort((a, b) => this.recencyOf(a.id) - this.recencyOf(b.id));
      }
      tiles[id] = gridTiles.map((t) => {
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
