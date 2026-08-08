//! App shell: tray, hotkey, pause, settings window (Tasks 13/18). Until then
//! `set_paused` logs and changes nothing.

/// Contract §C2: `set_paused(paused: bool)`.
#[tauri::command]
pub fn set_paused(paused: bool) {
    log::debug!("set_paused stub: ignoring paused={paused}");
}
