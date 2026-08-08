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
