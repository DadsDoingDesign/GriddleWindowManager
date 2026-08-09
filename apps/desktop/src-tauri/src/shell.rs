//! App shell: settings window (Task 13); tray, hotkey, pause come with
//! Task 18. Until then `set_paused` logs and changes nothing.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Label of the on-demand settings window (spec §4.3: route `/settings`).
pub const SETTINGS_LABEL: &str = "settings";

/// Create the settings window on demand, or re-front it if it already
/// exists. Called by the `show_settings` command now and by Task 18's
/// tray menu / global hotkey later.
pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        win.unminimize()?;
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("/settings".into()))
        .title("Griddle WM Settings")
        .inner_size(900.0, 720.0)
        .min_inner_size(560.0, 400.0)
        .center()
        .build()?;
    Ok(())
}

/// Contract §C2 (Task 13 extension): `show_settings()`.
#[tauri::command]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    open_settings(&app).map_err(|e| e.to_string())
}

/// Contract §C2: `set_paused(paused: bool)`.
#[tauri::command]
pub fn set_paused(paused: bool) {
    log::debug!("set_paused stub: ignoring paused={paused}");
}
