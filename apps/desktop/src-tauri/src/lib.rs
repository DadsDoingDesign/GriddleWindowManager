pub mod actuator;
pub mod config;
pub mod ipc;
pub mod monitors;
pub mod overlay;
pub mod shell;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
