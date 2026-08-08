//! Per-monitor drag overlay webviews. Task 15 creates the transparent
//! click-through windows; until then the commands log and show nothing.

/// Contract §C2: `show_overlay(monitor_id)`.
#[tauri::command]
pub fn show_overlay(monitor_id: String) {
    log::debug!("show_overlay stub: ignoring monitor {monitor_id}");
}

/// Contract §C2: `hide_overlay(monitor_id)`.
#[tauri::command]
pub fn hide_overlay(monitor_id: String) {
    log::debug!("hide_overlay stub: ignoring monitor {monitor_id}");
}
