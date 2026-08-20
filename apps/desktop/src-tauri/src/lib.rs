pub mod actuator;
pub mod config;
pub mod drag_pump;
pub mod ffi_guard;
pub mod guard;
pub mod ipc;
pub mod monitors;
pub mod overlay;
pub mod shell;
pub mod snap;
#[cfg(all(test, windows))]
mod test_windows;
pub mod tracker;

use tauri::Manager as _;

/// Griddle's own diagnostic switch: `GRIDDLE_DEBUG=1` raises the log level to
/// debug and un-hides the normally invisible brain webview, so a boot failure
/// (which `Brain.svelte` renders as "Brain failed to start: ...") becomes
/// readable instead of dying behind a hidden window.
pub fn debug_mode() -> bool {
    matches!(
        std::env::var("GRIDDLE_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// The log plugin, configured identically in debug and release.
///
/// A shipped build used to register no logger at all, which made every
/// `log::error!` in the codebase a no-op and left field failures undiagnosable
/// by design — the v0.2.0 dead-on-arrival investigation had to be conducted by
/// polling Win32 window handles because of it (docs/qa-handoff-2026-08-19.md).
///
/// Logs are written to disk only, never transmitted, and are bounded: at most
/// three files of 2 MiB, so an app that runs for months cannot quietly eat a
/// disk. See `config::logs_dir` for the rule on what may be written.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let verbose = cfg!(debug_assertions) || debug_mode();
    let mut targets = vec![tauri_plugin_log::Target::new(
        // Fall back to the OS log dir only when APPDATA is unset, which on a
        // real Windows session it never is.
        match config::logs_dir() {
            Some(path) => tauri_plugin_log::TargetKind::Folder {
                path,
                file_name: Some("griddle-wm".into()),
            },
            None => tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("griddle-wm".into()),
            },
        },
    )];
    if verbose {
        targets.push(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ));
    }
    tauri_plugin_log::Builder::default()
        .level(if verbose {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .targets(targets)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .build()
}

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
        // Logging comes next so everything after this point is on the record;
        // single-instance keeps its place at the front by design.
        .plugin(log_plugin())
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
        // Opt-in update checks (spec §7). Registering the plugin costs
        // nothing at runtime: it only exposes commands, and the sole caller
        // is the brain host's driver, which never runs unless the user
        // switched the toggle on or pressed "Check now". `process` supplies
        // the relaunch after the installer has done its work.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            log::info!(
                "Griddle Window Manager {} starting (debug_mode={})",
                env!("CARGO_PKG_VERSION"),
                debug_mode(),
            );
            // GRIDDLE_DEBUG: surface the brain webview so its boot errors and
            // devtools are reachable. Harmless in a shipped build because the
            // variable has to be set deliberately.
            if debug_mode() {
                match app.get_webview_window(guard::MAIN_LABEL) {
                    Some(win) => {
                        if let Err(e) = win.show() {
                            log::error!("GRIDDLE_DEBUG: cannot show the brain window: {e}");
                        } else {
                            log::info!("GRIDDLE_DEBUG: brain window un-hidden");
                        }
                    }
                    None => log::error!("GRIDDLE_DEBUG: no brain window to show"),
                }
            }
            monitors::start_display_watcher(app.handle().clone());
            drag_pump::init(app.handle().clone());
            tracker::start_tracker(app.handle().clone());
            // Heartbeat watchdog: covers the brain deaths the Destroyed
            // watchdog below cannot see (renderer crash with a live window
            // object, boot failure, wedged JS event loop).
            shell::start_brain_heartbeat(app.handle().clone());
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
        // Brain-host watchdog (critique fix, resilience / webview death): if
        // the hidden brain webview dies, the whole product silently stops —
        // respawn it; the fresh page rehydrates from the persisted config.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && shell::should_respawn_brain(window.label(), shell::is_exiting())
            {
                shell::respawn_brain_host(&window.app_handle().clone());
            }
        })
        .invoke_handler(tauri::generate_handler![
            tracker::list_windows,
            tracker::window_is_tracked,
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
            shell::brain_alive,
            shell::set_update_status,
            shell::set_update_handoff,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Tray app: never exit just because the last window went away
            // (e.g. the brain webview died and is mid-respawn, or the user
            // closed settings before any overlay existed). A deliberate
            // `app.exit(code)` — tray Quit — always carries a code.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                if !shell::is_exiting() {
                    api.prevent_exit();
                }
            }
        });
}
