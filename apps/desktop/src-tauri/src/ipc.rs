//! Contract §C1 serde mirror of `packages/brain/src/types.ts`, plus the §C2
//! event names. Field names serialize as camelCase to match the TS side
//! verbatim. Do not add event/command names here without extending the
//! contract file (`docs/superpowers/plans/2026-08-08-griddle-wm.md`) first.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Decimal string of a Win32 HWND (e.g. `"197412"`).
pub type Hwnd = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Stable id: device name + "@" + x + "," + y.
    pub id: String,
    /// Full monitor bounds, physical virtual-desktop pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Work area (excludes taskbar), physical virtual-desktop pixels.
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub dpi: u32,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub hwnd: Hwnd,
    pub title: String,
    /// Lowercase exe basename, e.g. "slack.exe".
    pub exe: String,
    /// DWM extended frame bounds, physical virtual-desktop pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub monitor_id: String,
    pub minimized: bool,
    pub resizable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub col: i32,
    pub row: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridMode {
    Collision,
    Overlay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSettings {
    /// `grid:<monitorId>` or `grid:span:<sorted-monitor-ids-joined-by-+>`.
    pub id: String,
    pub monitor_ids: Vec<String>,
    pub cols: u32,
    pub rows: u32,
    pub mode: GridMode,
    pub enabled: bool,
    pub active_template_id: Option<String>,
    /// Space between adjacent cells, physical px 0..=64 (spec v0.2 §1).
    /// Defaults to 0 so v1 configs without the field still deserialize.
    #[serde(default)]
    pub gap: u32,
    /// Inset of the usable area from every work-area edge, physical px
    /// 0..=64 (spec v0.2 §1). Defaults like `gap`.
    #[serde(default)]
    pub padding: u32,
}

/// Per-app default placement (spec v0.2 §2). `exe` is the lowercase
/// basename; `grid_id: None` means the rule matches any grid. One rule per
/// (exe, gridId); the slot clamps into the target grid's current dims when
/// the rule fires (on `window-appeared` only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRule {
    pub exe: String,
    pub grid_id: Option<String>,
    pub slot: Slot,
}

/// One remembered window of a startup view (spec v0.2 §3): the lowercase
/// exe basename and the slot it occupied when the view was captured. Views
/// store exes, not hwnds — hwnds die with a reboot, exes come back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAssignment {
    pub exe: String,
    pub slot: Slot,
}

/// One grid of a view: its full settings plus the windows assigned to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewGrid {
    pub settings: GridSettings,
    pub assignments: Vec<ViewAssignment>,
}

/// Startup view (spec v0.2 §3): a named snapshot of every enabled grid's
/// settings and each tiled window's exe+slot. Opaque to Rust beyond
/// (de)serialization — capture/apply/claims live in the brain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    pub grids: Vec<ViewGrid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub cols: u32,
    pub rows: u32,
    pub slots: Vec<Slot>,
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub hwnd: Hwnd,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLayout {
    pub moves: Vec<Move>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostMove {
    pub hwnd: Hwnd,
    pub from: Slot,
    pub to: Slot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub grid_id: String,
    pub visible: bool,
    /// Where the dragged window would land; `None` serializes as `null`.
    pub footprint: Option<Slot>,
    /// Neighbor reflow preview (collision mode).
    pub ghosts: Vec<GhostMove>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragPos {
    pub hwnd: Hwnd,
    pub cursor_x: i32,
    pub cursor_y: i32,
    /// Live extended-frame rect during the drag.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileSnapshot {
    pub hwnd: Hwnd,
    pub title: String,
    pub exe: String,
    pub slot: Slot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingWindow {
    pub hwnd: Hwnd,
    pub title: String,
    pub exe: String,
}

/// Payload of the `state-snapshot` event (brain -> settings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub grids: Vec<GridSettings>,
    pub templates: Vec<Template>,
    /// gridId -> tiles in placement order.
    pub tiles: HashMap<String, Vec<TileSnapshot>>,
    pub floating: Vec<FloatingWindow>,
    /// Live exclusion list, lowercase exe names (Task 19 extension).
    pub exclusions: Vec<String>,
    /// Live per-app placement rules (spec v0.2 §2 extension).
    pub app_rules: Vec<AppRule>,
    /// Live startup views (spec v0.2 §3 extension).
    pub views: Vec<View>,
    /// View applied on app launch; `None` serializes as `null`.
    pub startup_view_id: Option<String>,
    pub paused: bool,
}

/// Schema for `%APPDATA%/griddle-wm/config.json`. Version 3 (spec §7 "Update
/// checks"): adds `auto_check_updates` over v2, which itself added
/// `app_rules`, `views` and `startup_view_id` over v1. The loader in
/// `config.rs` migrates older files in place via the serde defaults below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    pub grids: Vec<GridSettings>,
    pub templates: Vec<Template>,
    /// Lowercase exe names.
    pub exclusions: Vec<String>,
    /// gridId -> Grid.toJSON() snapshot (opaque to Rust).
    pub layouts: HashMap<String, serde_json::Value>,
    /// Default "Ctrl+Super+G".
    pub hotkey: String,
    pub autostart: bool,
    pub paused: bool,
    /// Per-app placement rules (spec v0.2 §2). Defaults to empty so every
    /// v1 config written before the field existed keeps deserializing
    /// (same migration pattern as `GridSettings::gap`/`padding`).
    #[serde(default)]
    pub app_rules: Vec<AppRule>,
    /// Startup views (spec v0.2 §3). Defaults like `app_rules`.
    #[serde(default)]
    pub views: Vec<View>,
    /// View applied on app launch (spec v0.2 §3); absent/`null` = none.
    #[serde(default)]
    pub startup_view_id: Option<String>,
    /// Check GitHub Releases for a newer Griddle Window Manager (spec §7 "Update
    /// checks"). The only field in this file that can cause an outbound
    /// request, so it defaults to **false** and stays false for every v1/v2
    /// config, which never carried it (same migration pattern as
    /// `app_rules`/`views`).
    #[serde(default)]
    pub auto_check_updates: bool,
}

/// Payload of the hwnd-only events (`window-destroyed`, `window-minimized`,
/// `movesize-start`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwndPayload {
    pub hwnd: Hwnd,
}

/// Payload of the `tray-toggle-grid` event (contract §C2: `{monitorId}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayToggleGrid {
    pub monitor_id: String,
}

/// Payload of the `movesize-end` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSizeEnd {
    pub hwnd: Hwnd,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Contract §C2 event names (Rust -> webviews and brain -> overlays/settings).
pub mod events {
    pub const WINDOW_APPEARED: &str = "window-appeared";
    pub const WINDOW_DESTROYED: &str = "window-destroyed";
    pub const WINDOW_MINIMIZED: &str = "window-minimized";
    pub const WINDOW_RESTORED: &str = "window-restored";
    pub const MOVESIZE_START: &str = "movesize-start";
    pub const DRAG_POS: &str = "drag-pos";
    pub const MOVESIZE_END: &str = "movesize-end";
    pub const MONITORS_CHANGED: &str = "monitors-changed";
    pub const HOTKEY_SETTINGS: &str = "hotkey-settings";
    pub const TRAY_TOGGLE_GRID: &str = "tray-toggle-grid";
    pub const PAUSED_CHANGED: &str = "paused-changed";
    pub const PREVIEW_STATE: &str = "preview-state";
    pub const STATE_SNAPSHOT: &str = "state-snapshot";
}
