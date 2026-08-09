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
}

export interface Slot {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface GridSettings {
  id: string;
  monitorIds: string[];
  cols: number;
  rows: number;
  mode: 'collision' | 'overlay';
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
  ghosts: GhostMove[]; // neighbor reflow preview (collision mode)
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
  // `GridSettings` gained `gap`/`padding`. The loaders (persist.ts and the
  // Rust mirror's serde defaults) migrate v1 configs in place — defaults
  // `appRules: [], views: [], startupViewId: null`, spacing absent-means-0.
  version: 2;
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
}
