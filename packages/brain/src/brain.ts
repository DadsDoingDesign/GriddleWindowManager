// WindowManagerBrain — pure TS layout brain (contract §C3). Zero Tauri/DOM
// imports; the host wires native events in and applies emitted layouts out.
//
// One @griddle/core Grid per enabled grid. The `push` and `reflow` placement
// modes both use in-flow tiles (first-fit placement, addTileWithDisplacement
// fallback) and differ only in how a *drop* is resolved: push hands the
// collision to Griddle's displacement rules, reflow nails the dropped tile to
// the cell the user aimed at and reorganises the rest with `solveMinimalMoves`
// (falling back to push when the solver declines). Non-resizable windows are
// always `absolute` tiles (position snaps, size is left alone). `stack` mode
// stores every tile as a Griddle `absolute` tile (pinUnits: 'cells'): tiles
// may overlap, nothing displaces, and a brain-wide recency counter orders
// stack snapshots bottom-to-top (top-most last).

import { Grid, isInFlow } from '@griddle/core';
import type { CellRect, Tile } from '@griddle/core';
import {
  cellRect,
  clampSpacing,
  effectiveSpacing,
  type GridDims,
  type Rect,
  slotFromCursor,
  snapRectToSlot,
} from './coords';
import { extractLayoutTiles, normalizePlacementMode } from './persist';
import { solveMinimalMoves, type ReflowMove, type ReflowTile } from './reflow';
import {
  computeUnusableCells,
  nearestUsableSlot,
  slotUsable as slotUsableWithin,
  unionWorkArea,
} from './spanning';
import { makeUserTemplate, mergeWithBuiltins } from './templates';
import type {
  AppConfig,
  AppRule,
  ApplyLayout,
  DragPos,
  FloatingWindow,
  GhostMove,
  GridSettings,
  Hwnd,
  LegacyPlacementMode,
  MonitorInfo,
  Move,
  PlacementMode,
  PreviewState,
  Slot,
  StateSnapshot,
  Template,
  TileSnapshot,
  View,
  ViewAssignment,
  ViewGrid,
  WindowInfo,
} from './types';

export interface BrainCallbacks {
  onApply(layout: ApplyLayout): void;
  onPreview(p: PreviewState): void;
  /**
   * Spec 2026-08-20 (swap drop zone): ask the shell to minimize a window.
   * Optional so headless embedders and older hosts keep working; the brain
   * has already released the window's tile when this fires.
   */
  onMinimize?(hwnd: Hwnd): void;
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
  /**
   * Grid holding the tile when the drag started — `null` for an *intake*
   * drag (spec 2026-08-20): the window is floating, and the drag is the
   * user's attempt to put it onto a grid. Every existing cross-grid code
   * path (`dragFootprint`, `simulateGhosts`) already treats "target ≠
   * source" as a foreign-tile preview, so `null` simply makes every grid a
   * foreign target.
   */
  sourceGridId: string | null;
  startSlot: Slot;
  /** Window rect when the drag started, to tell moves from resizes. */
  startRect: Rect;
  absolute: boolean;
  /** Grid the currently visible preview was emitted for, if any. */
  previewGridId: string | null;
  lastFootprint: Slot | null;
  lastGhosts: GhostMove[];
  /**
   * Last drag-pos sample seen. The commit re-runs the *same* cursor-anchored
   * slot function the preview used (extrapolated by however far the rect
   * moved after the last sample), so the overlay's highlighted cell and the
   * cell the window lands in can never diverge.
   */
  lastDragPos: DragPos | null;
  /** Whether the last preview was computed on the resize path. */
  lastResizing: boolean;
  /** Whether the last preview carried a refusal (part of the change check). */
  lastRefused: boolean;
  /** Whether the last preview's make-room pill was armed (change check). */
  lastArmed: boolean;
  /** Whether the last preview's swap pill was armed (change check). */
  lastSwapArmed: boolean;
}

const DEFAULT_HOTKEY = 'Ctrl+Super+G';

/**
 * What the overlay says when the previewed placement cannot happen. One
 * message for every refusal cause: from the user's side the situation is
 * identical — the grid has no room for this window here.
 */
export const REFUSAL_NO_ROOM = 'No room — this grid is full';

/** Pill label state while armed (spec 2026-08-20, make-room drop zone). */
export const REFUSAL_MAKE_ROOM_ARMED = 'Release to make room';

/**
 * Spec 2026-08-20 (minimum window sizes): the refusal when the window's
 * OS-enforced minimum cannot fit even the whole grid span — naming the real
 * cause instead of claiming a possibly-empty grid is "full".
 */
/** Swap pill label while armed (spec 2026-08-20 addendum). */
export const REFUSAL_SWAP_ARMED = 'Release to swap — the window there minimizes';

export const REFUSAL_MIN_SIZE =
  "This window's minimum size doesn't fit — it needs bigger cells";

/**
 * Drop-zone band geometry (spec 2026-08-20, revised after the first pill
 * layout shipped with overlapping, clipped pills). The zones are full-width
 * horizontal bands over the work area — make-room above, swap below —
 * stacked with generous dead space between and around them, so refusing by
 * dropping outside a band stays easy. Fractions of the work area, with
 * pixel floors so tiny monitors keep hittable targets.
 */
const BAND = {
  insetFrac: 0.04, // horizontal inset each side
  heightFrac: 0.2, // each band
  gapFrac: 0.1, // between the two bands
  minHeight: 56,
  maxHeight: 440,
};

/**
 * Placement mode a grid gets when nothing says otherwise. New grids only —
 * every grid that already exists carries its own mode through the v4 config
 * migration, so upgrading never changes how an existing desktop behaves.
 */
export const DEFAULT_PLACEMENT_MODE: PlacementMode = 'reflow';

/**
 * How long a view's assignments stay claimable after an apply (spec v0.2 §3:
 * 120 s, configurable constant). During the window each `windowAppeared`
 * matching an unclaimed exe assignment takes that slot, beating app rules;
 * afterwards (or once every claim is taken) normal rules resume. Expiry is
 * evaluated lazily against the injected clock — the brain runs no timers.
 *
 * The deadline is wall-clock with one exception: a pause freezes it
 * (`setShellPrefs`), because pause suppresses the very events that consume
 * claims.
 */
export const CLAIM_WINDOW_MS = 120_000;

/**
 * Map key of an app rule's (exe, gridId) identity (spec v0.2 §2: one rule
 * per pair). `\n` can appear in neither part, so keys cannot collide.
 */
function appRuleKey(exe: string, gridId: string | null): string {
  return `${exe}\n${gridId ?? ''}`;
}

/**
 * Validate + normalize an app rule (spec v0.2 §2), shared by `setAppRule` and
 * constructor intake. The exe is trimmed and lowercased (tracker exes are
 * lowercase, so a raw "Slack.exe" would silently never match); `gridId` must
 * be null (any grid) or a NON-EMPTY string — `''` would collide with the
 * any-grid sentinel in `appRuleKey`. The slot must be an integer rect at a
 * non-negative origin, ≥1×1, but is NOT bounded to any grid's dims: it
 * clamps into the target grid's current dims when it fires. Returns null for
 * anything that fails.
 */
function normalizeAppRule(rule: AppRule): AppRule | null {
  const exe = rule.exe.trim().toLowerCase();
  if (exe.length === 0) return null;
  if (rule.gridId !== null && rule.gridId.length === 0) return null;
  const { col, row, w, h } = rule.slot;
  if (![col, row, w, h].every((n) => Number.isInteger(n))) return null;
  if (col < 0 || row < 0 || w < 1 || h < 1) return null;
  return { exe, gridId: rule.gridId, slot: { col, row, w, h } };
}

/**
 * Hygiene for `GridSettings` entering the brain (constructor intake,
 * `enableGrid`, view intake): a present gap/padding is clamped to an integer
 * in 0..MAX_SPACING_PX (an absent one stays absent — absent means 0
 * everywhere, and a v1 config must round-trip byte-identical), and the
 * placement mode is normalized, which maps the pre-v4 `collision`/`overlay`
 * spellings onto `push`/`stack` and anything unrecognizable onto the default.
 *
 * Why here and not only in persist.ts: the *shipped* read path is Rust serde
 * (`config.rs::read_config`) straight into this constructor — `sanitizeConfig`
 * only runs in tests. Rust's `u32` has no range check, so a hand-edited
 * `gap: 999` would otherwise be echoed in every snapshot, shown by the
 * settings stepper, and re-persisted forever even though the math clamps it
 * at use. Normalizing at intake makes the invariant hold for both loaders.
 */
function normalizeGridSettings(g: GridSettings): GridSettings {
  const out: GridSettings = { ...g, monitorIds: [...g.monitorIds] };
  out.mode = normalizePlacementMode(g.mode) ?? DEFAULT_PLACEMENT_MODE;
  if (out.gap !== undefined) out.gap = clampSpacing(out.gap);
  if (out.padding !== undefined) out.padding = clampSpacing(out.padding);
  return out;
}

/**
 * Deep copy of a view (snapshot/export output). `normalize` additionally
 * applies constructor-intake hygiene: assignment exes are trimmed+lowercased
 * (and empty ones dropped — they could never match a tracker exe) and grid
 * spacing is clamped, for the same loader-independence reason as
 * `normalizeGridSettings`.
 */
function copyView(v: View, normalize = false): View {
  return {
    id: v.id,
    name: v.name,
    grids: v.grids.map((g): ViewGrid => {
      const settings = normalize
        ? normalizeGridSettings(g.settings)
        : { ...g.settings, monitorIds: [...g.settings.monitorIds] };
      let assignments = g.assignments.map(
        (a): ViewAssignment => ({
          exe: normalize ? a.exe.trim().toLowerCase() : a.exe,
          slot: { ...a.slot },
        }),
      );
      if (normalize) assignments = assignments.filter((a) => a.exe.length > 0);
      return { settings, assignments };
    }),
  };
}

/**
 * One live pending claim (spec v0.2 §3): an assignment of the last applied
 * view, waiting for the first window of `exe` to appear and take `slot` on
 * `gridId`. First-come-first-claimed: a claim is consumed exactly once.
 */
interface PendingClaim {
  gridId: string;
  exe: string;
  slot: Slot;
  claimed: boolean;
}

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
  /** Monotonic interaction order; higher = more recent (top-most in stack). */
  private recency = new Map<Hwnd, number>();
  private recencyCounter = 0;
  /** Last rect emitted per hwnd, so flush() only emits actual changes. */
  private appliedRects = new Map<Hwnd, Rect>();
  /** In-progress user drag (between moveSizeStart and moveSizeEnd). */
  private drag: DragState | null = null;

  private templates: Template[];
  private exclusions: Set<string>;
  /** Per-app placement rules keyed by (exe, gridId) — spec v0.2 §2. */
  private appRules = new Map<string, AppRule>();
  /** Startup views (spec v0.2 §3), insertion order. */
  private views: View[] = [];
  /** View applied on app launch, or null for none (spec v0.2 §3). */
  private startupViewId: string | null = null;
  /** Assignments of the last applied view still inside the claim window. */
  private pendingClaims: PendingClaim[] = [];
  /** now()-timestamp at which the pending claims lapse. */
  private claimsDeadline = 0;
  /**
   * now() when the current pause began, or null while running. The claim
   * deadline is wall-clock, but pause suppresses every `window-appeared` at
   * the tracker — so a pause spanning the window would silently consume it
   * (boot with a startup view while paused, resume two minutes later, and
   * the view would never claim anything). Resuming adds the paused span back
   * to `claimsDeadline`; see `setShellPrefs`.
   */
  private pausedSince: number | null = null;
  /** Injected clock (tests pass a fake; the host uses Date.now). */
  private readonly now: () => number;
  /** Layout snapshots for grids that are not live (from config / disable). */
  private storedLayouts: Record<string, unknown>;
  private hotkey: string;
  private autostart: boolean;
  private paused: boolean;
  /**
   * Opt-in update checks (spec §7). The brain only *stores* it — the host's
   * updater driver reads it back through `exportConfig()` to decide whether
   * the periodic check is allowed to run at all. Anything but a literal
   * `true` from the loader is opted out.
   */
  private autoCheckUpdates: boolean;
  /** Spec 2026-08-19: stored + echoed; the Rust shell owns the OS effects. */
  private suppressWindowsSnap: boolean;
  /** Rust-authoritative capture; the brain only round-trips it. */
  private windowsSnapOriginal: import('./types').SnapState | null;

  constructor(cb: BrainCallbacks, cfg?: AppConfig, opts?: { now?: () => number }) {
    this.cb = cb;
    this.now = opts?.now ?? Date.now;
    this.templates = mergeWithBuiltins(cfg?.templates ?? []);
    this.exclusions = new Set(cfg?.exclusions ?? []);
    this.storedLayouts = { ...(cfg?.layouts ?? {}) };
    this.hotkey = cfg?.hotkey ?? DEFAULT_HOTKEY;
    this.autostart = cfg?.autostart ?? false;
    this.paused = cfg?.paused ?? false;
    this.autoCheckUpdates = cfg?.autoCheckUpdates === true;
    this.suppressWindowsSnap = cfg?.suppressWindowsSnap === true;
    this.windowsSnapOriginal = cfg?.windowsSnapOriginal ?? null;
    // A pause that survived a restart (config `paused: true`) is already
    // running when the constructor returns — start its clock here so the
    // startup view's claim window is not eaten by it.
    this.pausedSince = this.paused ? this.now() : null;
    // Constructor intake runs the same validation `setAppRule` does: the
    // shipped read path is Rust serde, which accepts anything serde-valid
    // (a "Slack.exe" that could never match, a `gridId: ""` colliding with
    // the any-grid sentinel), so the brain's own invariants must not depend
    // on which loader fed it.
    for (const raw of cfg?.appRules ?? []) {
      const rule = normalizeAppRule(raw);
      if (rule) this.appRules.set(appRuleKey(rule.exe, rule.gridId), rule);
    }
    this.views = (cfg?.views ?? []).map((v) => copyView(v, true));
    // A dangling startup id (sanitizeConfig already resets it, but the
    // constructor is not only fed sanitized configs) reads as "none".
    const startup = cfg?.startupViewId ?? null;
    this.startupViewId =
      startup !== null && this.views.some((v) => v.id === startup) ? startup : null;
    for (const g of cfg?.grids ?? []) {
      this.gridSettings.set(g.id, normalizeGridSettings(g));
    }
  }

  // ── native inputs ──────────────────────────────────────────────────────

  /**
   * Monitor topology / geometry change. Beyond storing the new list this
   * (1) deactivates live grids whose monitor(s) left — the layout snapshot
   * is kept and the settings stay enabled, so the grid revives on replug;
   * (2) revives enabled-but-inert grids whose monitors are all present
   * again (dock/undock), restoring the stored layout against `windows`
   * (the host passes a fresh sweep); (3) recomputes spanning dead space;
   * and (4) flushes, so tiled windows track a changed work area (moved
   * taskbar, resolution change) immediately instead of at the next
   * unrelated event.
   */
  setMonitors(mons: MonitorInfo[], windows: WindowInfo[] = []): void {
    this.monitors = new Map(mons.map((m) => [m.id, m]));

    for (const id of [...this.grids.keys()]) {
      const mg = this.grids.get(id);
      if (mg && !this.monitorFor(mg.settings)) this.releaseGrid(id);
    }
    for (const settings of [...this.gridSettings.values()]) {
      if (!settings.enabled || this.grids.has(settings.id)) continue;
      if (!this.monitorFor(settings)) continue;
      this.enableGrid(settings, windows);
    }

    // Monitor geometry defines a spanning grid's dead space — recompute it,
    // then rescue any tile the new dead cells swallowed (a taskbar appearing
    // on a member, or a resolution change, can turn a live cell into seam).
    for (const mg of this.grids.values()) {
      if (mg.settings.monitorIds.length <= 1) continue;
      const mon = this.monitorFor(mg.settings);
      if (!mon) continue;
      mg.unusable = this.unusableFor(mg.settings, mon);
      this.repairDeadSpace(mg);
    }
    this.flush();
    this.emitSnapshot();
  }

  windowAppeared(w: WindowInfo): void {
    if (this.tileGrid.has(w.hwnd) || this.floating.has(w.hwnd)) {
      this.readopt(w);
      return;
    }
    if (w.minimized) return;
    if (this.exclusions.has(w.exe)) return;
    // Restore-previous beats every app rule (spec v0.2 §2 precedence): a
    // hwnd with a remembered slot re-enters through the restore flow — the
    // reconcile sweep routes a window minimized-then-restored during a pause
    // here rather than through `window-restored`.
    if (this.remembered.has(w.hwnd)) {
      this.windowRestored(w);
      return;
    }
    const mg = this.gridForMonitor(w.monitorId);
    if (!mg && !this.claimsActive()) return;
    this.windows.set(w.hwnd, { ...w });
    // Pending view claims beat every app rule during the claim window (spec
    // v0.2 §3) — and can pull a matching window onto its assigned grid even
    // from an ungridded monitor.
    if (this.claimWindow(w)) {
      this.flush();
      this.emitSnapshot();
      return;
    }
    if (!mg) {
      this.windows.delete(w.hwnd);
      return;
    }
    this.placeAppeared(mg, w);
    this.flush();
    this.emitSnapshot();
  }

  /**
   * Convergence for a `window-appeared` whose hwnd the brain already tracks
   * as tiled or floating. Normally this is the idempotent path — but Windows
   * recycles HWND values, and a recycled handle's destroyed→appeared pair can
   * race the host's async destroy vetting so that the destroy is dropped
   * entirely. Ignoring the appearance would leave the *new* window silently
   * inheriting the dead window's tile with stale title/exe/monitor in every
   * snapshot; re-adopting instead makes the dropped-destroy race converge to
   * correct state regardless of event ordering:
   * excluded exe → the stale tile is dropped (the window is never touched);
   * minimized → the minimize flow releases the tile; otherwise the stored
   * `WindowInfo` is refreshed in place (the tile keeps its slot).
   */
  private readopt(w: WindowInfo): void {
    if (this.exclusions.has(w.exe)) {
      this.windowDestroyed(w.hwnd);
      return;
    }
    if (w.minimized) {
      // Refresh identity first so the minimize flow remembers the new tenant.
      this.windows.set(w.hwnd, { ...w, minimized: false });
      this.windowMinimized(w.hwnd);
      return;
    }
    const prev = this.windows.get(w.hwnd);
    this.windows.set(w.hwnd, { ...w });
    const identityChanged =
      !prev ||
      prev.title !== w.title ||
      prev.exe !== w.exe ||
      prev.monitorId !== w.monitorId;
    if (identityChanged) this.emitSnapshot();
  }

  /**
   * Pause→resume reconciliation (spec §6 panic button): while paused the
   * shell suppresses every window event, so on resume the brain's picture may
   * be arbitrarily stale. Converge onto a fresh sweep of the live desktop:
   *
   *   - known windows missing from the sweep are destroyed;
   *   - tiled windows minimized (or maximized) during the pause go through
   *     the minimize flow, releasing their tile — no move is ever emitted for
   *     an iconic window;
   *   - tiled windows the user physically moved while paused are re-snapped
   *     onto their slot (management is authoritative again the moment it
   *     resumes) by dropping their applied rect before the flush;
   *   - everything else re-runs `windowAppeared`, which re-adopts known
   *     windows and places genuinely new ones.
   */
  reconcile(live: WindowInfo[]): void {
    const liveSet = new Set(live.map((w) => w.hwnd));
    const known = new Set<Hwnd>([
      ...this.tileGrid.keys(),
      ...this.floating.keys(),
      ...this.remembered.keys(),
    ]);
    for (const hwnd of known) {
      if (!liveSet.has(hwnd)) this.windowDestroyed(hwnd);
    }
    for (const w of live) {
      if (this.tileGrid.has(w.hwnd) && !w.minimized && !this.exclusions.has(w.exe)) {
        this.windows.set(w.hwnd, { ...w });
        const applied = this.appliedRects.get(w.hwnd);
        if (
          applied &&
          !sameRect(applied, { x: w.x, y: w.y, width: w.width, height: w.height })
        ) {
          this.appliedRects.delete(w.hwnd);
        }
        continue;
      }
      this.windowAppeared(w);
    }
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
    if (gridId === undefined) {
      this.beginIntakeDrag(hwnd);
      return;
    }
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
      lastDragPos: null,
      lastResizing: false,
      lastRefused: false,
      lastArmed: false,
      lastSwapArmed: false,
    };
    this.cb.onPreview({ gridId, visible: true, footprint: slot, ghosts: [] });
  }

  /**
   * Spec 2026-08-20 (drag intake): a drag starting on a *floating* window —
   * one the brain vetted on appearance but had no room for — previews and
   * can place, so the first gesture everyone tries is never dead air.
   * Unknown hwnds stay ignored: the brain acts only on windows that went
   * through `windowAppeared`'s eligibility path.
   */
  private beginIntakeDrag(hwnd: Hwnd): void {
    if (!this.floating.has(hwnd)) return;
    const info = this.windows.get(hwnd);
    const startRect: Rect = info
      ? { x: info.x, y: info.y, width: info.width, height: info.height }
      : { x: 0, y: 0, width: 0, height: 0 };
    this.drag = {
      hwnd,
      sourceGridId: null,
      startSlot: { col: 0, row: 0, w: 1, h: 1 }, // never read: intake always takes the foreign-target path
      startRect,
      absolute: info ? !info.resizable : false,
      previewGridId: null,
      lastFootprint: null,
      lastGhosts: [],
      lastDragPos: null,
      lastResizing: false,
      lastRefused: false,
      lastArmed: false,
      lastSwapArmed: false,
    };
    // Immediate response on the grid under the window, so the overlay reacts
    // to the grab itself rather than the first movement.
    const mg = info ? this.gridForMonitor(info.monitorId) : undefined;
    const mon = mg ? this.monitorFor(mg.settings) : undefined;
    if (!mg || !mon || !info) return;
    const d = this.drag;
    const computed = this.dragFootprint(
      mg,
      mon,
      d,
      info.x + info.width / 2,
      info.y + info.height / 2,
      startRect,
    );
    if (!computed) return;
    const unfittable = this.minUnfittable(mon, this.dims(mg.settings), info);
    const refused = unfittable || this.placementRefused(mg, d, computed.footprint);
    // Same pill logic as dragMoved, with the window's centre standing in for
    // the cursor: the grab itself must already show the whole story, or the
    // change-detection in dragMoved would suppress the pill until the first
    // footprint change.
    const minCells = this.minCellsFor(mon, this.dims(mg.settings), info);
    const offerPills = refused && !unfittable;
    const plan = offerPills ? this.makeRoomPlan(mg, computed.footprint, minCells) : null;
    const swPlan = offerPills ? this.swapPlan(mg, computed.footprint, minCells) : null;
    const pills = this.pillRects(
      mon,
      this.dims(mg.settings),
      computed.footprint,
      plan !== null,
      swPlan !== null,
    );
    // Never armed at the grab: the full-width bands sit under many windows'
    // centres, and arming must express drag intent, not a click. Arming
    // starts with the first real drag sample (see intakeDrop's guard).
    const armed = false;
    const swapArmed = false;
    d.previewGridId = mg.settings.id;
    d.lastFootprint = computed.footprint;
    d.lastRefused = refused;
    d.lastArmed = armed;
    d.lastSwapArmed = swapArmed;
    this.cb.onPreview({
      gridId: mg.settings.id,
      visible: true,
      footprint: computed.footprint,
      ghosts: [],
      ...(refused
        ? {
            refusal: armed
              ? REFUSAL_MAKE_ROOM_ARMED
              : swapArmed
                ? REFUSAL_SWAP_ARMED
                : unfittable
                  ? REFUSAL_MIN_SIZE
                  : REFUSAL_NO_ROOM,
          }
        : {}),
      ...(pills.makeRoom ? { makeRoom: { ...pills.makeRoom, armed } } : {}),
      ...(pills.swap ? { swap: { ...pills.swap, armed: swapArmed } } : {}),
    });
  }

  dragMoved(p: DragPos): void {
    const d = this.drag;
    if (!d || d.hwnd !== p.hwnd) return;
    d.lastDragPos = p;

    const target = this.gridAtPoint(p.cursorX, p.cursorY);
    if (!target) {
      // Cursor over an ungridded area: nothing to preview.
      this.hidePreview(d);
      return;
    }
    const { mg, mon } = target;
    const rect: Rect = { x: p.x, y: p.y, width: p.width, height: p.height };
    const computed = this.dragFootprint(mg, mon, d, p.cursorX, p.cursorY, rect);
    if (!computed) {
      this.hidePreview(d);
      return;
    }
    const { footprint, resizing } = computed;

    // During a drag the grid is frozen, so the ghosts are a pure function of
    // (target grid, footprint, resize-mode): identical inputs mean the last
    // preview still stands — skip the simulation entirely.
    const dragInfo = this.windows.get(d.hwnd);
    const unfittable = this.minUnfittable(mon, this.dims(mg.settings), dragInfo);
    const refused = unfittable || this.placementRefused(mg, d, footprint);
    // Pills are offered for intake drags only: their drop machinery lives in
    // intakeDrop, and a pill a managed drop would silently ignore is worse
    // than no pill.
    const offerPills = refused && !unfittable && d.sourceGridId === null;
    const minCells = this.minCellsFor(mon, this.dims(mg.settings), dragInfo);
    const plan = offerPills ? this.makeRoomPlan(mg, footprint, minCells) : null;
    const swPlan = offerPills ? this.swapPlan(mg, footprint, minCells) : null;
    const pills = this.pillRects(mon, this.dims(mg.settings), footprint, plan !== null, swPlan !== null);
    const inRect = (r: { x: number; y: number; width: number; height: number } | undefined) =>
      r !== undefined &&
      p.cursorX >= r.x &&
      p.cursorX <= r.x + r.width &&
      p.cursorY >= r.y &&
      p.cursorY <= r.y + r.height;
    const armed = inRect(pills.makeRoom);
    const swapArmed = inRect(pills.swap);
    const unchanged =
      d.previewGridId === mg.settings.id &&
      d.lastFootprint !== null &&
      sameSlot(d.lastFootprint, footprint) &&
      d.lastResizing === resizing &&
      d.lastRefused === refused &&
      d.lastArmed === armed &&
      d.lastSwapArmed === swapArmed;
    if (unchanged) return;

    // Stack-mode targets never reflow neighbors; absolute tiles displace
    // nothing either way — both preview with no ghosts. Everything else
    // previews with the very solver/engine its own commit will run, so the
    // ghosts the user watches are the moves they get on release.
    const ghosts =
      d.absolute || mg.settings.mode === 'stack'
        ? []
        : this.previewGhosts(mg, d, footprint, resizing);

    if (
      d.previewGridId === mg.settings.id &&
      d.lastFootprint !== null &&
      sameSlot(d.lastFootprint, footprint) &&
      sameGhosts(d.lastGhosts, ghosts) &&
      d.lastRefused === refused &&
      d.lastArmed === armed &&
      d.lastSwapArmed === swapArmed
    ) {
      d.lastResizing = resizing;
      return;
    }

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
    d.lastResizing = resizing;
    d.lastRefused = refused;
    d.lastArmed = armed;
    d.lastSwapArmed = swapArmed;
    // Armed: WYSIWYG the outcome. Make-room shows the donated half with the
    // victim's move as a ghost; swap shows the victim's whole slot (the
    // victim minimizes, so there is no destination to ghost).
    const shownFootprint =
      armed && plan ? plan.donated : swapArmed && swPlan ? swPlan.slot : footprint;
    const shownGhosts =
      armed && plan
        ? (() => {
            const t = mg.grid.getTile(plan.victim);
            return t ? [{ hwnd: plan.victim, from: tileSlotOf(t), to: plan.kept }] : ghosts;
          })()
        : swapArmed
          ? []
          : ghosts;
    this.cb.onPreview({
      gridId: mg.settings.id,
      visible: true,
      footprint: shownFootprint,
      ghosts: shownGhosts,
      ...(refused
        ? {
            refusal: armed
              ? REFUSAL_MAKE_ROOM_ARMED
              : swapArmed
                ? REFUSAL_SWAP_ARMED
                : unfittable
                  ? REFUSAL_MIN_SIZE
                  : REFUSAL_NO_ROOM,
          }
        : {}),
      ...(pills.makeRoom ? { makeRoom: { ...pills.makeRoom, armed } } : {}),
      ...(pills.swap ? { swap: { ...pills.swap, armed: swapArmed } } : {}),
    });
  }

  /**
   * Spec 2026-08-20 (minimum window sizes): the cells `info`'s OS-enforced
   * minimum needs on this grid. Unclamped on purpose — a result exceeding
   * the grid's dims is how callers detect "cannot fit at all". Same pitch
   * math as snapRectToSlot: a w-cell footprint is w*pitch - gap pixels.
   */
  private minCellsFor(
    mon: MonitorInfo,
    dims: { cols: number; rows: number },
    info: WindowInfo | undefined,
  ): { w: number; h: number } {
    const minW = info?.minWidth ?? 0;
    const minH = info?.minHeight ?? 0;
    if (minW <= 0 && minH <= 0) return { w: 1, h: 1 };
    const eff = effectiveSpacing(mon, dims);
    const pitchW = (eff.width - eff.gapX * (dims.cols - 1)) / dims.cols + eff.gapX;
    const pitchH = (eff.height - eff.gapY * (dims.rows - 1)) / dims.rows + eff.gapY;
    return {
      w: Math.max(1, Math.ceil((minW + eff.gapX) / pitchW)),
      h: Math.max(1, Math.ceil((minH + eff.gapY) / pitchH)),
    };
  }

  /** Does `info`'s minimum exceed what this whole grid can offer? */
  private minUnfittable(
    mon: MonitorInfo,
    dims: { cols: number; rows: number },
    info: WindowInfo | undefined,
  ): boolean {
    const need = this.minCellsFor(mon, dims, info);
    return need.w > dims.cols || need.h > dims.rows;
  }

  /**
   * Spec 2026-08-20 (make-room): the split a drop on the pill would commit.
   * Victim = the in-flow tile covering the refused footprint's origin cell;
   * splittable iff it spans >= 2 cells on some axis. The donated half is the
   * half containing the aimed cell (odd spans round in the newcomer's
   * favour), so the newcomer lands where the user pointed. Pure: preview and
   * commit run the same computation, so the ghosts are the outcome.
   */
  private makeRoomPlan(
    target: ManagedGrid,
    footprint: Slot,
    minCells: { w: number; h: number } = { w: 1, h: 1 },
  ): { victim: Hwnd; kept: Slot; donated: Slot } | null {
    const origin = { col: footprint.col, row: footprint.row, w: 1, h: 1 };
    const victims = target.grid.tilesIn(origin).filter((t) => isInFlow(t));
    const victim = victims[0];
    if (!victim) return null;
    const v = tileSlotOf(victim);
    if (v.w < 2 && v.h < 2) return null;
    if (v.w >= v.h) {
      // Column split. Aimed side gets ceil(w/2).
      const donatedW = Math.ceil(v.w / 2);
      const keptW = v.w - donatedW;
      const aimLeft = footprint.col < v.col + v.w / 2;
      const donated: Slot = aimLeft
        ? { col: v.col, row: v.row, w: donatedW, h: v.h }
        : { col: v.col + keptW, row: v.row, w: donatedW, h: v.h };
      const kept: Slot = aimLeft
        ? { col: v.col + donatedW, row: v.row, w: keptW, h: v.h }
        : { col: v.col, row: v.row, w: keptW, h: v.h };
      if (donated.w < minCells.w || donated.h < minCells.h) return null;
      return { victim: victim.id, kept, donated };
    }
    const donatedH = Math.ceil(v.h / 2);
    const keptH = v.h - donatedH;
    const aimTop = footprint.row < v.row + v.h / 2;
    const donated: Slot = aimTop
      ? { col: v.col, row: v.row, w: v.w, h: donatedH }
      : { col: v.col, row: v.row + keptH, w: v.w, h: donatedH };
    const kept: Slot = aimTop
      ? { col: v.col, row: v.row + donatedH, w: v.w, h: keptH }
      : { col: v.col, row: v.row, w: v.w, h: keptH };
    if (donated.w < minCells.w || donated.h < minCells.h) return null;
    return { victim: victim.id, kept, donated };
  }

  /**
   * Spec 2026-08-20 addendum (swap): the exchange a drop on the swap pill
   * commits — the in-flow tile at the aimed cell is minimized and the
   * newcomer takes its exact slot. Offered only when that slot satisfies
   * the newcomer's minimum (otherwise the swap would recreate the very
   * overflow the minimum rules exist to prevent).
   */
  private swapPlan(
    target: ManagedGrid,
    footprint: Slot,
    minCells: { w: number; h: number } = { w: 1, h: 1 },
  ): { victim: Hwnd; slot: Slot } | null {
    const origin = { col: footprint.col, row: footprint.row, w: 1, h: 1 };
    const victim = target.grid.tilesIn(origin).filter((t) => isInFlow(t))[0];
    if (!victim) return null;
    const slot = tileSlotOf(victim);
    if (slot.w < minCells.w || slot.h < minCells.h) return null;
    return { victim: victim.id, slot };
  }

  /**
   * Pixel rects for the offered drop-zone bands: full work-area width,
   * stacked vertically (make-room above, swap below) and centered as a
   * group, leaving band-free space above, between and below so a plain
   * refusing drop stays easy. Disjoint by construction — arming is mutually
   * exclusive. The bands sit at fixed positions rather than tracking the
   * footprint: the cursor's position inside a band still picks the aimed
   * cell, so aim keeps choosing the victim.
   */
  private pillRects(
    mon: MonitorInfo,
    _dims: { cols: number; rows: number },
    _footprint: Slot,
    wantMakeRoom: boolean,
    wantSwap: boolean,
  ): {
    makeRoom?: { x: number; y: number; width: number; height: number };
    swap?: { x: number; y: number; width: number; height: number };
  } {
    const count = (wantMakeRoom ? 1 : 0) + (wantSwap ? 1 : 0);
    if (count === 0) return {};
    const inset = Math.round(mon.workWidth * BAND.insetFrac);
    const x = mon.workX + inset;
    const width = mon.workWidth - inset * 2;
    const height = Math.max(
      BAND.minHeight,
      Math.min(BAND.maxHeight, Math.round(mon.workHeight * BAND.heightFrac)),
    );
    const gap = Math.round(mon.workHeight * BAND.gapFrac);
    const total = count === 2 ? height * 2 + gap : height;
    const top = mon.workY + Math.round((mon.workHeight - total) / 2);
    const first = { x, y: top, width, height };
    const second = { x, y: top + height + gap, width, height };
    if (wantMakeRoom && wantSwap) return { makeRoom: first, swap: second };
    return wantMakeRoom ? { makeRoom: first } : { swap: first };
  }

  /** Commit the split an armed drop asked for. True on success. */
  private commitMakeRoom(
    target: ManagedGrid,
    hwnd: Hwnd,
    plan: { victim: Hwnd; kept: Slot; donated: Slot },
  ): boolean {
    // Same wholesale snapshot/restore as the reflow commit: the victim's
    // resize and the newcomer's arrival land as one batch, so the grid is
    // never observed half-split.
    const next = target.grid.snapshotTiles();
    const victim = next.get(plan.victim);
    if (!victim) return false; // grid changed under the plan
    victim.col = plan.kept.col;
    victim.row = plan.kept.row;
    victim.w = plan.kept.w;
    victim.h = plan.kept.h;
    next.set(hwnd, {
      id: hwnd,
      col: plan.donated.col,
      row: plan.donated.row,
      w: plan.donated.w,
      h: plan.donated.h,
    });
    target.grid.restoreTiles(next);
    return true;
  }

  /** Commit the exchange an armed swap drop asked for. True on success. */
  private commitSwap(
    target: ManagedGrid,
    hwnd: Hwnd,
    plan: { victim: Hwnd; slot: Slot },
    info: WindowInfo | undefined,
  ): boolean {
    const victim = target.grid.getTile(plan.victim);
    if (!victim) return false; // grid changed under the plan
    target.grid.removeTile(plan.victim);
    this.tileGrid.delete(plan.victim);
    this.appliedRects.delete(plan.victim);
    const resizable = info?.resizable ?? true;
    if (target.settings.mode === 'stack' || !resizable) {
      target.grid.addTile({
        id: hwnd,
        col: plan.slot.col,
        row: plan.slot.row,
        w: plan.slot.w,
        h: plan.slot.h,
        position: 'absolute',
        pinned: { x: plan.slot.col, y: plan.slot.row },
      });
    } else {
      target.grid.addTile({
        id: hwnd,
        col: plan.slot.col,
        row: plan.slot.row,
        w: plan.slot.w,
        h: plan.slot.h,
      });
    }
    return true;
  }

  /**
   * Would committing `hwnd` at `footprint` on `target` be refused? Pure —
   * preview and drop both ask, so the message the user watches and the
   * outcome they get can never disagree (the same WYSIWYG rule the footprint
   * itself follows).
   */
  private placementRefused(target: ManagedGrid, d: DragState, footprint: Slot): boolean {
    // Absolute placements (stack grids, non-resizable windows) always land.
    if (target.settings.mode === 'stack' || d.absolute) return false;
    // A free slot is a free slot.
    const occupied = target.grid
      .tilesIn({ col: footprint.col, row: footprint.row, w: footprint.w, h: footprint.h })
      .filter((t) => t.id !== d.hwnd && isInFlow(t));
    if (occupied.length === 0) return false;
    // Reflow: possible iff the solver has a plan (its own commit falls back
    // to push when it declines, so check push next either way).
    if (target.settings.mode === 'reflow' && this.solveReflow(target, d.hwnd, footprint)) {
      return false;
    }
    // Push: dry-run the exact engine op the commit runs, on a clone.
    const clone = Grid.fromJSON(target.grid.toJSON());
    if (target.settings.id === d.sourceGridId) clone.removeTile(d.hwnd);
    try {
      // addTileWithDisplacement reports success as a boolean; false means
      // the victims had nowhere to go and nothing was added.
      return !clone.addTileWithDisplacement({
        id: d.hwnd,
        col: footprint.col,
        row: footprint.row,
        w: footprint.w,
        h: footprint.h,
      });
    } catch {
      return true;
    }
  }

  /**
   * The one slot function shared by preview and commit: footprint for a drag
   * of `d` over grid `mg` with the cursor at (`cursorX`, `cursorY`) and the
   * window at `rect`. Moves are cursor-anchored (`slotFromCursor`); resizes
   * snap the rect itself. Returns null when the grid has no usable slot.
   */
  private dragFootprint(
    mg: ManagedGrid,
    mon: MonitorInfo,
    d: DragState,
    cursorX: number,
    cursorY: number,
    rect: Rect,
  ): { footprint: Slot; resizing: boolean } | null {
    const dims = this.dims(mg.settings);
    // Non-resizable windows never report a size change, so this is safe for
    // absolute tiles too (stack-mode resizes must re-snap the footprint).
    const resizing =
      rect.width !== d.startRect.width || rect.height !== d.startRect.height;
    let footprint: Slot;
    if (resizing) {
      footprint = snapRectToSlot(mon, dims, rect);
    } else {
      const size =
        mg.settings.id === d.sourceGridId
          ? { w: d.startSlot.w, h: d.startSlot.h }
          : snapRectToSlot(mon, dims, rect); // footprint in the target grid's cells
      footprint = slotFromCursor(mon, dims, cursorX, cursorY, size);
    }
    // Minimum window sizes (spec 2026-08-20): a footprint below the
    // window's OS minimum would overflow its cells — Windows clamps the
    // resize, not us. Grow to at least the minimum's cells, capped at the
    // grid (the unfittable case refuses separately, with its own message).
    const need = this.minCellsFor(mon, dims, this.windows.get(d.hwnd));
    footprint = {
      ...footprint,
      w: Math.min(dims.cols, Math.max(footprint.w, need.w)),
      h: Math.min(dims.rows, Math.max(footprint.h, need.h)),
    };
    footprint.col = Math.min(footprint.col, dims.cols - footprint.w);
    footprint.row = Math.min(footprint.row, dims.rows - footprint.h);
    // Preview and commit snap to usable slots identically (spec §5.7).
    const adjusted = this.nearestUsable(mg, footprint);
    return adjusted ? { footprint: adjusted, resizing } : null;
  }

  moveSizeEnd(
    hwnd: Hwnd,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const d = this.drag;
    if (!d || d.hwnd !== hwnd) return;
    this.drag = null;
    this.hidePreview(d);

    if (d.sourceGridId === null) {
      this.intakeDrop(d, rect);
      return;
    }
    const source = this.grids.get(d.sourceGridId);
    if (!source || !source.grid.getTile(hwnd)) return; // grid vanished mid-drag

    const hitMon = this.monitorAt(rect.x + rect.width / 2, rect.y + rect.height / 2);

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

    // WYSIWYG commit anchor: when drag-pos samples were seen, re-run the
    // exact slot function the preview used, with the cursor extrapolated by
    // however far the rect moved after the last sample (normally zero) — the
    // committed cell is then always the previewed cell. Without samples
    // (drag pump never fired) fall back to rect snapping below.
    let target: ManagedGrid | undefined;
    let snapped: Slot | null = null;
    let unmanage = false;
    let resolved = false;
    const lp = d.lastDragPos;
    if (lp) {
      const cursorX = lp.cursorX + (rect.x - lp.x);
      const cursorY = lp.cursorY + (rect.y - lp.y);
      const at = this.gridAtPoint(cursorX, cursorY);
      if (at) {
        const computed = this.dragFootprint(at.mg, at.mon, d, cursorX, cursorY, rect);
        if (computed) {
          target = at.mg;
          snapped = computed.footprint;
          resolved = true;
        }
      } else if (this.monitorAt(cursorX, cursorY)) {
        // Cursor over an ungridded monitor — exactly what the (hidden)
        // preview showed: the window unmanages where the user dropped it.
        unmanage = true;
        resolved = true;
      }
      // Cursor over no monitor at all (or a grid with zero usable cells):
      // the anchor is unreliable, resolve from the rect below.
    }
    if (!resolved) {
      // A drop whose center lies on no monitor — half off-screen, or in the
      // dead space of an L-shaped spanning grid — stays with the source grid
      // and snaps to its nearest usable slot below.
      target = hitMon ? this.gridForMonitor(hitMon.id) : source;
      unmanage = target === undefined;
      if (target) {
        const mon = this.monitorFor(target.settings);
        if (!mon) return;
        // Drops in the dead space of a spanning grid snap to the nearest
        // usable slot (spec §5.7). A grid with zero usable cells cannot take
        // the drop: the tile stays put and snaps back to its old cell.
        snapped = this.nearestUsable(
          target,
          snapRectToSlot(mon, this.dims(target.settings), rect),
        );
      }
    }

    if (unmanage) {
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

    if (!target || !this.monitorFor(target.settings)) return;
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
    const settings: GridSettings = { ...normalizeGridSettings(g), enabled: true };
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
      // Pending view claims beat auto-placement here exactly as they do in
      // `windowAppeared` (spec v0.2 §3). This sweep is also the monitor-
      // hotplug revive path (`setMonitors`), which is precisely how a startup
      // view meets a monitor that enumerates seconds after logon (docking
      // station / DP link training): without this the revive would auto-place
      // every swept window and the view's assignments would be silently
      // ignored. Windows whose slot the stored layout already restored keep
      // it — restore-previous outranks every rule (spec v0.2 §2).
      if (this.claimWindow(w)) continue;
      this.placeWindow(mg, w);
    }
    this.flush();
    this.emitSnapshot();
  }

  disableGrid(gridId: string): void {
    this.teardownGrid(gridId);
    this.emitSnapshot();
  }

  /**
   * Change a grid's placement mode. The pre-v4 spellings (`collision`,
   * `overlay`) are still accepted and mean `push` / `stack`; an unrecognized
   * value is ignored rather than corrupting the grid.
   *
   * Only the stack boundary moves tiles: entering `stack` converts every
   * in-flow tile to an absolute tile at its own slot (geometry unchanged, no
   * moves emitted), leaving it re-packs them in flow. `push` ⇄ `reflow` is
   * pure policy — both keep the same in-flow tiles, they only resolve the
   * *next* drop differently — so switching never disturbs the desktop.
   */
  setMode(gridId: string, mode: PlacementMode | LegacyPlacementMode): void {
    const next = normalizePlacementMode(mode);
    if (next === null) return;
    const settings = this.gridSettings.get(gridId);
    if (!settings || settings.mode === next) return;
    const wasStack = settings.mode === 'stack';
    const updated: GridSettings = { ...settings, mode: next };
    this.gridSettings.set(gridId, updated);

    const mg = this.grids.get(gridId);
    if (!mg) {
      this.emitSnapshot();
      return;
    }
    mg.settings = updated;
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();

    if (next === 'stack') {
      // Convert in place: every in-flow tile becomes absolute at its own
      // slot. Geometry is unchanged, so no moves are emitted.
      for (const tile of [...mg.grid.tiles]) {
        if (tile.position === 'absolute') continue;
        mg.grid.setTilePosition(tile.id, 'absolute', {
          pinned: { x: tile.col, y: tile.row },
        });
      }
    } else if (wasStack) {
      this.convertToInFlow(mg);
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

    const stack = updated.mode === 'stack';
    for (const e of entries) {
      const info = this.windows.get(e.id);
      const slot = clampSlot(e.slot, cols, rows);
      if (this.addAtSlot(mg, e.id, slot, stack, info)) continue;
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
   * Contract §C3 extension (spec v0.2 §1): change a grid's gap/padding.
   * Values are clamped to integers in 0..MAX_SPACING_PX. On a single-monitor
   * grid cell assignments never change — only their pixel projection does —
   * so the live grid re-applies every tile in one batch (flush diffs desired
   * rects). On a *spanning* grid the dead-space set is a function of the cell
   * pixel rects, so spacing can move a cell wholly into the seam: the
   * recomputed `unusable` set is followed by a repair sweep that re-places
   * every tile it stranded (`repairDeadSpace`). Also works on a disabled
   * grid: the remembered settings update and persist.
   */
  setSpacing(gridId: string, gap: number, padding: number): void {
    const settings = this.gridSettings.get(gridId);
    if (!settings) return;
    gap = clampSpacing(gap);
    padding = clampSpacing(padding);
    if ((settings.gap ?? 0) === gap && (settings.padding ?? 0) === padding) return;
    const updated: GridSettings = { ...settings, gap, padding };
    this.gridSettings.set(gridId, updated);

    const mg = this.grids.get(gridId);
    if (mg) {
      mg.settings = updated;
      // The overlay preview and the committed cell must use the same pixel
      // math throughout a drag — abort any drag on this grid, like reflow.
      if (this.drag?.sourceGridId === gridId) this.cancelDrag();
      // Padding moves cell pixel rects, and pixel rects decide which cells
      // of a spanning union are dead space — keep the set current, then
      // rescue any tile the new dead cells swallowed (an unrepaired tile
      // would flush to a rect straddling no physical monitor).
      const mon = this.monitorFor(updated);
      if (mon && updated.monitorIds.length > 1) {
        mg.unusable = this.unusableFor(updated, mon);
        this.repairDeadSpace(mg);
      }
      this.flush();
    }
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

    const stack = settings.mode === 'stack';
    order.forEach((hwnd, i) => {
      const info = this.windows.get(hwnd);
      const slot = i < tpl.slots.length ? tpl.slots[i] : undefined;
      if (slot && this.addAtSlot(mg, hwnd, slot, stack, info)) return;
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
    this.touch(hwnd); // now the most recent (top-most in stack mode)
    this.flush();
    this.emitSnapshot();
  }

  exportConfig(): AppConfig {
    const layouts: Record<string, unknown> = { ...this.storedLayouts };
    for (const [id, mg] of this.grids) layouts[id] = mg.grid.toJSON();
    return {
      version: 5,
      grids: [...this.gridSettings.values()].map((g) => ({ ...g })),
      templates: [...this.templates],
      exclusions: [...this.exclusions],
      layouts,
      hotkey: this.hotkey,
      autostart: this.autostart,
      paused: this.paused,
      appRules: this.appRuleList(),
      views: this.views.map((v) => copyView(v)),
      startupViewId: this.startupViewId,
      autoCheckUpdates: this.autoCheckUpdates,
      suppressWindowsSnap: this.suppressWindowsSnap,
      windowsSnapOriginal: this.windowsSnapOriginal,
    };
  }

  /** Deep-copied rule list in insertion order (snapshot + export). */
  private appRuleList(): AppRule[] {
    return [...this.appRules.values()].map((r) => ({ ...r, slot: { ...r.slot } }));
  }

  /**
   * Contract extension (Task 18): shell preferences. `paused` mirrors Rust's
   * authoritative pause flag (the host feeds `paused-changed` events here so
   * the state persists and the settings UI updates via the snapshot);
   * `autostart` and `hotkey` are the settings-window General toggles, which
   * Rust reads back out of the persisted config (autostart registration,
   * hotkey re-bind); `autoCheckUpdates` is the Updates card's toggle, which
   * the host's updater driver reads back through `exportConfig()`. Only
   * actual changes re-emit a snapshot; an empty hotkey is ignored (the
   * accelerator must stay non-empty per contract C1).
   *
   * Pause also freezes the view-claim window (spec v0.2 §3): the 120 s
   * deadline is wall-clock, but pause suppresses every `window-appeared` at
   * the tracker, so a pause spanning the window would consume it without a
   * single claim ever getting a chance — the persisted-pause + startup-view
   * boot is exactly that case. Resuming pushes the deadline out by the
   * paused span instead.
   */
  setShellPrefs(prefs: {
    paused?: boolean;
    autostart?: boolean;
    hotkey?: string;
    autoCheckUpdates?: boolean;
    suppressWindowsSnap?: boolean;
  }): void {
    let changed = false;
    if (prefs.paused !== undefined && prefs.paused !== this.paused) {
      this.paused = prefs.paused;
      if (this.paused) {
        this.pausedSince = this.now();
      } else {
        // Claims are only ever consumed by `windowAppeared`, which the shell
        // suppresses while paused — give the window back the paused span so a
        // long pause cannot silently eat it. Claims that had already lapsed
        // when the pause began stay lapsed.
        if (
          this.pausedSince !== null &&
          this.pendingClaims.length > 0 &&
          this.claimsDeadline > this.pausedSince
        ) {
          this.claimsDeadline += this.now() - this.pausedSince;
        }
        this.pausedSince = null;
      }
      changed = true;
    }
    if (prefs.autostart !== undefined && prefs.autostart !== this.autostart) {
      this.autostart = prefs.autostart;
      changed = true;
    }
    if (
      prefs.autoCheckUpdates !== undefined &&
      prefs.autoCheckUpdates !== this.autoCheckUpdates
    ) {
      this.autoCheckUpdates = prefs.autoCheckUpdates;
      changed = true;
    }
    if (
      prefs.suppressWindowsSnap !== undefined &&
      prefs.suppressWindowsSnap !== this.suppressWindowsSnap
    ) {
      this.suppressWindowsSnap = prefs.suppressWindowsSnap;
      // The OS side effect happens in Rust when the resulting config write
      // is synced (shell::sync_from_config); the brain only persists intent.
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

  /**
   * Contract extension (Task 19): replace the exclusion list. Entries are
   * normalized (trim, lowercase, dedupe, empties dropped). Every managed
   * window of a newly excluded exe is unmanaged on the spot: its tile is
   * removed and the window stays exactly where it is — no move is emitted
   * for it or its neighbors (no auto-compact, same as minimize). Removing an
   * exclusion re-manages nothing by itself: the tracker's resync re-announces
   * those windows through the normal `window-appeared` flow. A normalized
   * list identical to the current one is a no-op (no snapshot).
   */
  setExclusions(exes: string[]): void {
    const next = new Set<string>();
    for (const e of exes) {
      const exe = e.trim().toLowerCase();
      if (exe.length > 0) next.add(exe);
    }
    const same =
      next.size === this.exclusions.size &&
      [...next].every((e) => this.exclusions.has(e));
    if (same) return;
    this.exclusions = next;

    for (const [hwnd, info] of [...this.windows]) {
      if (!next.has(info.exe)) continue;
      this.cancelDrag(hwnd);
      const gridId = this.tileGrid.get(hwnd);
      if (gridId !== undefined) {
        this.grids.get(gridId)?.grid.removeTile(hwnd);
        this.tileGrid.delete(hwnd);
      }
      this.floating.delete(hwnd);
      this.remembered.delete(hwnd);
      this.windows.delete(hwnd);
      this.recency.delete(hwnd);
      this.appliedRects.delete(hwnd);
    }
    this.flush(); // removals shift nothing (gravity 'none'); defensive only
    this.emitSnapshot();
  }

  /**
   * Contract extension (spec v0.2 §2): save a per-app placement rule. The
   * exe is normalized (trim, lowercase); `gridId: null` means any grid; the
   * slot must be an integer rect at a non-negative origin, ≥1×1 — but it is
   * NOT bounded to any grid's dims (it clamps into the target grid's
   * current dims when it fires). One rule per (exe, gridId): saving again
   * overwrites. Never moves any window — rules apply on `windowAppeared`
   * only, so already-managed windows stay exactly where they are. Invalid
   * input and an identical existing rule are silent no-ops (no snapshot).
   */
  setAppRule(rule: AppRule): void {
    const normalized = normalizeAppRule(rule);
    if (!normalized) return;
    const key = appRuleKey(normalized.exe, normalized.gridId);
    const prev = this.appRules.get(key);
    if (prev && sameSlot(prev.slot, normalized.slot)) return;
    this.appRules.set(key, normalized);
    this.emitSnapshot();
  }

  /**
   * Contract extension (spec v0.2 §2): remove the rule stored for exactly
   * this (exe, gridId) scope. Returns whether one existed; a miss emits no
   * snapshot. Never moves any window.
   */
  removeAppRule(exe: string, gridId: string | null): boolean {
    const removed = this.appRules.delete(appRuleKey(exe.trim().toLowerCase(), gridId));
    if (removed) this.emitSnapshot();
    return removed;
  }

  /**
   * Contract extension (spec v0.2 §3): snapshot every *live* enabled grid's
   * settings (incl. gap/padding) and each tiled window's exe+slot as a named
   * view. Exes, not hwnds — the view survives a reboot. The id is
   * `view:<n>` with the smallest n not already taken (template convention).
   * Throws when no grid is live, like captureTemplate.
   */
  captureView(name: string): View {
    if (this.grids.size === 0) {
      throw new Error('captureView: no enabled grid to capture');
    }
    const grids: ViewGrid[] = [];
    for (const mg of this.grids.values()) {
      const assignments: ViewAssignment[] = [];
      for (const t of mg.grid.tiles) {
        const info = this.windows.get(t.id);
        if (!info) continue;
        assignments.push({ exe: info.exe, slot: tileSlotOf(t) });
      }
      grids.push({
        settings: { ...mg.settings, monitorIds: [...mg.settings.monitorIds] },
        assignments,
      });
    }
    const taken = new Set(this.views.map((v) => v.id));
    let n = 1;
    while (taken.has(`view:${n}`)) n++;
    const trimmed = name.trim();
    const view: View = {
      id: `view:${n}`,
      name: trimmed.length > 0 ? trimmed : `View ${n}`,
      grids,
    };
    this.views.push(view);
    this.emitSnapshot();
    return copyView(view);
  }

  /**
   * Contract extension (spec v0.2 §3): apply a view. Reconfigures every view
   * grid to its captured settings (via enableGrid: overlapping grids tear
   * down, an absent monitor leaves the grid inert until replug), registers
   * every assignment as a pending claim for CLAIM_WINDOW_MS, then re-places
   * the given window sweep: first-come-first-claimed by exe, everything
   * unmatched auto-places (app rules do not fire here — they are for
   * genuinely new windows). Windows tiled on grids outside the view are left
   * exactly where they are. Returns false (no emissions) for an unknown id.
   * Both the startup path and the settings card's "Apply now" run through
   * here, so they share one claim mechanism.
   */
  applyView(viewId: string, windows: WindowInfo[] = []): boolean {
    const view = this.views.find((v) => v.id === viewId);
    if (!view) return false;
    for (const vg of view.grids) {
      // Empty sweep on purpose: placement is deferred to the claim pass
      // below, which knows about assignments.
      this.enableGrid({ ...vg.settings, enabled: true }, []);
    }
    this.pendingClaims = view.grids.flatMap((vg) =>
      vg.assignments.map(
        (a): PendingClaim => ({
          gridId: vg.settings.id,
          exe: a.exe,
          slot: { ...a.slot },
          claimed: false,
        }),
      ),
    );
    this.claimsDeadline = this.now() + CLAIM_WINDOW_MS;
    for (const w of windows) {
      if (w.minimized) continue;
      if (this.exclusions.has(w.exe)) continue;
      if (this.tileGrid.has(w.hwnd) || this.floating.has(w.hwnd)) continue;
      const mg = this.gridForMonitor(w.monitorId);
      this.windows.set(w.hwnd, { ...w });
      if (this.claimWindow(w)) continue;
      if (mg) {
        this.placeWindow(mg, w);
      } else {
        this.windows.delete(w.hwnd);
      }
    }
    this.flush();
    this.emitSnapshot();
    return true;
  }

  /**
   * Contract extension (spec v0.2 §3): rename a view. The name is trimmed;
   * empty names, unknown ids and no-op renames return false with no
   * snapshot.
   */
  renameView(viewId: string, name: string): boolean {
    const view = this.views.find((v) => v.id === viewId);
    const trimmed = name.trim();
    if (!view || trimmed.length === 0 || view.name === trimmed) return false;
    view.name = trimmed;
    this.emitSnapshot();
    return true;
  }

  /**
   * Contract extension (spec v0.2 §3): delete a view. Returns whether one
   * existed (a miss emits no snapshot). Deleting the startup view resets
   * `startupViewId` to null; already-registered pending claims are left to
   * run out — they carry no view reference.
   */
  deleteView(viewId: string): boolean {
    const idx = this.views.findIndex((v) => v.id === viewId);
    if (idx === -1) return false;
    this.views.splice(idx, 1);
    if (this.startupViewId === viewId) this.startupViewId = null;
    this.emitSnapshot();
    return true;
  }

  /**
   * Contract extension (spec v0.2 §3): choose the view applied on app launch
   * (null = none — the settings card's "load at startup" radio). An unknown
   * id and a repeat assignment are silent no-ops.
   */
  setStartupView(viewId: string | null): void {
    if (viewId !== null && !this.views.some((v) => v.id === viewId)) return;
    if (this.startupViewId === viewId) return;
    this.startupViewId = viewId;
    this.emitSnapshot();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Whether pending claims are live, lazily clearing a lapsed or fully
   * consumed set (spec v0.2 §3: after timeout or all-claimed, normal rules
   * resume).
   */
  private claimsActive(): boolean {
    if (this.pendingClaims.length === 0) return false;
    if (
      this.now() >= this.claimsDeadline ||
      this.pendingClaims.every((c) => c.claimed)
    ) {
      this.pendingClaims = [];
      return false;
    }
    return true;
  }

  /**
   * Try to place `w` via the first unclaimed matching assignment (its
   * `WindowInfo` must already be in `this.windows`). The claim slot clamps
   * into the target grid's current dims; a slot the grid cannot take (dead
   * space, failed displacement) leaves the claim open and falls through to
   * the next matching one. Returns whether a claim placed the window.
   */
  private claimWindow(w: WindowInfo): boolean {
    if (!this.claimsActive()) return false;
    for (const c of this.pendingClaims) {
      if (c.claimed || c.exe !== w.exe) continue;
      const target = this.grids.get(c.gridId);
      if (!target) continue;
      const dims = this.dims(target.settings);
      const slot = clampSlot(c.slot, dims.cols, dims.rows);
      if (
        !this.addAtSlot(target, w.hwnd, slot, target.settings.mode === 'stack', w)
      ) {
        continue;
      }
      c.claimed = true;
      this.touch(w.hwnd);
      return true;
    }
    return false;
  }

  /** Mark `hwnd` as the most recently interacted-with window. */
  private touch(hwnd: Hwnd): void {
    this.recency.set(hwnd, ++this.recencyCounter);
  }

  private recencyOf(hwnd: Hwnd): number {
    return this.recency.get(hwnd) ?? 0;
  }

  /**
   * Stack → in-flow (push/reflow): re-add every resizable tile in recency
   * order, most recent first so it claims its slot outright (preferentially).
   * Older tiles keep their slot if still free, else first-fit, else
   * displacement as a last resort; tiles that no longer fit become floating.
   * Non-resizable windows stay absolute (spec: always absolute).
   */
  private convertToInFlow(mg: ManagedGrid): void {
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
   * Re-place every tile of `mg` whose slot is no longer usable, after the
   * dead-space set was recomputed under it (spec v0.2 §1 × §5.7: a spanning
   * grid's dead cells depend on `cellRect`, so a gap/padding change alone can
   * move a cell into the seam). Most-recent-first so it wins contested cells,
   * then the same fallback chain as `reflowGrid`: nearest usable slot →
   * first-fit / displacement → floating. A no-op when nothing was stranded.
   */
  private repairDeadSpace(mg: ManagedGrid): void {
    const stranded = mg.grid.tiles
      .map((t) => ({ id: t.id, slot: tileSlotOf(t) }))
      .filter((t) => !this.usable(mg, t.slot))
      .sort((a, b) => this.recencyOf(b.id) - this.recencyOf(a.id));
    if (stranded.length === 0) return;
    if (this.drag && stranded.some((t) => t.id === this.drag?.hwnd)) this.cancelDrag();

    for (const t of stranded) {
      mg.grid.removeTile(t.id);
      this.tileGrid.delete(t.id);
      this.appliedRects.delete(t.id);
    }
    const stack = mg.settings.mode === 'stack';
    for (const t of stranded) {
      const info = this.windows.get(t.id);
      const target = this.nearestUsable(mg, t.slot);
      if (target && this.addAtSlot(mg, t.id, target, stack, info)) continue;
      if (info && this.placeWindow(mg, info)) continue;
      this.floating.set(t.id, mg.settings.id);
    }
  }

  /**
   * Add a window's tile at an exact slot (template apply). Stack grids and
   * non-resizable windows get an absolute pinned tile (never collides);
   * in-flow tiles take the slot outright when free, else displace. Returns
   * whether the tile was created.
   */
  private addAtSlot(
    mg: ManagedGrid,
    hwnd: Hwnd,
    slot: Slot,
    stack: boolean,
    info: WindowInfo | undefined,
  ): boolean {
    // Dead-space slots are never assigned (spec §5.7); the caller falls back
    // to normal placement, which snaps to the nearest usable slot.
    if (!this.usable(mg, slot)) return false;
    if (stack || !(info?.resizable ?? true)) {
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

  /**
   * Fresh Griddle instance for a grid's current dims over `mon`'s work area.
   * Unit sizes come from the effective (padded, gapped) area for parity with
   * cellRect; the brain never feeds pixels to Griddle, so a later setSpacing
   * doesn't need to rebuild the instance — cell logic is size-independent.
   */
  private newGrid(settings: GridSettings, mon: MonitorInfo): Grid {
    const eff = effectiveSpacing(mon, this.dims(settings));
    return new Grid({
      cols: settings.cols,
      rows: settings.rows,
      unitWidth: (eff.width - eff.gapX * (settings.cols - 1)) / settings.cols,
      unitHeight: (eff.height - eff.gapY * (settings.rows - 1)) / settings.rows,
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
    return {
      cols: settings.cols,
      rows: settings.rows,
      gap: settings.gap ?? 0,
      padding: settings.padding ?? 0,
    };
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
   * Ghosts for the current drag over an in-flow (push/reflow) grid. Reflow
   * grids preview the *solver's* answer, because that is what the drop will
   * commit; when the solver declines, so does the commit — both fall back to
   * the push simulation, so the overlay can never promise an arrangement the
   * release does not deliver.
   */
  private previewGhosts(
    target: ManagedGrid,
    d: DragState,
    footprint: Slot,
    resizing: boolean,
  ): GhostMove[] {
    if (target.settings.mode === 'reflow') {
      const plan = this.solveReflow(target, d.hwnd, footprint);
      if (plan) return this.ghostsFromPlan(target, plan);
    }
    return this.simulateGhosts(target, d, footprint, resizing);
  }

  /**
   * Ask the minimal-move solver how to fit `hwnd` at exactly `slot` on a
   * reflow-mode grid. Returns the displaced tiles' new origins (empty when
   * the slot was already free), or `null` when the caller must fall back to
   * push: an unusable target slot, nonsense the solver refuses, a board it
   * cannot solve inside its node cap, or — on a spanning grid, whose dead
   * cells the solver knows nothing about — a solution that would strand a
   * tile in the seam.
   *
   * Pure: it reads the live grid and mutates nothing, so preview and commit
   * can both call it and get the same answer.
   */
  private solveReflow(mg: ManagedGrid, hwnd: Hwnd, slot: Slot): ReflowMove[] | null {
    if (!this.usable(mg, slot)) return null;
    const tiles: ReflowTile[] = [];
    for (const t of mg.grid.tiles) {
      if (t.id === hwnd) continue;
      // Absolute tiles (stack leftovers, non-resizable windows) sit outside
      // the flow: Griddle's own collision queries skip them, and so does the
      // solver's board — they neither block a drop nor get pushed by one.
      if (!isInFlow(t)) continue;
      tiles.push({ id: t.id, col: t.col, row: t.row, w: t.w, h: t.h });
    }
    const dims = this.dims(mg.settings);
    const result = solveMinimalMoves(
      tiles,
      { id: hwnd, ...slot },
      { cols: dims.cols, rows: dims.rows },
    );
    if (!result || !result.ok) return null;
    if (mg.unusable.size > 0) {
      const sizes = new Map(tiles.map((t) => [t.id, t]));
      for (const m of result.moves) {
        const t = sizes.get(m.id);
        if (!t || !this.usable(mg, { col: m.col, row: m.row, w: t.w, h: t.h })) {
          return null;
        }
      }
    }
    return result.moves;
  }

  /** Turn a solver plan into preview ghosts (from = the tile's live slot). */
  private ghostsFromPlan(mg: ManagedGrid, moves: ReflowMove[]): GhostMove[] {
    const ghosts: GhostMove[] = [];
    for (const m of moves) {
      const t = mg.grid.getTile(m.id);
      if (!t) continue;
      const from = tileSlotOf(t);
      const to: Slot = { col: m.col, row: m.row, w: t.w, h: t.h };
      if (!sameSlot(from, to)) ghosts.push({ hwnd: m.id, from, to });
    }
    return ghosts;
  }

  /**
   * Reflow-mode commit: `hwnd` takes `snapped` exactly and the solved plan
   * moves the displaced neighbors out of its way — all of it landing in the
   * one `flush()` the caller runs, so the whole rearrangement is a single
   * batch of real window moves.
   *
   * Works for a tile already on this grid (drop / editor move / resize) and
   * for one arriving from another grid. Returns false without touching the
   * grid when the solver declines, so the caller falls back to push.
   */
  private commitReflow(mg: ManagedGrid, hwnd: Hwnd, snapped: Slot): boolean {
    const moves = this.solveReflow(mg, hwnd, snapped);
    if (!moves) return false;

    // Bulk-apply through Griddle's own snapshot/restore, which installs an
    // arrangement wholesale: no displacement rules run, no tile is removed
    // and re-added (which would reshuffle placement order for no reason), and
    // the grid is never observed in a half-applied state.
    const next = mg.grid.snapshotTiles();
    for (const m of moves) {
      const t = next.get(m.id);
      if (!t) return false; // grid changed under the plan; leave it alone
      t.col = m.col;
      t.row = m.row;
    }
    const dragged = next.get(hwnd);
    if (dragged) {
      dragged.col = snapped.col;
      dragged.row = snapped.row;
      dragged.w = snapped.w;
      dragged.h = snapped.h;
    } else {
      next.set(hwnd, {
        id: hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
      });
    }
    mg.grid.restoreTiles(next);
    this.tileGrid.set(hwnd, mg.settings.id);
    return true;
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

    // Reflow mode: the drop lands where it was aimed and the neighbors
    // reorganise around it. A declined solve falls through to the push path
    // below, which is exactly what the preview showed.
    if (mg.settings.mode === 'reflow' && isInFlow(tile)) {
      if (this.commitReflow(mg, hwnd, snapped)) return;
    }

    if (tile.position === 'absolute') {
      const info = this.windows.get(hwnd);
      if ((info?.resizable ?? true) && (snapped.w !== tile.w || snapped.h !== tile.h)) {
        // Stack-mode resize: footprint snaps to cells too. Absolute tiles
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

    // Absolute in the target iff the target is stack-mode or the window
    // itself is non-resizable (d.absolute may just mean "source was stack").
    const nonResizable = info ? !info.resizable : d.absolute;
    if (target.settings.mode === 'stack' || nonResizable) {
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
    // Reflow mode: same rule as a same-grid drop — the arriving window takes
    // the aimed cells and the target grid's tiles reorganise around it.
    if (target.settings.mode === 'reflow' && this.commitReflow(target, hwnd, snapped)) {
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
   * Commit an intake drag (spec 2026-08-20): a floating window dropped over
   * a grid either becomes a tile there — under the grid's own mode, exactly
   * like a cross-grid transfer — or stays floating where the user left it,
   * with the overlay saying why. A drop over ungridded space is a silent
   * no-op: the user did not aim at a grid.
   */
  private intakeDrop(
    d: DragState,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const hwnd = d.hwnd;
    // Same commit anchor as managed drops: re-run the slot function the
    // preview used, cursor extrapolated by any post-sample movement.
    const lp = d.lastDragPos;
    const cursorX = lp ? lp.cursorX + (rect.x - lp.x) : rect.x + rect.width / 2;
    const cursorY = lp ? lp.cursorY + (rect.y - lp.y) : rect.y + rect.height / 2;
    const hitMon = this.monitorAt(cursorX, cursorY);

    // The window physically sits where the user dropped it either way.
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

    const at = this.gridAtPoint(cursorX, cursorY);
    if (!at) return; // ungridded target: stays floating, says nothing
    const computed = this.dragFootprint(at.mg, at.mon, d, cursorX, cursorY, rect);
    if (!computed) return;
    const target = at.mg;
    const snapped = computed.footprint;

    const dropInfo = this.windows.get(hwnd);
    const dropUnfittable = this.minUnfittable(at.mon, this.dims(target.settings), dropInfo);
    if (dropUnfittable || this.placementRefused(target, d, snapped)) {
      // Armed drop on the make-room pill (spec 2026-08-20): split the tile
      // the user aimed at and take the donated half — the same computation
      // the armed preview ghosted.
      const minCells = this.minCellsFor(at.mon, this.dims(target.settings), dropInfo);
      const plan = dropUnfittable ? null : this.makeRoomPlan(target, snapped, minCells);
      const swPlan = dropUnfittable ? null : this.swapPlan(target, snapped, minCells);
      const pills = this.pillRects(
        at.mon,
        this.dims(target.settings),
        snapped,
        plan !== null,
        swPlan !== null,
      );
      // A drop with no drag samples is a click, not an aimed gesture — the
      // bands must never commit on it (they cover enough of the screen that
      // a stationary release would often land inside one).
      const sampled = d.lastDragPos !== null;
      const inRect = (r: { x: number; y: number; width: number; height: number } | undefined) =>
        sampled &&
        r !== undefined &&
        cursorX >= r.x &&
        cursorX <= r.x + r.width &&
        cursorY >= r.y &&
        cursorY <= r.y + r.height;
      if (plan && inRect(pills.makeRoom) && this.commitMakeRoom(target, hwnd, plan)) {
        this.tileGrid.set(hwnd, target.settings.id);
        this.floating.delete(hwnd);
        this.touch(hwnd);
        this.appliedRects.delete(hwnd);
        this.flush();
        this.emitSnapshot();
        return;
      }
      if (swPlan && inRect(pills.swap) && this.commitSwap(target, hwnd, swPlan, dropInfo)) {
        this.tileGrid.set(hwnd, target.settings.id);
        this.floating.delete(hwnd);
        this.touch(hwnd);
        this.appliedRects.delete(hwnd);
        this.flush();
        this.emitSnapshot();
        // After our state is consistent and the moves are flushed: ask the
        // shell to minimize the swapped-out window. The tracker's minimize
        // event that follows finds its tile already released — idempotent.
        this.cb.onMinimize?.(swPlan.victim);
        return;
      }
      // The refusal the preview showed, restated at the drop so releasing
      // the button is answered too. The host hides the overlay on a timer.
      this.cb.onPreview({
        gridId: target.settings.id,
        visible: true,
        footprint: null,
        ghosts: [],
        refusal: dropUnfittable ? REFUSAL_MIN_SIZE : REFUSAL_NO_ROOM,
      });
      return;
    }

    const resizable = info?.resizable ?? true;
    let placed = false;
    if (target.settings.mode === 'stack' || !resizable) {
      target.grid.addTile({
        id: hwnd,
        col: snapped.col,
        row: snapped.row,
        w: snapped.w,
        h: snapped.h,
        position: 'absolute',
        pinned: { x: snapped.col, y: snapped.row },
      });
      placed = true;
    } else if (target.settings.mode === 'reflow' && this.commitReflow(target, hwnd, snapped)) {
      placed = true;
    } else {
      placed = !!this.runEngineOp(target, (g) =>
        g.addTileWithDisplacement({
          id: hwnd,
          col: snapped.col,
          row: snapped.row,
          w: snapped.w,
          h: snapped.h,
        }),
      );
    }
    if (!placed) {
      // placementRefused said yes but the engine said no (a spanning-grid
      // dead-space edge the dry-run cannot see). Same outcome as a refusal.
      this.cb.onPreview({
        gridId: target.settings.id,
        visible: true,
        footprint: null,
        ghosts: [],
        refusal: REFUSAL_NO_ROOM,
      });
      return;
    }

    this.tileGrid.set(hwnd, target.settings.id);
    this.floating.delete(hwnd);
    this.touch(hwnd);
    this.appliedRects.delete(hwnd);
    this.flush();
    this.emitSnapshot();
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

    const stack = mg.settings.mode === 'stack';
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
      if (stack || !w.resizable) {
        mg.grid.addTile({
          id: t.id,
          ...rect,
          position: 'absolute',
          pinned: { x: rect.col, y: rect.row },
        });
      } else {
        // In-flow restore (a tile stored as absolute by a stack-mode session
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
   * Spec v0.2 §2 placement precedence for a genuinely new window — fires on
   * `windowAppeared` only (restore-previous was already handled there):
   * grid-specific app rule → any-grid app rule → active template's first
   * empty slot → auto-place. A rule slot is clamped into the grid's current
   * dims; stack grids and non-resizable windows take it as an absolute
   * tile (overlap allowed), an occupied slot in push/reflow mode displaces
   * (`addTileWithDisplacement` at the rule slot), and a slot that cannot
   * take the tile (dead space, failed displacement) falls through to the
   * next precedence level.
   */
  private placeAppeared(mg: ManagedGrid, w: WindowInfo): void {
    const dims = this.dims(mg.settings);
    const stack = mg.settings.mode === 'stack';
    for (const rule of this.appRulesFor(w.exe, mg.settings.id)) {
      const slot = clampSlot(rule.slot, dims.cols, dims.rows);
      if (this.addAtSlot(mg, w.hwnd, slot, stack, w)) {
        this.touch(w.hwnd);
        return;
      }
    }
    const tplSlot = this.emptyTemplateSlot(mg);
    if (tplSlot && this.addAtSlot(mg, w.hwnd, tplSlot, stack, w)) {
      this.touch(w.hwnd);
      return;
    }
    this.placeWindow(mg, w);
  }

  /**
   * Rules matching a window of `exe` appearing on `gridId`, in precedence
   * order: the grid-specific rule first, the any-grid rule second (spec
   * v0.2 §2 — grid-specific beats any-grid; a rule scoped to a *different*
   * grid never matches).
   */
  private appRulesFor(exe: string, gridId: string): AppRule[] {
    const out: AppRule[] = [];
    const specific = this.appRules.get(appRuleKey(exe, gridId));
    if (specific) out.push(specific);
    const any = this.appRules.get(appRuleKey(exe, null));
    if (any) out.push(any);
    return out;
  }

  /**
   * First empty slot of the grid's active template (spec §5.4), or null.
   * Only consulted while the template's dims still match the grid's
   * (applyTemplate keeps them in sync and reflow clears the reference; a
   * stale config that disagrees is ignored). "Empty" means the slot
   * intersects no existing tile — including absolute ones, which Griddle's
   * `tilesIn` skips (docs/library-feedback.md) — and touches no dead-space
   * cell of a spanning grid.
   */
  private emptyTemplateSlot(mg: ManagedGrid): Slot | null {
    const id = mg.settings.activeTemplateId;
    if (id === null) return null;
    const tpl = this.templates.find((t) => t.id === id);
    if (!tpl || tpl.cols !== mg.settings.cols || tpl.rows !== mg.settings.rows) {
      return null;
    }
    for (const slot of tpl.slots) {
      if (!this.usable(mg, slot)) continue;
      if (!this.slotIntersectsTile(mg, slot)) return { ...slot };
    }
    return null;
  }

  /** Whether any tile of the grid (in-flow or absolute) overlaps `slot`. */
  private slotIntersectsTile(mg: ManagedGrid, slot: Slot): boolean {
    return mg.grid.tiles.some((t) => {
      const s = tileSlotOf(t);
      return (
        s.col < slot.col + slot.w &&
        slot.col < s.col + s.w &&
        s.row < slot.row + slot.h &&
        slot.row < s.row + s.h
      );
    });
  }

  /**
   * Place a window into a grid: absolute for non-resizable windows and for
   * stack-mode grids (snapped in place, overlap allowed), else first-fit in
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
    const need = this.minCellsFor(mon, dims, w);
    if (need.w > dims.cols || need.h > dims.rows) {
      // The minimum cannot fit even the whole grid: floating is the only
      // honest outcome (drags over this grid say so via REFUSAL_MIN_SIZE).
      this.floating.set(w.hwnd, mg.settings.id);
      return false;
    }
    const raw = snapRectToSlot(mon, dims, w);
    const grown: Slot = {
      col: Math.min(raw.col, dims.cols - Math.max(raw.w, need.w)),
      row: Math.min(raw.row, dims.rows - Math.max(raw.h, need.h)),
      w: Math.max(raw.w, need.w),
      h: Math.max(raw.h, need.h),
    };
    const snapped = this.nearestUsable(mg, grown);
    if (!snapped) {
      // Degenerate spanning grid with zero usable cells: nothing can place.
      this.floating.set(w.hwnd, mg.settings.id);
      return false;
    }

    if (!w.resizable || mg.settings.mode === 'stack') {
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

  /** Disable a grid: release the live instance and mark it not-enabled. */
  private teardownGrid(gridId: string): void {
    const settings = this.gridSettings.get(gridId);
    if (settings) this.gridSettings.set(gridId, { ...settings, enabled: false });
    this.releaseGrid(gridId);
  }

  /**
   * Drop a live grid instance and everything tracked under it, without
   * touching the enabled flag (monitor-unplug deactivation keeps the grid
   * enabled so it revives on replug). The layout snapshot is stored for that
   * revival — but an *empty* grid never clobbers a previously stored layout,
   * so a revive-with-no-sweep can't erase the slots a later re-enable with a
   * sweep would restore. No snapshot emit.
   */
  private releaseGrid(gridId: string): void {
    if (this.drag?.sourceGridId === gridId) this.cancelDrag();
    const mg = this.grids.get(gridId);
    if (!mg) return;
    if (mg.grid.tiles.length > 0 || this.storedLayouts[gridId] === undefined) {
      this.storedLayouts[gridId] = mg.grid.toJSON();
    }
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
   * (position and size) whether in flow or absolute (stack mode);
   * non-resizable absolute tiles keep the window's own size (position snap).
   */
  private desiredRect(mon: MonitorInfo, dims: GridDims, tile: Tile): Rect {
    const slot = tileSlotOf(tile);
    const cell = cellRect(mon, dims, slot);
    if (tile.position !== 'absolute') return cell;

    const info = this.windows.get(tile.id);
    if (!info || info.resizable) return cell;
    // Position-snapped windows keep their own size but stay inside the
    // effective (padded) area, matching every cell rect (spec v0.2 §1).
    const eff = effectiveSpacing(mon, dims);
    const width = Math.min(info.width, eff.width);
    const height = Math.min(info.height, eff.height);
    return {
      x: clamp(cell.x, eff.x, eff.x + eff.width - width),
      y: clamp(cell.y, eff.y, eff.y + eff.height - height),
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
      if (mg.settings.mode === 'stack') {
        // Stack order: bottom-to-top, top-most (most recent) last.
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
      exclusions: [...this.exclusions],
      appRules: this.appRuleList(),
      views: this.views.map((v) => copyView(v)),
      startupViewId: this.startupViewId,
      paused: this.paused,
    });
  }
}
