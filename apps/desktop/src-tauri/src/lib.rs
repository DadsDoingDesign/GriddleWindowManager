pub mod actuator;
pub mod config;
pub mod drag_pump;
pub mod ipc;
pub mod monitors;
pub mod overlay;
pub mod shell;
#[cfg(all(test, windows))]
mod test_windows;
pub mod tracker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            monitors::start_display_watcher(app.handle().clone());
            drag_pump::init(app.handle().clone());
            tracker::start_tracker(app.handle().clone());
            // Until Task 18 adds the tray + hotkey there is no UI trigger for
            // the settings window, so open it on launch for now.
            shell::open_settings(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tracker::list_windows,
            monitors::list_monitors,
            actuator::apply_layout,
            actuator::focus_window,
            overlay::show_overlay,
            overlay::hide_overlay,
            config::read_config,
            config::write_config,
            shell::set_paused,
            shell::show_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
