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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
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
const MENU_ID_UPDATE: &str = "update";
const MENU_ID_TOGGLE_PREFIX: &str = "toggle:";

// ---------------------------------------------------------------------------
// WebView2 browser arguments (QA 2026-08-19: the dead-on-arrival root cause)
// ---------------------------------------------------------------------------
//
// Every webview in one process shares a single WebView2 *browser process*,
// keyed by the user-data folder. WebView2 pins that process to the
// `additionalBrowserArgs` of whoever created it first and then refuses any
// later environment whose arguments differ:
// `CreateCoreWebView2EnvironmentWithOptions` fails with
// `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)`.
//
// The brain window declares custom args in `tauri.conf.json` and boots first,
// so it wins the race. Any window built later that does *not* repeat those
// args asks wry for its default set instead (`webview2/mod.rs`,
// `create_environment`) - a different string - and its `build()` fails after
// the native window already exists, so the user sees a frame flash and
// vanish. That killed the settings window, the drag overlays and the brain's
// own respawn path, and because the failure is `log::error!`-only it was
// invisible in a release build.
//
// Reading the args back out of the parsed config (rather than repeating the
// literal here) means the two can never drift apart: whatever
// `tauri.conf.json` declares for the brain is exactly what every other window
// asks for.

/// The brain window's `additionalBrowserArgs`, as declared in `tauri.conf.json`.
pub fn brain_browser_args(app: &AppHandle) -> Option<String> {
    browser_args_of(&app.config().app.windows, crate::guard::MAIN_LABEL)
}

/// Pure half of [`brain_browser_args`], so the lookup is testable without a
/// running app.
pub fn browser_args_of(
    windows: &[tauri::utils::config::WindowConfig],
    label: &str,
) -> Option<String> {
    windows
        .iter()
        .find(|w| w.label == label)
        .and_then(|w| w.additional_browser_args.clone())
}

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

/// Mark the app as deliberately quitting (tray Quit, update handoff).
pub fn mark_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Undo [`mark_exiting`]. Only the update handoff uses this — an install
/// that failed after arming must leave a live, self-healing app behind, not
/// one whose brain watchdog has been switched off (`set_update_handoff`).
/// Tray Quit never disarms: that exit really is happening.
pub(crate) fn clear_exiting() {
    EXITING.store(false, Ordering::SeqCst);
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
    let mut builder = WebviewWindowBuilder::new(
        app,
        crate::guard::MAIN_LABEL,
        WebviewUrl::App("/brain".into()),
    )
    .title("Griddle Window Manager Brain")
    .inner_size(800.0, 600.0)
    .visible(false);
    // Without the original args this respawn is refused by the running
    // WebView2 browser process, so a dead brain could never come back.
    if let Some(args) = brain_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    match builder.build()
    {
        Ok(_) => log::info!("brain host respawned; rehydrating from config"),
        Err(e) => log::error!("failed to respawn brain host: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Brain-host heartbeat (critique round 2: webview deaths the `Destroyed`
// watchdog cannot see)
// ---------------------------------------------------------------------------
//
// The `WindowEvent::Destroyed` watchdog only covers one of the ways the
// brain can die. A WebView2 renderer/browser-process crash leaves the Tauri
// window object alive with a blank page; a `startBrainHost()` boot failure
// renders an error into a permanently hidden window; a wedged JS event loop
// stops processing events. All three leave every grid silently dead while
// the tray looks healthy. One mechanism covers them all: the brain host
// invokes the trivial `brain_alive` command every few seconds, and a Rust
// timer that misses enough beats destroys the window — which triggers the
// existing `Destroyed` → `respawn_brain_host` → rehydration path.

/// How long without a beat before the brain host is declared dead.
///
/// The page beats every ~3 s — but the brain page is *permanently hidden*,
/// and Chromium applies intensive wake-up throttling to hidden pages after
/// ~5 minutes: chained timers (`setInterval`) get aligned to one wake-up per
/// minute. `tauri.conf.json` passes `--disable-background-timer-throttling`
/// to WebView2 to switch that off, but the timeout must not *rely* on a
/// browser flag staying honored across WebView2 releases: it sits well above
/// the worst-case throttled cadence (~60 s), so even a fully throttled but
/// healthy brain never gets shot. Real deaths are still caught — just up to
/// ~90 s later, and the `Destroyed`-event watchdog covers the common crash
/// modes instantly. Commands the brain host invokes anyway (`apply_layout`,
/// `list_windows`) also count as beats ([`note_brain_activity`]), so an
/// *active* brain is never in doubt regardless of timer throttling.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(90);
/// How often the watchdog thread checks the beat clock.
const HEARTBEAT_CHECK_INTERVAL: Duration = Duration::from_secs(3);
/// Consecutive beat-less respawns before giving up — a page that never
/// manages a single beat (e.g. a boot that always throws) must not be
/// rebuilt in an infinite loop.
pub const HEARTBEAT_MAX_RESPAWNS: u32 = 5;

/// Respawns attempted since the last successful beat.
static RESPAWNS_WITHOUT_BEAT: AtomicU32 = AtomicU32::new(0);

fn beat_lock() -> &'static Mutex<Instant> {
    static BEAT: OnceLock<Mutex<Instant>> = OnceLock::new();
    BEAT.get_or_init(|| Mutex::new(Instant::now()))
}

/// A live beat from the brain page: reset the clock and the give-up counter.
fn record_brain_beat() {
    *beat_lock().lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    RESPAWNS_WITHOUT_BEAT.store(0, Ordering::SeqCst);
}

/// Any command invocation from the brain-host window proves its JS event
/// loop is alive — count it as a heartbeat so timer throttling of the hidden
/// page can never make an *active* brain look dead. Called by the hot
/// brain-host commands (`apply_layout`, `list_windows`) after authorization.
pub(crate) fn note_brain_activity() {
    record_brain_beat();
}

/// Reset only the clock (boot / post-respawn grace) — the give-up counter
/// keeps counting until a real beat arrives.
fn reset_beat_clock() {
    *beat_lock().lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
}

/// Pure watchdog policy: should `elapsed` since the last beat (or respawn)
/// with `respawns_without_beat` prior beat-less respawns force a respawn?
/// Never during a deliberate quit, never past the give-up cap.
pub fn heartbeat_wants_respawn(
    elapsed: Duration,
    respawns_without_beat: u32,
    exiting: bool,
) -> bool {
    !exiting && respawns_without_beat < HEARTBEAT_MAX_RESPAWNS && elapsed >= HEARTBEAT_TIMEOUT
}

/// Contract §C2 extension: `brain_alive()` — the brain host's heartbeat.
/// Brain-host only (a settings/overlay page must not be able to mask a dead
/// brain by beating on its behalf).
#[tauri::command]
pub fn brain_alive(window: tauri::Window) {
    if crate::guard::authorize("brain_alive", window.label()).is_err() {
        return;
    }
    record_brain_beat();
}

/// Start the heartbeat watchdog thread. Idempotent enough for one call from
/// setup; the thread runs for the process lifetime.
pub fn start_brain_heartbeat(app: AppHandle) {
    reset_beat_clock(); // boot grace: the first page gets a full timeout
    if let Err(e) = std::thread::Builder::new()
        .name("brain-heartbeat".into())
        .spawn(move || heartbeat_loop(&app))
    {
        log::error!("failed to spawn brain-heartbeat thread: {e}");
    }
}

fn heartbeat_loop(app: &AppHandle) {
    loop {
        std::thread::sleep(HEARTBEAT_CHECK_INTERVAL);
        if is_exiting() {
            return;
        }
        let elapsed = beat_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .elapsed();
        let respawns = RESPAWNS_WITHOUT_BEAT.load(Ordering::SeqCst);
        if !heartbeat_wants_respawn(elapsed, respawns, false) {
            continue;
        }
        let attempt = respawns + 1;
        RESPAWNS_WITHOUT_BEAT.store(attempt, Ordering::SeqCst);
        reset_beat_clock(); // the fresh page gets a full timeout too
        log::error!(
            "brain host sent no heartbeat for {elapsed:?}; forcing respawn \
             (attempt {attempt}/{HEARTBEAT_MAX_RESPAWNS})"
        );
        if attempt == HEARTBEAT_MAX_RESPAWNS {
            log::error!(
                "final automatic respawn attempt — if the brain stays silent, \
                 window management is down until Griddle Window Manager is \
                 restarted"
            );
        }
        let app2 = app.clone();
        if let Err(e) = app.run_on_main_thread(move || force_brain_respawn(&app2)) {
            log::error!("heartbeat: run_on_main_thread failed: {e}");
        }
    }
}

/// Tear down the (possibly wedged) brain window and rebuild it. Destroying
/// the window fires `WindowEvent::Destroyed`, whose watchdog performs the
/// actual respawn — one respawn path for every death mode. A window that is
/// already gone is respawned directly.
fn force_brain_respawn(app: &AppHandle) {
    match app.get_webview_window(crate::guard::MAIN_LABEL) {
        Some(win) => {
            if let Err(e) = win.destroy() {
                log::error!("heartbeat: failed to destroy brain window: {e}; respawning anyway");
                respawn_brain_host(app);
            }
        }
        None => respawn_brain_host(app),
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
    // A window that exists but can no longer be shown is worse than none:
    // the old code returned Ok here unconditionally, so once a build left a
    // corpse behind under this label, *every* later route in - tray item,
    // hotkey, second launch - silently no-opped forever. Prove the window is
    // really usable; if it is not, tear it down and build a fresh one.
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        match revive_settings(&win) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::error!(
                    "settings window exists but will not show ({e}); rebuilding it"
                );
                // Best-effort: a corpse may fail to destroy too, but the
                // rebuild below is the only path back to a usable window.
                if let Err(e) = win.destroy() {
                    log::error!("failed to destroy the stale settings window: {e}");
                }
            }
        }
    }
    let mut builder =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("/settings".into()))
            .title("Griddle Window Manager Settings")
            .inner_size(900.0, 720.0)
            .min_inner_size(560.0, 400.0)
            .center();
    // Must match the brain's args or WebView2 refuses the environment and
    // this build() fails after the native window is already on screen -
    // exactly the "frame flashed for a second" report.
    if let Some(args) = brain_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    builder.build()?;
    Ok(())
}

/// Surface an existing settings window, failing loudly if it is a corpse.
/// `is_visible` is the probe that matters: it round-trips to the real HWND,
/// so a destroyed window reports an error rather than a cheerful `Ok`.
fn revive_settings(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    win.unminimize()?;
    win.show()?;
    win.set_focus()?;
    if !win.is_visible()? {
        return Err(tauri::Error::WebviewNotFound);
    }
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
/// "Grid:" (not "Grid on") so the unchecked state doesn't read as a false
/// statement — the checkmark alone carries on/off.
pub fn monitor_menu_label(m: &MonitorInfo) -> String {
    let device = m.id.split('@').next().unwrap_or(&m.id);
    let trimmed = device.trim_start_matches(['\\', '.']);
    let name = if trimmed.is_empty() { device } else { trimmed };
    if m.primary {
        format!("Grid: {name} ({}\u{d7}{}, primary)", m.width, m.height)
    } else {
        format!("Grid: {name} ({}\u{d7}{})", m.width, m.height)
    }
}

/// Tray tooltip: silent when everything fits; names the failure when windows
/// float because their grid is full (spec §5.4 "grid-full hint" — the one
/// moment the product misbehaves must not be the one moment it says nothing).
///
/// This is the one sanctioned place for the short form "Griddle WM": a tray
/// tooltip is a single cramped line that also has to carry the grid-full
/// sentence. Everywhere else the product is "Griddle Window Manager".
pub fn tray_tooltip(floating: usize, idle_grids: usize) -> String {
    // Floating windows come first: a window that did not fit is a live
    // misbehaviour, while an idle grid is merely waiting.
    match (floating, idle_grids) {
        (0, 0) => "Griddle WM".to_string(),
        (0, 1) => {
            "Griddle WM — a grid is enabled on a monitor with no windows on it yet".to_string()
        }
        (0, n) => format!(
            "Griddle WM — {n} grids are enabled on monitors with no windows on them yet"
        ),
        (1, _) => "Griddle WM — 1 window didn't fit its grid and floats free".to_string(),
        (n, _) => format!("Griddle WM — {n} windows didn't fit their grid and float free"),
    }
}

// ---------------------------------------------------------------------------
// Monitor cache (critique round 3, hot-path hygiene)
// ---------------------------------------------------------------------------
//
// `update_tray` runs on every brain snapshot (every window appear / destroy /
// minimize / drag-commit). Re-walking the display topology
// (EnumDisplayMonitors + GetMonitorInfoW + GetDpiForMonitor per monitor) on
// the main thread each time just to diff menu items is waste: the topology
// only changes when the display watcher says so. The watcher's
// `monitors-changed` path refreshes this cache; tray syncs read it.

fn monitor_cache() -> &'static Mutex<Option<Vec<MonitorInfo>>> {
    static CACHE: OnceLock<Mutex<Option<Vec<MonitorInfo>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Store a fresh display enumeration (called from the display watcher's
/// monitors-changed path and from tray init).
pub fn refresh_monitor_cache(monitors: &[MonitorInfo]) {
    *monitor_cache().lock().unwrap_or_else(|p| p.into_inner()) = Some(monitors.to_vec());
}

/// The last known display topology; enumerates (and seeds the cache) only
/// when nothing has been cached yet.
fn cached_monitors() -> Vec<MonitorInfo> {
    if let Some(m) = monitor_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return m;
    }
    let fresh = crate::monitors::enumerate();
    refresh_monitor_cache(&fresh);
    fresh
}

/// Live tray handles: the icon plus the menu items whose state gets synced.
struct TrayState {
    tray: TrayIcon<Wry>,
    pause_item: CheckMenuItem<Wry>,
    /// `(monitorId, item)` in menu order.
    monitor_items: Vec<(String, CheckMenuItem<Wry>)>,
    /// Last enabled-monitor set the brain pushed. Kept so a menu *rebuild*
    /// triggered by something other than a snapshot — the update entry
    /// appearing or going away — can reproduce the current check states
    /// instead of clearing them.
    enabled_monitor_ids: Vec<String>,
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
    // Spec §7 "Update checks": when the driver found a release, the tray
    // says so at the very top — it is the only surface a user who never
    // opens Settings will see. It opens Settings; nothing installs from here.
    if let Some(version) = offered_update_version() {
        menu.append(&MenuItem::with_id(
            app,
            MENU_ID_UPDATE,
            update_menu_label(&version).as_str(),
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
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
        "Quit Griddle Window Manager",
        true,
        None::<&str>,
    )?)?;
    Ok((menu, monitor_items, pause_item))
}

/// Create the tray icon at startup. Items start unchecked; the brain host's
/// first `update_tray` call brings them in line with the restored config.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let monitors = crate::monitors::enumerate();
    refresh_monitor_cache(&monitors);
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
        enabled_monitor_ids: Vec::new(),
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
        // Spec §7: the tray never installs anything. It opens Settings,
        // where the banner shows the version and release notes and the user
        // decides.
        MENU_ID_UPDATE => {
            if let Err(e) = open_settings(app) {
                log::error!("tray: failed to open settings for the update offer: {e}");
            }
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
/// by an enabled grid, tooltip reflecting grid-full floating windows,
/// rebuild the item list when the topology changed. Runs on every brain
/// snapshot, so it reads the watcher-maintained monitor cache instead of
/// re-enumerating displays each time.
fn sync_tray(
    app: &AppHandle,
    enabled_monitor_ids: &[String],
    floating: usize,
    idle_grids: usize,
) {
    let monitors = cached_monitors();
    let mut guard = tray_state().lock().unwrap_or_else(|p| p.into_inner());
    let Some(state) = guard.as_mut() else {
        return; // tray never came up (init_tray failed); nothing to sync
    };
    state.enabled_monitor_ids = enabled_monitor_ids.to_vec();
    if let Err(e) = state.tray.set_tooltip(Some(tray_tooltip(floating, idle_grids))) {
        log::error!("failed to set tray tooltip: {e}");
    }
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

/// Contract §C2 (Task 18 extension): `update_tray(enabledMonitorIds,
/// floatingCount?)` — the brain host calls this on every state snapshot so
/// the tray reflects live grid state; `floating_count` (windows whose grid
/// could not fit them) drives the tooltip's grid-full hint. Brain-host only
/// (security review: least privilege — other webviews must not be able to
/// spoof tray state).
#[tauri::command]
pub fn update_tray(
    app: AppHandle,
    window: tauri::Window,
    enabled_monitor_ids: Vec<String>,
    floating_count: Option<usize>,
    // Enabled grids holding no windows. Optional so an older brain bundle
    // that omits it still deserializes (it simply reports none).
    idle_grid_count: Option<usize>,
) {
    if crate::guard::authorize("update_tray", window.label()).is_err() {
        return;
    }
    sync_tray(
        &app,
        &enabled_monitor_ids,
        floating_count.unwrap_or(0),
        idle_grid_count.unwrap_or(0),
    );
}

// ---------------------------------------------------------------------------
// Update offer + installer handoff (spec §7 "Update checks")
// ---------------------------------------------------------------------------
//
// Everything about *deciding* to update lives in the brain host (it holds the
// config, the 24 h clock and the updater plugin's handles). Rust owns the two
// pieces the webview cannot reach: the tray entry that announces an offer to
// a user who never opens Settings, and the shell freeze that must happen
// before the NSIS installer takes over.

/// Version currently being offered, or `None` when there is no offer.
fn update_offer_lock() -> &'static Mutex<Option<String>> {
    static OFFER: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    OFFER.get_or_init(|| Mutex::new(None))
}

fn offered_update_version() -> Option<String> {
    update_offer_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Label of the tray's update entry. The ellipsis is the promise that
/// clicking it opens something rather than starting an install.
pub fn update_menu_label(version: &str) -> String {
    format!("Update to {version}\u{2026}")
}

/// Pure policy behind `set_update_status`: what the tray should be showing
/// for a given `(available, version)` claim. An "available" claim carrying no
/// usable version is not something the menu could honestly label, so it reads
/// as no offer rather than as a nameless "an update exists".
pub fn offer_from_status(available: bool, version: Option<&str>) -> Option<String> {
    if !available {
        return None;
    }
    let trimmed = version?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Rebuild the tray menu in place, preserving the check states the last
/// `update_tray` established. Used when the menu's *shape* changed for a
/// reason the snapshot path knows nothing about (the update entry).
fn rebuild_tray_menu(app: &AppHandle) {
    let monitors = cached_monitors();
    let mut guard = tray_state().lock().unwrap_or_else(|p| p.into_inner());
    let Some(state) = guard.as_mut() else {
        return;
    };
    let enabled = state.enabled_monitor_ids.clone();
    match build_menu(app, &monitors, &enabled) {
        Ok((menu, monitor_items, pause_item)) => {
            if let Err(e) = state.tray.set_menu(Some(menu)) {
                log::error!("failed to replace tray menu: {e}");
                return;
            }
            state.monitor_items = monitor_items;
            state.pause_item = pause_item;
        }
        Err(e) => log::error!("failed to rebuild tray menu: {e}"),
    }
}

/// Contract §C2 extension (spec §7): `set_update_status(available, version)`
/// — the brain host's updater driver tells the tray whether an offer is on
/// the table. Brain-host only: no other webview may put an update entry in
/// front of the user. Nothing here checks, downloads or installs anything;
/// the entry only opens Settings.
#[tauri::command]
pub fn set_update_status(app: AppHandle, window: tauri::Window, available: bool, version: Option<String>) {
    if crate::guard::authorize("set_update_status", window.label()).is_err() {
        return;
    }
    let wanted = offer_from_status(available, version.as_deref());
    {
        let mut current = update_offer_lock().lock().unwrap_or_else(|p| p.into_inner());
        if *current == wanted {
            return; // menu already says exactly this
        }
        log::info!(
            "update offer: {}",
            wanted.as_deref().unwrap_or("none (cleared)")
        );
        *current = wanted;
    }
    rebuild_tray_menu(&app);
}

/// Contract §C2 extension (spec §7): `set_update_handoff(active)` — the shell
/// state the brain host arms immediately before handing a downloaded package
/// to the NSIS installer (which restarts the app), and disarms if the install
/// never happens.
///
/// Two shell facts have to be true across that handoff:
///
/// * **Nothing may move a window any more.** This reuses the pause flag the
///   tray's panic button owns — the tracker and actuator already consult it
///   before every event and every apply. It deliberately calls the *raw*
///   [`set_paused_flag`] instead of [`set_paused_state`]: the latter emits
///   `paused-changed`, which the brain mirrors into its config and would
///   persist, so the user would come back from the update into a paused
///   window manager they never asked for. The brain host flushes the config
///   to disk (`saveNow`) immediately before arming, so what survives the
///   restart is the real, unpaused state.
/// * **The brain window must be allowed to die.** The installer tears the
///   process down; without [`mark_exiting`] the respawn watchdog would fight
///   it, rebuilding the brain webview mid-teardown.
///
/// Both are reversible on purpose: if the install fails after arming, the
/// host disarms and the user is left with a working window manager and an
/// error message rather than a silently frozen one.
#[tauri::command]
pub fn set_update_handoff(window: tauri::Window, active: bool) -> Result<(), String> {
    crate::guard::authorize("set_update_handoff", window.label())?;
    if active {
        log::info!("update: freezing window management and handing off to the installer");
        set_paused_flag(true);
        mark_exiting();
    } else {
        log::warn!("update: install did not happen; unfreezing window management");
        clear_exiting();
        set_paused_flag(false);
    }
    Ok(())
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
            //
            // The commonest cause during development is a second Griddle
            // already holding the chord: only one process can own a global
            // hotkey, and the loser used to fail silently because release
            // builds registered no logger at all.
            log::error!(
                "failed to register hotkey {hotkey:?}: {e} - another process                  already owns this chord (often a second copy of Griddle                  Window Manager); pressing it will act on that process, not                  this one"
            );
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
    // A dev build's exe lives in `target\debug`, and the plugin writes an
    // `HKCU\...\Run` entry pointing at whichever exe asked. Letting a
    // contributor's throwaway build claim the user's logon would silently
    // replace their installed copy at next sign-in, so a dev build declines
    // and says why (docs/qa-handoff-2026-08-19.md, defect 4).
    if cfg!(dev) && wanted {
        log::warn!(
            "autostart requested but refused: this is a dev build, and              registering it would hijack sign-in from any installed copy"
        );
        return;
    }
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

    // -- brain-host heartbeat policy ------------------------------------------

    #[test]
    fn heartbeat_respawns_only_after_timeout_and_under_the_give_up_cap() {
        let t = HEARTBEAT_TIMEOUT;
        assert!(!heartbeat_wants_respawn(Duration::ZERO, 0, false));
        assert!(
            !heartbeat_wants_respawn(t - Duration::from_millis(1), 0, false),
            "no respawn before the timeout"
        );
        assert!(heartbeat_wants_respawn(t, 0, false), "respawn at the timeout");
        assert!(
            heartbeat_wants_respawn(t * 3, HEARTBEAT_MAX_RESPAWNS - 1, false),
            "keeps retrying under the cap"
        );
        assert!(
            !heartbeat_wants_respawn(t * 3, HEARTBEAT_MAX_RESPAWNS, false),
            "gives up at the cap (no infinite respawn loop)"
        );
        assert!(
            !heartbeat_wants_respawn(t * 3, 0, true),
            "never respawns during a deliberate quit"
        );
    }

    #[test]
    fn heartbeat_beat_resets_the_give_up_counter() {
        RESPAWNS_WITHOUT_BEAT.store(3, Ordering::SeqCst);
        record_brain_beat();
        assert_eq!(RESPAWNS_WITHOUT_BEAT.load(Ordering::SeqCst), 0);
        RESPAWNS_WITHOUT_BEAT.store(2, Ordering::SeqCst);
        reset_beat_clock(); // grace reset must NOT clear the counter
        assert_eq!(RESPAWNS_WITHOUT_BEAT.load(Ordering::SeqCst), 2);
        RESPAWNS_WITHOUT_BEAT.store(0, Ordering::SeqCst);
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
        assert_eq!(monitor_id_from_menu_id(MENU_ID_UPDATE), None);
    }

    // -- update offer (spec §7) ----------------------------------------------

    #[test]
    fn update_menu_label_names_the_version_and_promises_a_dialog() {
        assert_eq!(update_menu_label("0.3.0"), "Update to 0.3.0\u{2026}");
        assert!(
            update_menu_label("1.0.0").ends_with('\u{2026}'),
            "the ellipsis says 'opens something', not 'installs now'"
        );
    }

    /// The tray entry exists only while a *labelable* offer does: an
    /// "available" claim carrying no version can never become an honest menu
    /// item, so it must read as no offer at all rather than as a nameless
    /// "something is available".
    #[test]
    fn update_offer_needs_both_a_yes_and_a_version() {
        assert_eq!(offer_from_status(true, Some("0.3.0")), Some("0.3.0".into()));
        assert_eq!(offer_from_status(true, Some("  0.3.0  ")), Some("0.3.0".into()));
        assert_eq!(offer_from_status(true, None), None, "no version, nothing to label");
        assert_eq!(offer_from_status(true, Some("   ")), None);
        assert_eq!(offer_from_status(false, Some("0.3.0")), None, "cleared wins");
        assert_eq!(offer_from_status(false, None), None);
    }

    /// Nothing offers an update until the driver says so — a tray built at
    /// startup carries no update entry.
    #[test]
    fn no_update_is_offered_before_a_check_runs() {
        assert_eq!(offered_update_version(), None);
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
        assert_eq!(monitor_menu_label(&m), "Grid: DISPLAY1 (1920\u{d7}1080, primary)");
    }

    #[test]
    fn monitor_label_secondary_has_no_primary_marker() {
        let m = mon(r"\\.\DISPLAY2@1920,0", 2560, 1440, false);
        assert_eq!(monitor_menu_label(&m), "Grid: DISPLAY2 (2560\u{d7}1440)");
    }

    #[test]
    fn monitor_label_survives_ids_without_device_prefix() {
        let m = mon("odd-id@0,0", 800, 600, false);
        assert_eq!(monitor_menu_label(&m), "Grid: odd-id (800\u{d7}600)");
    }

    // -- monitor cache (tray hot path) ---------------------------------------

    #[test]
    fn monitor_cache_serves_the_last_refreshed_topology() {
        let mons = vec![
            mon(r"\\.\DISPLAY1@0,0", 1920, 1080, true),
            mon(r"\\.\DISPLAY2@1920,0", 2560, 1440, false),
        ];
        refresh_monitor_cache(&mons);
        assert_eq!(cached_monitors(), mons, "cache round-trips the refresh");
        let smaller = vec![mon(r"\\.\DISPLAY1@0,0", 1920, 1080, true)];
        refresh_monitor_cache(&smaller);
        assert_eq!(cached_monitors(), smaller, "a new refresh replaces the cache");
    }

    // -- tray tooltip (spec §5.4 grid-full hint) ------------------------------

    #[test]
    fn tray_tooltip_names_idle_grids_and_prefers_floating() {
        // An enabled grid with no windows on its monitor is the "I clicked
        // the tray item and nothing happened" case (defect 3): it must say so.
        assert_eq!(
            tray_tooltip(0, 1),
            "Griddle WM — a grid is enabled on a monitor with no windows on it yet",
        );
        assert_eq!(
            tray_tooltip(0, 2),
            "Griddle WM — 2 grids are enabled on monitors with no windows on them yet",
        );
        // A window that did not fit is a live misbehaviour and outranks an
        // idle grid, which is merely waiting.
        assert_eq!(
            tray_tooltip(1, 3),
            "Griddle WM — 1 window didn't fit its grid and floats free",
        );
    }

    #[test]
    fn tray_tooltip_names_grid_full_floating_windows() {
        assert_eq!(tray_tooltip(0, 0), "Griddle WM");
        assert_eq!(
            tray_tooltip(1, 0),
            "Griddle WM — 1 window didn't fit its grid and floats free"
        );
        assert_eq!(
            tray_tooltip(3, 0),
            "Griddle WM — 3 windows didn't fit their grid and float free"
        );
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

    // -- WebView2 browser args (QA 2026-08-19 regression) --------------------

    fn window_cfg(label: &str, args: Option<&str>) -> tauri::utils::config::WindowConfig {
        tauri::utils::config::WindowConfig {
            label: label.into(),
            additional_browser_args: args.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn browser_args_come_from_the_named_window() {
        let windows = vec![
            window_cfg("other", Some("--nope")),
            window_cfg(crate::guard::MAIN_LABEL, Some("--disable-features=X --flag")),
        ];
        assert_eq!(
            browser_args_of(&windows, crate::guard::MAIN_LABEL).as_deref(),
            Some("--disable-features=X --flag"),
        );
    }

    #[test]
    fn browser_args_absent_when_unset_or_unknown() {
        let windows = vec![window_cfg(crate::guard::MAIN_LABEL, None)];
        assert_eq!(browser_args_of(&windows, crate::guard::MAIN_LABEL), None);
        assert_eq!(browser_args_of(&windows, "settings"), None);
    }

    /// The whole fix rests on the brain declaring args that every other window
    /// must then repeat: WebView2 pins its browser process to the first
    /// environment's arguments and refuses any later one that differs, so a
    /// window built without them dies right after its native frame appears.
    /// If this assertion ever fails the helper has quietly become a no-op --
    /// either restore the declaration or drop the args everywhere at once.
    #[test]
    fn the_shipped_config_declares_brain_browser_args() {
        let raw = include_str!("../tauri.conf.json");
        let cfg: serde_json::Value = serde_json::from_str(raw).expect("tauri.conf.json parses");
        let windows = cfg["app"]["windows"].as_array().expect("app.windows array");
        let brain = windows
            .iter()
            .find(|w| w["label"] == crate::guard::MAIN_LABEL)
            .expect("a window labelled `main`");
        let args = brain["additionalBrowserArgs"]
            .as_str()
            .expect("the brain declares additionalBrowserArgs");
        assert!(
            args.contains("--disable-background-timer-throttling"),
            "the hidden brain must stay unthrottled; got {args:?}",
        );
    }
}
