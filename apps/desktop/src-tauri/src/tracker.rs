//! Native window tracking. Task 10 implements the eligibility filter,
//! `EnumWindows` snapshotting, and the `SetWinEventHook` event pump; until
//! then the command reports no windows.

use crate::ipc::WindowInfo;

/// Contract §C2: `list_windows() -> WindowInfo[]`.
#[tauri::command]
pub fn list_windows() -> Vec<WindowInfo> {
    log::debug!("list_windows stub: returning empty list");
    Vec::new()
}
