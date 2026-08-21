// Contract §C1 — shared types, mirrored in apps/desktop/src-tauri/src/ipc.rs.
// Do not add IPC event/command names here without extending the contract first.

export type Hwnd = string; // decimal string of HWND

export interface MonitorInfo {
  id: string; // stable: device name + "@" + x + "," + y
  x: number;
  y: number;
  width: number;
  height: number; // full bounds, physical px
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  dpi: number;
  primary: boolean;
}

export interface WindowInfo {
  hwnd: Hwnd;
  title: string;
  exe: string; // lowercase basename, e.g. "slack.exe"
  x: number;
  y: number;
  width: number;
  height: number; // DWM extended frame bounds
  monitorId: string;
  minimized: boolean;
  resizable: boolean;
  /**
   * Spec 2026-08-20 (minimum window sizes): the window's minimum tracking
   * size in physical pixels (WM_GETMINMAXINFO), 0/absent when unknown.
   * Windows clamps any smaller resize at the OS level, so a footprint below
   * this overflows its cells — the brain must grant at least these pixels'
   * worth of cells or refuse.
   */
  minWidth?: number;
  minHeight?: number;
}

export interface Slot {
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * How a grid resolves a drop (contract C1, placement-mode extension).
 *
 * - `reflow` — the dropped window lands **exactly** where it was aimed and the
 *   other tiles reorganise around it, moving as few of them as possible
 *   (`solveMinimalMoves`). When the solver declines — unsolvable board, node
 *   cap, or a solution that would strand a tile in a spanning grid's dead
 *   space — the drop falls back to `push`, so a reflow grid is never *worse*
 *   than a push grid.
 * - `push` — Griddle's own displacement ruleset (`addTileWithDisplacement`):
 *   the drop shoves neighbors aside and may itself be refused. Shipped as
 *   `collision` through v0.2.0 and unchanged in behavior.
 * - `stack` — tiles snap to cells but may overlap; the most recently touched
 *   window sits on top. Shipped as `overlay` through v0.2.0, unchanged.
 *
 * `reflow` and `push` both keep tiles in Griddle's flow (they never overlap);
 * only `stack` makes them absolute. Non-resizable windows are absolute in
 * every mode.
 */
export type PlacementMode = 'reflow' | 'push' | 'stack';

/**
 * The v1–v3 spellings of the two original modes. Configs written by v0.1.0 /
 * v0.2.0 still carry them, and `normalizePlacementMode` (persist.ts) maps
 * them to `push` / `stack` on load — nothing downstream of the loaders ever
 * sees these values.
 */
export type LegacyPlacementMode = 'collision' | 'overlay';

export interface GridSettings {
  id: string;
  monitorIds: string[];
  cols: number;
  rows: number;
  mode: PlacementMode;
  enabled: boolean;
  activeTemplateId: string | null;
  /**
   * Spacing (spec v0.2 §1), physical px in 0..64. Optional for v1 configs
   * and payloads — absent means 0 everywhere (persist.ts defaults on load,
   * the Rust mirror uses `#[serde(default)]`). `gap` separates adjacent
   * cells; `padding` insets the usable area on all four sides.
   */
  gap?: number;
  padding?: number;
}

/**
 * Per-app default placement (spec v0.2 §2). `exe` is the lowercase basename
 * (e.g. "slack.exe"); `gridId: null` means the rule matches any grid. One
 * rule per (exe, gridId) — saving again overwrites. The slot is clamped into
 * the target grid's current dims when the rule fires (on `windowAppeared`
 * only, never retroactively).
 */
export interface AppRule {
  exe: string;
  gridId: string | null;
  slot: Slot;
}

/**
 * One remembered window of a startup view (spec v0.2 §3): the lowercase exe
 * basename and the slot it occupied when the view was captured. Views store
 * exes, not hwnds — hwnds die with a reboot, exes come back.
 */
export interface ViewAssignment {
  exe: string;
  slot: Slot;
}

/** One grid of a view: its full settings plus the windows assigned to it. */
export interface ViewGrid {
  settings: GridSettings;
  assignments: ViewAssignment[];
}

/**
 * Startup view (spec v0.2 §3): a named snapshot of every enabled grid's
 * settings (incl. gap/padding) and each tiled window's exe+slot. Applying a
 * view reconfigures the grids and registers the assignments as pending
 * claims: windows appearing within the claim window are first-come-first-
 * claimed per assignment, beating app rules; after the timeout (or once all
 * claims are taken) normal placement rules resume.
 */
export interface View {
  id: string;
  name: string;
  grids: ViewGrid[];
}

export interface Template {
  id: string;
  name: string;
  cols: number;
  rows: number;
  slots: Slot[];
  builtin: boolean;
}

export interface Move {
  hwnd: Hwnd;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApplyLayout {
  moves: Move[];
}

export interface GhostMove {
  hwnd: Hwnd;
  from: Slot;
  to: Slot;
}

export interface PreviewState {
  gridId: string;
  visible: boolean;
  footprint: Slot | null; // where the dragged window would land
  ghosts: GhostMove[]; // neighbor reflow preview (push + reflow modes)
  /**
   * Spec 2026-08-20: why the previewed placement cannot happen ("No room —
   * this grid is full"). Present only when the placement is impossible; the
   * overlay renders it so a refused gesture is never silent. Absent —
   * not null — on every possible placement, so payloads predating the field
   * compare equal.
   */
  refusal?: string;
  /**
   * Spec 2026-08-20 (make-room drop zone): the pill offered on a refused
   * placement whose aimed-at tile can donate half its span. Physical
   * virtual-desktop pixels; `armed` = the cursor is inside it, at which
   * point releasing commits the split the ghosts are previewing.
   */
  makeRoom?: {
    x: number;
    y: number;
    width: number;
    height: number;
    armed: boolean;
    /**
     * Present when the band is shown but cannot act — e.g. the aimed window
     * is already at its OS minimum size, so splitting it would only recreate
     * the overflow the minimum rules prevent. The overlay renders the band
     * dimmed with this text; it never arms and a drop on it commits nothing.
     */
    disabled?: string;
  };
  /**
   * Spec 2026-08-20 addendum (swap): the second pill — releasing inside it
   * minimizes the window occupying the aimed slot and places the dragged
   * window there instead. Offered when that slot satisfies the newcomer's
   * minimum size.
   */
  swap?: { x: number; y: number; width: number; height: number; armed: boolean };
}

export interface DragPos {
  hwnd: Hwnd;
  cursorX: number;
  cursorY: number;
  x: number;
  y: number;
  width: number;
  height: number; // live rect
}

export interface TileSnapshot {
  hwnd: Hwnd;
  title: string;
  exe: string;
  slot: Slot;
}

export interface FloatingWindow {
  hwnd: Hwnd;
  title: string;
  exe: string;
}

// Payload of the `state-snapshot` event (contract §C2).
// Contract extension (Task 3): `floating` lists eligible windows a full grid
// could not fit — they float free until space opens up.
// Contract extension (Task 19): `exclusions` carries the live exclusion list
// (lowercase exe names) so the settings editor always shows the truth.
// Contract extension (spec v0.2 §2): `appRules` carries the live per-app
// placement rules so the settings rules card always shows them.
// Contract extension (spec v0.2 §3): `views` + `startupViewId` carry the
// startup views so the settings Views card always shows the live list and
// the load-at-startup radio.
export interface StateSnapshot {
  grids: GridSettings[];
  templates: Template[];
  tiles: Record<string, TileSnapshot[]>; // gridId -> tiles in placement order
  floating: FloatingWindow[];
  exclusions: string[];
  appRules: AppRule[];
  views: View[];
  startupViewId: string | null;
  paused: boolean;
}

export interface AppConfig {
  // schema for %APPDATA%/griddle-wm/config.json
  // v2 (spec v0.2 §4): adds `appRules`, `views`, `startupViewId`;
  // `GridSettings` gained `gap`/`padding`.
  // v3 (spec §7 "Update checks"): adds `autoCheckUpdates`, default false.
  // v4 (placement modes): `GridSettings.mode` gains `reflow` and renames the
  // two original values — `collision` -> `push`, `overlay` -> `stack`. The
  // loaders rewrite the old spellings on read (persist.ts's
  // `normalizePlacementMode`, the Rust mirror's serde aliases), so a v1–v3
  // config keeps its exact behavior and simply persists the new name next
  // time it is written.
  // v5 (spec 2026-08-19): adds `suppressWindowsSnap` (default false) +
  // `windowsSnapOriginal` (default null), the Windows-snap suppression pair.
  // v6 (spec 2026-08-20 addendum): adds `manageSettingsWindow` (default
  // false) + `settingsWindowPos` (default null), for the settings pop-out.
  // The loaders (persist.ts and the Rust mirror's serde defaults) migrate
  // older configs in place — defaults `appRules: [], views: [],
  // startupViewId: null, autoCheckUpdates: false`, spacing absent-means-0.
  version: 6;
  grids: GridSettings[];
  templates: Template[];
  exclusions: string[]; // lowercase exe names
  layouts: Record<string, unknown>; // gridId -> Grid.toJSON() snapshot
  hotkey: string; // default "Ctrl+Super+G"
  autostart: boolean;
  paused: boolean;
  /** Per-app placement rules (spec v0.2 §2). */
  appRules: AppRule[];
  /** Startup views (spec v0.2 §3). */
  views: View[];
  /** View applied on app launch, or null for none (spec v0.2 §3). */
  startupViewId: string | null;
  /**
   * Check GitHub Releases for a newer Griddle Window Manager (spec §7
   * "Update checks").
   * **Default false** — this is the only setting in the whole config that
   * can cause an outbound request, so it stays off until the user turns it
   * on. Absent in every v1/v2 config, which reads as `false`.
   */
  autoCheckUpdates: boolean;
  /**
   * v5 (spec 2026-08-19): suppress Windows' mouse-driven snapping
   * (drag-to-edge dock/resize + Snap Layouts flyout) while Griddle runs, so
   * the OS stops fighting the grid over the drag gesture. Opt-in; the brain
   * only stores it — the Rust shell owns the OS side effects.
   */
  suppressWindowsSnap: boolean;
  /**
   * Pre-Griddle values of those OS settings, captured by Rust at the moment
   * of first suppression (restore-on-quit crash safety). Opaque to the brain:
   * it round-trips whatever Rust stamped; Rust re-stamps it on every write
   * (`enforce_authoritative_fields`), so a webview can never forge it.
   */
  windowsSnapOriginal: SnapState | null;
  /**
   * Let Griddle tile the settings pop-out like any other window. Off by
   * default: the pop-out is a *map* of the grid, and a map that occupies one
   * of the cells it describes is worse than no map. Stored here so the Rust
   * tracker can consult it when deciding own-process eligibility.
   */
  manageSettingsWindow: boolean;
  /**
   * Where the user last left the settings pop-out, in physical screen
   * pixels, or `null` while they have never moved it — which is what keeps
   * the tray-corner default applying on a fresh install and never after.
   */
  settingsWindowPos: WindowPos | null;
}

/** A remembered top-left corner in physical screen pixels. */
export interface WindowPos {
  x: number;
  y: number;
}

/** Captured pre-Griddle Windows snap settings (spec 2026-08-19 §3). */
export interface SnapState {
  dockMoving: boolean;
  snapSizing: boolean;
  snapAssistFlyout: boolean;
}
