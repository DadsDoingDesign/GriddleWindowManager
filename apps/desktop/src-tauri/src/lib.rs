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
        // Single-instance must be the first plugin so a second launch is
        // caught before anything else initializes; it surfaces the existing
        // instance's settings window instead (plan Task 18).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("second instance launch intercepted; opening settings");
            if let Err(e) = shell::open_settings(app) {
                log::error!("single-instance: failed to open settings: {e}");
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Only one shortcut is ever registered (the settings
                    // hotkey), so any event here is ours.
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shell::on_hotkey(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            shell::init_tray(app.handle())?;
            // Register the default hotkey now; read_config re-registers the
            // user's binding as soon as the brain host loads the config.
            shell::apply_hotkey(app.handle(), shell::DEFAULT_HOTKEY);
            // First run (plan Task 19): no readable config on disk means
            // nothing is set up yet — open the settings window, whose
            // welcome page explains the app and offers a monitor picker.
            // (A corrupt config gets quarantined here exactly as the brain
            // host's later read_config would have done; peeking never
            // creates the file.)
            let first_run = config::config_dir()
                .is_none_or(|dir| config::read_config_from(&dir).is_none());
            if first_run {
                log::info!("no config found; opening first-run settings window");
                if let Err(e) = shell::open_settings(app.handle()) {
                    log::error!("first-run: failed to open settings: {e}");
                }
            }
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
            shell::update_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
