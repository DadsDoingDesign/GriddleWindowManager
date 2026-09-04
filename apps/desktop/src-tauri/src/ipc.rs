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
    /// The monitor's own name from its EDID, e.g. "Gigabyte M28U". `None`
    /// when the display has no EDID to read (virtual and remote displays
    /// often do not), in which case the UI falls back to the device name.
    #[serde(default)]
    pub model: Option<String>,
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
    /// Minimum tracking size (WM_GETMINMAXINFO), physical px; 0 = unknown.
    /// Windows clamps any smaller resize at the OS level, so the brain must
    /// grant at least this many pixels' worth of cells (spec 2026-08-20).
    #[serde(default)]
    pub min_width: i32,
    #[serde(default)]
    pub min_height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub col: i32,
    pub row: i32,
    pub w: i32,
    pub h: i32,
}

/// How a grid resolves a drop (contract C1, placement-mode extension).
///
/// `Reflow` lands the dropped window exactly where it was aimed and moves as
/// few neighbors as possible around it; `Push` is Griddle's displacement
/// ruleset; `Stack` lets windows overlap, most recent on top. Rust only
/// carries the value between disk and the brain — the behavior lives in
/// `packages/brain`.
///
/// The two `alias`es are the v1–v3 spellings (`collision` = `Push`,
/// `overlay` = `Stack`): every config written before v0.3.0 still
/// deserializes, and re-serializes under the new name. This is the whole
/// mode half of the v4 migration, and it mirrors
/// `normalizePlacementMode` in `packages/brain/src/persist.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridMode {
    Reflow,
    #[serde(alias = "collision")]
    Push,
    #[serde(alias = "overlay")]
    Stack,
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

/// Schema for `%APPDATA%/griddle-wm/config.json`. Version 4 (placement
/// modes): `GridSettings::mode` gains `reflow` and renames the two original
/// values (`collision` -> `push`, `overlay` -> `stack`, absorbed by the
/// serde aliases on [`GridMode`]) over v3, which added `auto_check_updates`
/// over v2, which itself added `app_rules`, `views` and `startup_view_id`
/// over v1. The loader in `config.rs` migrates older files in place via
/// those aliases and the serde defaults below.
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
    /// Suppress Windows' own mouse-driven snapping (drag-to-edge dock, edge
    /// resize, Snap Layouts flyout) while Griddle runs, so the OS stops
    /// fighting the grid over the same gesture (spec 2026-08-19). Off by
    /// default: changing a user's OS settings is opt-in. `Win+Arrow` is
    /// deliberately untouched.
    #[serde(default)]
    pub suppress_windows_snap: bool,
    /// The pre-Griddle values of those OS settings, captured at the moment of
    /// first suppression and persisted so restore survives a crash. `Some`
    /// exactly while Griddle believes it has modified the OS.
    #[serde(default)]
    pub windows_snap_original: Option<SnapState>,
    /// Let Griddle tile the settings pop-out like any other window
    /// (spec 2026-08-20 addendum). **Off by default**, and that default is
    /// the considered one: the pop-out is a *map* of the grid, and a map
    /// that occupies one of the cells it describes is worse than no map.
    /// It is a setting rather than a rule because the earlier field report
    /// - "do not exclude any windows from the grid" - was also right, just
    /// about a different window than this one became.
    #[serde(default)]
    pub manage_settings_window: bool,
    /// Where the user last left the settings pop-out, in physical screen
    /// pixels. `None` until they first move it, which is exactly what makes
    /// the tray-corner default apply on a fresh install and never again.
    #[serde(default)]
    pub settings_window_pos: Option<WindowPos>,
    /// Widget appearance. Absent means `"dark"`, which is what every config
    /// written before this field existed should keep looking like.
    #[serde(default)]
    pub theme: Option<String>,
    /// Spec 2026-08-31 (drag fill placement): how a window NEW to a grid
    /// (floating intake, or a tile crossing from another grid) gets its
    /// footprint — `"fill"` (largest open rectangle; the brain's default for
    /// an absent value) or `"size"` (the pre-v8 window-size snap). Stored and
    /// round-tripped only; the brain owns the semantics and the defaulting.
    #[serde(default)]
    pub drop_placement: Option<String>,
    /// Spec 2026-08-31: how a tile moving WITHIN its own grid gets its
    /// footprint — `"size"` (keep the span the user set; the brain's default
    /// for an absent value) or `"fill"`. Round-tripped like `drop_placement`.
    #[serde(default)]
    pub move_placement: Option<String>,
    /// Spec 2026-08-31 (second batch): what a maximize gesture does to a
    /// tiled window — `"expand"` (grow the tile in the grid; the brain's
    /// default for an absent value) or `"windows"` (real OS maximize).
    /// Round-tripped like `drop_placement`.
    #[serde(default)]
    pub maximize_behavior: Option<String>,
    /// Spec 2026-08-31 (second batch): what a refused new-to-grid drop does —
    /// `"split"` (auto-split the aimed tile; the brain's default for an
    /// absent value) or `"refuse"` (the banded refusal). Round-tripped like
    /// `drop_placement`.
    #[serde(default)]
    pub no_room_placement: Option<String>,
}

/// A remembered top-left corner in physical screen pixels. Signed because a
/// monitor left of or above the primary has negative virtual coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPos {
    pub x: i32,
    pub y: i32,
}

/// Captured pre-Griddle Windows snap settings (spec 2026-08-19 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapState {
    /// `SPI_GETDOCKMOVING` — drag a window to a screen edge to dock it.
    pub dock_moving: bool,
    /// `SPI_GETSNAPSIZING` — drag to the top/bottom edge to resize.
    pub snap_sizing: bool,
    /// `EnableSnapAssistFlyout` — the Snap Layouts flyout on maximize hover.
    pub snap_assist_flyout: bool,
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
    /// Spec 2026-08-31 (second batch): a tracked window was maximized —
    /// double-click, caption button or Win+Up, indistinguishable here. The
    /// brain decides whether that means expand-in-grid or leave-alone.
    pub const WINDOW_MAXIMIZED: &str = "window-maximized";
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
    /// Spec 2026-08-20 (window-eligibility audit): the actuator tried to
    /// move a tracked window and Windows refused with access-denied — the
    /// window belongs to an elevated process, so Griddle can never move it.
    /// The host surfaces this on the overlay; before this event the failure
    /// was a release-build log line nobody reads.
    pub const WINDOW_UNMOVABLE: &str = "window-unmovable";
    /// Spec 2026-08-20 addendum: the user dragged the settings pop-out. Rust
    /// owns the coordinates and stamps them on the next write, so this event
    /// carries no payload — it exists purely to ask the brain host for a
    /// config write, which is what makes a drag survive a quit.
    pub const SETTINGS_WINDOW_MOVED: &str = "settings-window-moved";
    /// The user is dragging a window Griddle has deliberately left out of the
    /// grid because it runs as administrator (log review 2026-08-21). The
    /// exclusion is correct but silent, and a drag is the moment the silence
    /// is confusing — the window simply does not tile and nothing says why.
    /// The host answers on the overlay of whichever grid covers that monitor.
    pub const ELEVATED_DRAG: &str = "elevated-drag";
}

/// Payload of [`events::ELEVATED_DRAG`]. Carries the monitor rather than a
/// grid because an elevated window is untracked and so has no tile to look a
/// grid up by — the host maps monitor to grid itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevatedDrag {
    pub hwnd: String,
    pub monitor_id: String,
    pub exe: String,
}
