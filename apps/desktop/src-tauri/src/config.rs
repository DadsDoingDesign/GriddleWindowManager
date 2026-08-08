//! Config persistence. Task 12 implements atomic temp+rename writes in
//! `%APPDATA%/griddle-wm/`; until then reads report "no config" and writes
//! are dropped.

use crate::ipc::AppConfig;

/// Contract §C2: `read_config() -> AppConfig | null`.
#[tauri::command]
pub fn read_config() -> Option<AppConfig> {
    log::debug!("read_config stub: reporting no config");
    None
}

/// Contract §C2: `write_config(config: AppConfig)`.
#[tauri::command]
pub fn write_config(config: AppConfig) {
    log::debug!(
        "write_config stub: dropping config with {} grid(s)",
        config.grids.len()
    );
}
