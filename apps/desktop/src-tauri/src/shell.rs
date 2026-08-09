//! App shell (plan Tasks 13 + 18): settings window, tray icon + menu, global
//! hotkey, pause switch, and the single-instance / autostart glue.
//!
//! Layers:
//!
//! 1. **Pause flag** — a process-global `AtomicBool` that is the *authority*
//!    on paused-ness. `set_paused` (command, tray "Pause" item) flips it,
//!    emits the contract C2 `paused-changed` event (the brain host mirrors it
//!    into its config via `setShellPrefs`, so it persists) and syncs the tray
//!    checkbox. The tracker consults [`is_paused`] before emitting any window
//!    event and the actuator consults it before applying any layout — spec
//!    §6 "panic button": pause suspends tracking *and* actuation instantly.
//! 2. **Tray** — one tray icon with a menu of per-monitor grid check items
//!    (checked ⇔ an enabled grid covers that monitor), Pause, Settings and
//!    Quit. Clicking a monitor item emits `tray-toggle-grid {monitorId}`; the
//!    brain host owns the actual toggle and answers with the `update_tray`
//!    command, which re-syncs the check states (and rebuilds the item list
//!    when the monitor topology changed) — so the menu always reflects live
//!    brain state, not what the click optimistically flipped.
//! 3. **Hotkey** — `tauri-plugin-global-shortcut`, default `Ctrl+Super+G`,
//!    rebindable from `config.hotkey`: [`apply_hotkey`] re-registers whenever
//!    read/write_config sees a different value. Triggering it emits the C2
//!    `hotkey-settings` event and opens the settings window.
//! 4. **Autostart** — `tauri-plugin-autostart`; [`sync_from_config`] converges
//!    the OS registration onto `config.autostart` (the settings toggle writes
//!    the config, so the toggle drives the registration).

use crate::ipc::{events, AppConfig, MonitorInfo, TrayToggleGrid};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Shortcut};

/// Label of the on-demand settings window (spec §4.3: route `/settings`).
pub const SETTINGS_LABEL: &str = "settings";

/// Contract C1 default for `AppConfig.hotkey` (mirrors the brain's
/// `DEFAULT_HOTKEY`). Registered at startup before any config is read.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Super+G";

const TRAY_ID: &str = "griddle-tray";
const MENU_ID_PAUSE: &str = "pause";
const MENU_ID_SETTINGS: &str = "settings";
const MENU_ID_QUIT: &str = "quit";
const MENU_ID_TOGGLE_PREFIX: &str = "toggle:";

// ---------------------------------------------------------------------------
// Pause flag (authority; tracker + actuator consult it)
// ---------------------------------------------------------------------------

static PAUSED: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Brain-host watchdog (critique fix, resilience / webview death)
// ---------------------------------------------------------------------------

/// Set once the user asked to quit, so the watchdog never respawns the brain
/// window while the app is tearing itself down.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Is the app shutting down on purpose?
pub fn is_exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// Mark the app as deliberately quitting (tray Quit).
pub fn mark_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Pure watchdog policy: should a destroyed window with `label` trigger a
/// brain-host respawn? Only the hidden brain window (`main`), and never
/// during a deliberate quit.
pub fn should_respawn_brain(label: &str, exiting: bool) -> bool {
    label == crate::guard::MAIN_LABEL && !exiting
}

/// Recreate the hidden brain-host window after its webview died (WebView2
/// renderer crash, page error). The respawned page runs the normal boot
/// sequence — `read_config` + `list_windows` + grid revival — so every
/// managed window is re-adopted from the persisted config (the rehydration
/// path proven by the brain's respawn test). Without this, a dead brain
/// silently ends all window management while the tray keeps looking healthy.
pub fn respawn_brain_host(app: &AppHandle) {
    log::error!("brain host window died unexpectedly; respawning");
    match WebviewWindowBuilder::new(
        app,
        crate::guard::MAIN_LABEL,
        WebviewUrl::App("/brain".into()),
    )
    .title("Griddle WM Brain")
    .inner_size(800.0, 600.0)
    .visible(false)
    .build()
    {
        Ok(_) => log::info!("brain host respawned; rehydrating from config"),
        Err(e) => log::error!("failed to respawn brain host: {e}"),
    }
}

/// Is window management paused? Checked by the tracker before emitting any
/// window event and by the actuator before applying any layout.
pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// Flip the raw pause flag. Returns `true` when the value actually changed.
/// Pure state transition (no events/tray) so tests can drive it directly.
pub(crate) fn set_paused_flag(paused: bool) -> bool {
    PAUSED.swap(paused, Ordering::SeqCst) != paused
}

/// Authoritative pause transition: flip the flag, broadcast the contract C2
/// `paused-changed {boolean}` event and sync the tray checkbox. Idempotent.
pub fn set_paused_state(app: &AppHandle, paused: bool) {
    if !set_paused_flag(paused) {
        return;
    }
    log::info!(
        "window management {}",
        if paused { "paused" } else { "resumed" }
    );
    if let Err(e) = app.emit(events::PAUSED_CHANGED, paused) {
        log::error!("failed to emit {}: {e}", events::PAUSED_CHANGED);
    }
    with_tray_state(|state| {
        if let Err(e) = state.pause_item.set_checked(paused) {
            log::error!("failed to sync tray pause item: {e}");
        }
    });
}

/// Contract §C2: `set_paused(paused: bool)`. Callers: brain host + settings
/// (security review: least privilege — an overlay webview must not be able
/// to silently unpause/pause management).
#[tauri::command]
pub fn set_paused(app: AppHandle, window: tauri::Window, paused: bool) {
    if crate::guard::authorize("set_paused", window.label()).is_err() {
        return;
    }
    set_paused_state(&app, paused);
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

/// Create the settings window on demand, or re-front it if it already
/// exists. Called by the `show_settings` command, the tray menu, the global
/// hotkey and the single-instance guard.
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

/// Contract §C2 (Task 13 extension): `show_settings()`. Callers: brain host
/// + settings (security review: least privilege).
#[tauri::command]
pub fn show_settings(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::guard::authorize("show_settings", window.label())?;
    open_settings(&app).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/// Menu id of a per-monitor grid toggle item.
pub fn toggle_menu_id(monitor_id: &str) -> String {
    format!("{MENU_ID_TOGGLE_PREFIX}{monitor_id}")
}

/// Inverse of [`toggle_menu_id`]: `None` for non-toggle menu ids.
pub fn monitor_id_from_menu_id(menu_id: &str) -> Option<&str> {
    menu_id.strip_prefix(MENU_ID_TOGGLE_PREFIX)
}

/// Human label for a monitor's tray toggle, derived from the contract C1
/// monitor id (`\\.\DISPLAY1@0,0` → `DISPLAY1`) plus size and primary flag.
pub fn monitor_menu_label(m: &MonitorInfo) -> String {
    let device = m.id.split('@').next().unwrap_or(&m.id);
    let trimmed = device.trim_start_matches(['\\', '.']);
    let name = if trimmed.is_empty() { device } else { trimmed };
    if m.primary {
        format!("Grid on {name} ({}\u{d7}{}, primary)", m.width, m.height)
    } else {
        format!("Grid on {name} ({}\u{d7}{})", m.width, m.height)
    }
}

/// Live tray handles: the icon plus the menu items whose state gets synced.
struct TrayState {
    tray: TrayIcon<Wry>,
    pause_item: CheckMenuItem<Wry>,
    /// `(monitorId, item)` in menu order.
    monitor_items: Vec<(String, CheckMenuItem<Wry>)>,
}

fn tray_state() -> &'static Mutex<Option<TrayState>> {
    static STATE: OnceLock<Mutex<Option<TrayState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn with_tray_state(f: impl FnOnce(&mut TrayState)) {
    let mut guard = tray_state().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(state) = guard.as_mut() {
        f(state);
    }
}

/// Build the full tray menu for the given monitors, with the per-monitor
/// items checked per `enabled_monitor_ids`.
fn build_menu(
    app: &AppHandle,
    monitors: &[MonitorInfo],
    enabled_monitor_ids: &[String],
) -> tauri::Result<(Menu<Wry>, Vec<(String, CheckMenuItem<Wry>)>, CheckMenuItem<Wry>)> {
    let menu = Menu::new(app)?;
    let mut monitor_items = Vec::with_capacity(monitors.len());
    for m in monitors {
        let checked = enabled_monitor_ids.iter().any(|id| id == &m.id);
        let label = monitor_menu_label(m);
        let item = CheckMenuItem::with_id(
            app,
            toggle_menu_id(&m.id),
            label.as_str(),
            true,
            checked,
            None::<&str>,
        )?;
        menu.append(&item)?;
        monitor_items.push((m.id.clone(), item));
    }
    if !monitors.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let pause_item = CheckMenuItem::with_id(
        app,
        MENU_ID_PAUSE,
        "Pause window management",
        true,
        is_paused(),
        None::<&str>,
    )?;
    menu.append(&pause_item)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_ID_SETTINGS,
        "Settings\u{2026}",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_ID_QUIT,
        "Quit Griddle WM",
        true,
        None::<&str>,
    )?)?;
    Ok((menu, monitor_items, pause_item))
}

/// Create the tray icon at startup. Items start unchecked; the brain host's
/// first `update_tray` call brings them in line with the restored config.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let monitors = crate::monitors::enumerate();
    let (menu, monitor_items, pause_item) = build_menu(app, &monitors, &[])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Griddle WM")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()));
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::warn!("no default window icon; tray icon will be blank");
    }
    let tray = builder.build(app)?;
    let mut guard = tray_state().lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(TrayState {
        tray,
        pause_item,
        monitor_items,
    });
    log::info!("tray icon created with {} monitor item(s)", monitors.len());
    Ok(())
}

fn on_menu_event(app: &AppHandle, menu_id: &str) {
    match menu_id {
        MENU_ID_PAUSE => set_paused_state(app, !is_paused()),
        MENU_ID_SETTINGS => {
            if let Err(e) = open_settings(app) {
                log::error!("tray: failed to open settings: {e}");
            }
        }
        MENU_ID_QUIT => {
            log::info!("tray: quit requested");
            mark_exiting(); // the brain-host watchdog must not respawn now
            app.exit(0);
        }
        other => {
            if let Some(monitor_id) = monitor_id_from_menu_id(other) {
                // Contract C2: the brain host owns the toggle; it answers
                // with `update_tray`, which fixes up the check state the
                // click optimistically flipped.
                let payload = TrayToggleGrid {
                    monitor_id: monitor_id.to_string(),
                };
                if let Err(e) = app.emit(events::TRAY_TOGGLE_GRID, payload) {
                    log::error!("failed to emit {}: {e}", events::TRAY_TOGGLE_GRID);
                }
            } else {
                log::warn!("tray: unknown menu id {other:?}");
            }
        }
    }
}

/// Converge the tray onto live brain state: check items for monitors covered
/// by an enabled grid, rebuild the item list when the topology changed.
fn sync_tray(app: &AppHandle, enabled_monitor_ids: &[String]) {
    let monitors = crate::monitors::enumerate();
    let mut guard = tray_state().lock().unwrap_or_else(|p| p.into_inner());
    let Some(state) = guard.as_mut() else {
        return; // tray never came up (init_tray failed); nothing to sync
    };
    let same_monitors = state.monitor_items.len() == monitors.len()
        && state
            .monitor_items
            .iter()
            .zip(&monitors)
            .all(|((id, _), m)| *id == m.id);
    if same_monitors {
        for (id, item) in &state.monitor_items {
            let checked = enabled_monitor_ids.iter().any(|e| e == id);
            if let Err(e) = item.set_checked(checked) {
                log::error!("failed to sync tray item for {id}: {e}");
            }
        }
        if let Err(e) = state.pause_item.set_checked(is_paused()) {
            log::error!("failed to sync tray pause item: {e}");
        }
        return;
    }
    match build_menu(app, &monitors, enabled_monitor_ids) {
        Ok((menu, monitor_items, pause_item)) => {
            if let Err(e) = state.tray.set_menu(Some(menu)) {
                log::error!("failed to replace tray menu: {e}");
                return;
            }
            state.monitor_items = monitor_items;
            state.pause_item = pause_item;
            log::info!("tray menu rebuilt for {} monitor(s)", monitors.len());
        }
        Err(e) => log::error!("failed to rebuild tray menu: {e}"),
    }
}

/// Contract §C2 (Task 18 extension): `update_tray(enabledMonitorIds)` — the
/// brain host calls this on every state snapshot so the tray reflects live
/// grid state. Brain-host only (security review: least privilege — other
/// webviews must not be able to spoof tray check state).
#[tauri::command]
pub fn update_tray(app: AppHandle, window: tauri::Window, enabled_monitor_ids: Vec<String>) {
    if crate::guard::authorize("update_tray", window.label()).is_err() {
        return;
    }
    sync_tray(&app, &enabled_monitor_ids);
}

// ---------------------------------------------------------------------------
// Global hotkey
// ---------------------------------------------------------------------------

fn hotkey_lock() -> &'static Mutex<Option<String>> {
    static HOTKEY: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    HOTKEY.get_or_init(|| Mutex::new(None))
}

/// (Re)register the settings hotkey. No-op when `hotkey` is what is already
/// registered; an unparseable or unregistrable accelerator keeps the current
/// binding (logged, never fatal — the tray still reaches settings).
pub fn apply_hotkey(app: &AppHandle, hotkey: &str) {
    let mut current = hotkey_lock().lock().unwrap_or_else(|p| p.into_inner());
    if current.as_deref() == Some(hotkey) {
        return;
    }
    let shortcut: Shortcut = match hotkey.parse() {
        Ok(s) => s,
        Err(e) => {
            log::error!("invalid hotkey {hotkey:?}: {e}; keeping {:?}", *current);
            return;
        }
    };
    if let Some(old) = current.as_deref() {
        if let Ok(old_shortcut) = old.parse::<Shortcut>() {
            if let Err(e) = app.global_shortcut().unregister(old_shortcut) {
                log::warn!("failed to unregister old hotkey {old:?}: {e}");
            }
        }
    }
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            log::info!("global hotkey registered: {hotkey}");
            *current = Some(hotkey.to_string());
        }
        Err(e) => {
            // Likely taken by another app; try to fall back to the previous
            // binding so the user is not left with none at all.
            log::error!("failed to register hotkey {hotkey:?}: {e}");
            if let Some(old) = current.clone() {
                if let Ok(old_shortcut) = old.parse::<Shortcut>() {
                    if app.global_shortcut().register(old_shortcut).is_ok() {
                        log::info!("restored previous hotkey {old:?}");
                        return;
                    }
                }
                *current = None;
            }
        }
    }
}

/// The accelerator string currently registered (the binding a rejected
/// rebind should fall back to). Defaults to [`DEFAULT_HOTKEY`] before any
/// registration succeeded.
pub fn current_hotkey() -> String {
    hotkey_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

/// Global-shortcut handler: contract C2 `hotkey-settings {}` + open settings.
pub fn on_hotkey(app: &AppHandle) {
    if let Err(e) = app.emit(
        events::HOTKEY_SETTINGS,
        serde_json::Value::Object(Default::default()),
    ) {
        log::error!("failed to emit {}: {e}", events::HOTKEY_SETTINGS);
    }
    if let Err(e) = open_settings(app) {
        log::error!("hotkey: failed to open settings: {e}");
    }
}

// ---------------------------------------------------------------------------
// Config-driven shell state (hotkey, autostart, initial pause)
// ---------------------------------------------------------------------------

static CONFIG_SEEDED: AtomicBool = AtomicBool::new(false);

/// Converge shell state onto a config the app just read or wrote.
///
/// The *first* sighting (startup `read_config` from the brain host) also
/// seeds the pause flag from disk. Later sightings never touch pause: its
/// authority is `set_paused` (tray / settings), and a stale disk value —
/// e.g. a settings-window `read_config` racing the brain's debounced save —
/// must not clobber it. Hotkey and autostart are brain-owned config fields,
/// so they are synced on every sighting.
pub fn sync_from_config(app: &AppHandle, cfg: &AppConfig) {
    if !CONFIG_SEEDED.swap(true, Ordering::SeqCst) {
        set_paused_state(app, cfg.paused);
    }
    apply_hotkey(app, &cfg.hotkey);
    sync_autostart(app, cfg.autostart);
}

/// Converge the OS autostart registration onto `wanted` (the config value the
/// settings toggle writes).
fn sync_autostart(app: &AppHandle, wanted: bool) {
    let manager = app.autolaunch();
    match (manager.is_enabled(), wanted) {
        (Ok(true), true) | (Ok(false), false) => {}
        (Ok(false), true) => {
            if let Err(e) = manager.enable() {
                log::error!("failed to enable autostart: {e}");
            } else {
                log::info!("autostart enabled");
            }
        }
        (Ok(true), false) => {
            if let Err(e) = manager.disable() {
                log::error!("failed to disable autostart: {e}");
            } else {
                log::info!("autostart disabled");
            }
        }
        (Err(e), _) => log::warn!("cannot query autostart state: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Tests (pure parts; tray/hotkey/autostart need a live app and are covered
// by the deferred manual smoke test)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- pause flag ----------------------------------------------------------

    /// PAUSED is process-global and gates the actuator, whose tests hold the
    /// tracker's live-set lock — so every test touching PAUSED must hold the
    /// same lock to serialize against them.
    #[test]
    fn pause_flag_transitions_and_reports_changes() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(!is_paused(), "paused defaults to false");
        assert!(set_paused_flag(true), "false -> true is a change");
        assert!(is_paused());
        assert!(!set_paused_flag(true), "true -> true is not");
        assert!(set_paused_flag(false), "true -> false is a change");
        assert!(!is_paused());
        assert!(!set_paused_flag(false), "false -> false is not");
    }

    // -- brain-host watchdog policy -------------------------------------------

    #[test]
    fn watchdog_respawns_only_the_brain_window_and_never_during_quit() {
        assert!(should_respawn_brain("main", false), "dead brain respawns");
        assert!(!should_respawn_brain("main", true), "not during a quit");
        assert!(!should_respawn_brain("settings", false), "settings closes freely");
        assert!(!should_respawn_brain("overlay-0", false), "overlays close freely");
        assert!(!should_respawn_brain("", false));
    }

    // -- tray menu id scheme -------------------------------------------------

    #[test]
    fn toggle_menu_ids_round_trip_monitor_ids() {
        let id = r"\\.\DISPLAY1@0,0";
        assert_eq!(toggle_menu_id(id), format!("toggle:{id}"));
        assert_eq!(monitor_id_from_menu_id(&toggle_menu_id(id)), Some(id));
        // Monitor ids with negative coordinates survive verbatim.
        let neg = r"\\.\DISPLAY2@-1920,-240";
        assert_eq!(monitor_id_from_menu_id(&toggle_menu_id(neg)), Some(neg));
    }

    #[test]
    fn fixed_menu_ids_are_not_monitor_toggles() {
        assert_eq!(monitor_id_from_menu_id(MENU_ID_PAUSE), None);
        assert_eq!(monitor_id_from_menu_id(MENU_ID_SETTINGS), None);
        assert_eq!(monitor_id_from_menu_id(MENU_ID_QUIT), None);
    }

    // -- monitor labels ------------------------------------------------------

    fn mon(id: &str, width: i32, height: i32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id: id.to_string(),
            x: 0,
            y: 0,
            width,
            height,
            work_x: 0,
            work_y: 0,
            work_width: width,
            work_height: height,
            dpi: 96,
            primary,
        }
    }

    #[test]
    fn monitor_label_strips_device_prefix_and_marks_primary() {
        let m = mon(r"\\.\DISPLAY1@0,0", 1920, 1080, true);
        assert_eq!(monitor_menu_label(&m), "Grid on DISPLAY1 (1920\u{d7}1080, primary)");
    }

    #[test]
    fn monitor_label_secondary_has_no_primary_marker() {
        let m = mon(r"\\.\DISPLAY2@1920,0", 2560, 1440, false);
        assert_eq!(monitor_menu_label(&m), "Grid on DISPLAY2 (2560\u{d7}1440)");
    }

    #[test]
    fn monitor_label_survives_ids_without_device_prefix() {
        let m = mon("odd-id@0,0", 800, 600, false);
        assert_eq!(monitor_menu_label(&m), "Grid on odd-id (800\u{d7}600)");
    }

    // -- hotkey accelerator strings -----------------------------------------

    #[test]
    fn default_hotkey_parses_as_a_global_shortcut() {
        let shortcut: Result<Shortcut, _> = DEFAULT_HOTKEY.parse();
        assert!(shortcut.is_ok(), "{:?}", shortcut.err());
    }

    #[test]
    fn common_rebind_strings_parse_and_garbage_does_not() {
        for ok in ["Ctrl+Alt+G", "Super+Shift+Space", "Ctrl+Super+F12"] {
            assert!(ok.parse::<Shortcut>().is_ok(), "{ok} should parse");
        }
        for bad in ["", "Ctrl+", "NotAKey+G", "Ctrl+Super+NoSuchKey"] {
            assert!(bad.parse::<Shortcut>().is_err(), "{bad} should not parse");
        }
    }
}
