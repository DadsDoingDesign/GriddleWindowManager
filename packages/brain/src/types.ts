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
export interface StateSnapshot {
  grids: GridSettings[];
  templates: Template[];
  tiles: Record<string, TileSnapshot[]>; // gridId -> tiles in placement order
  floating: FloatingWindow[];
  exclusions: string[];
  paused: boolean;
}

export interface AppConfig {
  // schema for %APPDATA%/griddle-wm/config.json
  version: 1;
  grids: GridSettings[];
  templates: Template[];
  exclusions: string[]; // lowercase exe names
  layouts: Record<string, unknown>; // gridId -> Grid.toJSON() snapshot
  hotkey: string; // default "Ctrl+Super+G"
  autostart: boolean;
  paused: boolean;
}
