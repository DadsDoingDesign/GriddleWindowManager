//! Monitor enumeration. Task 9 implements `EnumDisplayMonitors` +
//! `GetMonitorInfoW` + `GetDpiForMonitor` and the `WM_DISPLAYCHANGE` listener;
//! until then the command reports no monitors.

use crate::ipc::MonitorInfo;

/// Contract §C2: `list_monitors() -> MonitorInfo[]`.
#[tauri::command]
pub fn list_monitors() -> Vec<MonitorInfo> {
    log::debug!("list_monitors stub: returning empty list");
    Vec::new()
}
