//! Per-gridded-monitor drag overlay webviews (plan Task 15, spec §4.2).
//!
//! Each gridded monitor gets one transparent, undecorated, always-on-top,
//! click-through webview window covering the monitor's *full* bounds and
//! loading `/overlay?monitorId=<monitorId>` (the page resolves the covering
//! grid — per-monitor or spanning — from the broadcast state snapshot). The
//! brain host shows it when a
//! managed drag starts (`show_overlay`) and hides it shortly after the drag
//! commits (`hide_overlay`), leaving the overlay page time to play its fade.
//!
//! Click-through, and why it is set twice (field failure 2026-11-07): tao
//! recomputes the *entire* `GWL_EXSTYLE` from its own flag set every time any
//! flag changes — and `show()`/`hide()` flip the VISIBLE flag — so bits we
//! poke in with `SetWindowLongPtrW` survive only until the first show. A
//! shipped overlay therefore lost `WS_EX_TRANSPARENT` on its first drag and,
//! when a hide was missed, sat invisible over a whole monitor eating every
//! click. The durable half is tao's own `IGNORE_CURSOR_EVENT` flag
//! (`set_ignore_cursor_events(true)`), which tao folds into every rewrite as
//! `WS_EX_TRANSPARENT | WS_EX_LAYERED`. On top of that the ex-style is
//! extended with `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` (plus
//! `SetLayeredWindowAttributes` alpha 255 — a layered window is never painted
//! until its attributes are set), re-asserted on the main thread after every
//! show, and *verified*: a show that leaves `WS_EX_TRANSPARENT` missing is an
//! ERROR in the log, not a silent regression.
//!
//! Lifetime safety net: an overlay is a drag-time preview and must never
//! outlive its drag. Three independent guards enforce that:
//! 1. `hide_overlay` hides by window label even when the monitor id it was
//!    created for no longer enumerates (a topology change mid-drag renames
//!    monitors; the old code failed the lookup and left the window up).
//! 2. [`hide_all`] runs on every display-topology change.
//! 3. A watchdog thread hides any overlay shown for longer than
//!    [`OVERLAY_MAX_LINGER`] while no drag is in progress.
//! Whenever Rust hides an overlay on its own initiative it emits
//! [`events::OVERLAY_HIDDEN`] to the brain host so the host's shown-set stays
//! truthful and the next drag shows the overlay again.
//!
//! Overlay windows are excluded from tracker eligibility twice over: they
//! belong to our own pid *and* they carry `WS_EX_TOOLWINDOW` (both asserted
//! in the tests below).
//!
//! Contract C2 extension (documented in the plan): `hide_overlay` deliberately
//! *creates* the window (hidden) when it does not exist yet — the brain host
//! calls it for every gridded monitor at startup / grid-enable to pre-warm the
//! webview so the first drag never waits for WebView2 to spin up. Both
//! commands re-position the window to the monitor's current bounds, keeping
//! overlays correct across topology changes.
//!
//! Note on the actuator-only `SetWindowPos` rule (plan global constraints):
//! the `SWP_FRAMECHANGED` flush below targets our *own* overlay window, never
//! a managed one — the rule restricts moving managed windows only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::ipc::{events, MonitorInfo, OverlayHidden};

/// Extended-style bits added to every overlay window, mirrored as plain
/// integer constants (canonical WinUser.h values) so the composition logic is
/// a pure, unit-testable function on any platform.
pub mod exstyle_bits {
    /// `WS_EX_TRANSPARENT` — invisible to hit-testing (clicks fall through).
    pub const WS_EX_TRANSPARENT: isize = 0x0000_0020;
    /// `WS_EX_TOOLWINDOW` — no Alt-Tab entry; also makes the tracker's
    /// eligibility filter reject the window outright.
    pub const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    /// `WS_EX_LAYERED` — required for `WS_EX_TRANSPARENT` to reliably pass
    /// mouse input through on modern Windows.
    pub const WS_EX_LAYERED: isize = 0x0008_0000;
    /// `WS_EX_NOACTIVATE` — showing the window never steals focus.
    pub const WS_EX_NOACTIVATE: isize = 0x0800_0000;
}

/// The full click-through combination applied to overlay windows.
pub const OVERLAY_EXSTYLE: isize = exstyle_bits::WS_EX_TRANSPARENT
    | exstyle_bits::WS_EX_TOOLWINDOW
    | exstyle_bits::WS_EX_LAYERED
    | exstyle_bits::WS_EX_NOACTIVATE;

/// Pure ex-style composition: keep whatever Tauri/tao already set and add the
/// click-through bits. Idempotent.
pub fn with_overlay_exstyle(exstyle: isize) -> isize {
    exstyle | OVERLAY_EXSTYLE
}

/// Which of [`OVERLAY_EXSTYLE`]'s bits `exstyle` lacks. Zero means the window
/// is click-through as designed; a set `WS_EX_TRANSPARENT` bit here is the
/// 2026-11-07 field failure (tao rewrote the ex-style behind our back).
pub fn missing_click_through_bits(exstyle: isize) -> isize {
    OVERLAY_EXSTYLE & !exstyle
}

/// Longest an overlay may stay shown with no drag in progress before the
/// watchdog hides it. Must cover the host's longest post-drag notice
/// (`ELEVATED_NOTICE_MS` 3200 ms, `REFUSAL_LINGER_MS` 1500 ms + fade) with
/// room for a slow main thread; asserted in the tests.
pub const OVERLAY_MAX_LINGER: Duration = Duration::from_secs(6);
/// How often the watchdog looks.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

/// Pure watchdog rule: hide an overlay that has been shown for `shown_for`
/// unless a managed drag is in progress (a drag may legitimately last as
/// long as the user likes).
pub fn watchdog_should_hide(shown_for: Duration, drag_active: bool) -> bool {
    !drag_active && shown_for >= OVERLAY_MAX_LINGER
}

/// Percent-encode every byte outside the RFC 3986 unreserved set. Monitor ids
/// contain `\`, `.`, `@`, `,` and (in grid ids) `:`, none of which are safe to
/// splice into a query string verbatim.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Route loaded by the overlay window for `monitor_id` — `/overlay` with the
/// *monitor* id in the query. The page resolves which enabled grid covers
/// that monitor (per-monitor or spanning) from the broadcast state snapshot,
/// so spanning grids get a working overlay on every member monitor.
pub fn overlay_url(monitor_id: &str) -> String {
    format!("/overlay?monitorId={}", percent_encode(monitor_id))
}

/// monitor id -> window label for overlays created so far.
static REGISTRY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
/// window label -> when `show_overlay` last showed it. Absent = hidden (as
/// far as Rust knows). Read by the watchdog.
static SHOWN_AT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
/// Monotonic label counter; labels are never reused even if a window died.
static NEXT_LABEL: AtomicUsize = AtomicUsize::new(0);

fn registry() -> &'static Mutex<HashMap<String, String>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shown_at() -> &'static Mutex<HashMap<String, Instant>> {
    SHOWN_AT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Move/size the overlay to the monitor's current full bounds (physical px).
fn position_to(win: &WebviewWindow, mon: &MonitorInfo) -> Result<(), String> {
    win.set_position(tauri::PhysicalPosition::new(mon.x, mon.y))
        .map_err(|e| format!("overlay set_position failed: {e}"))?;
    win.set_size(tauri::PhysicalSize::new(mon.width as u32, mon.height as u32))
        .map_err(|e| format!("overlay set_size failed: {e}"))?;
    Ok(())
}

/// Current `GWL_EXSTYLE` of the overlay's hwnd.
#[cfg(windows)]
fn read_exstyle(win: &WebviewWindow) -> Result<isize, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};
    let raw = win
        .hwnd()
        .map_err(|e| format!("overlay hwnd() failed: {e}"))?
        .0 as isize;
    Ok(unsafe { GetWindowLongPtrW(HWND(raw as *mut core::ffi::c_void), GWL_EXSTYLE) })
}

#[cfg(not(windows))]
fn read_exstyle(_win: &WebviewWindow) -> Result<isize, String> {
    Ok(OVERLAY_EXSTYLE)
}

/// Apply the click-through ex-style bits to an overlay window. Idempotent;
/// called at creation and again after every show (see module docs).
#[cfg(windows)]
fn apply_click_through(win: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
        GWL_EXSTYLE, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER,
    };

    let raw = win
        .hwnd()
        .map_err(|e| format!("overlay hwnd() failed: {e}"))?
        .0 as isize;
    let hwnd = HWND(raw as *mut core::ffi::c_void);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, with_overlay_exstyle(ex));
        // A WS_EX_LAYERED window is not painted until its attributes are set;
        // alpha 255 keeps the webview's own per-pixel transparency intact.
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)
            .map_err(|e| format!("SetLayeredWindowAttributes failed: {e}"))?;
        // Flush the cached frame styles (recommended after SetWindowLongPtrW).
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("SetWindowPos(SWP_FRAMECHANGED) failed: {e}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_click_through(_win: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Make the window click-through in a way that survives tao's ex-style
/// rewrites (the `IGNORE_CURSOR_EVENT` flag) and then add our own bits.
fn make_click_through(win: &WebviewWindow) -> Result<(), String> {
    win.set_ignore_cursor_events(true)
        .map_err(|e| format!("overlay set_ignore_cursor_events failed: {e}"))?;
    apply_click_through(win)
}

/// After a show or hide has been processed, check the ex-style tao left
/// behind and restore anything missing. Queued on the main thread *behind*
/// the show/hide message (same event-loop queue, FIFO) so it runs after tao's
/// rewrite, not before it. In practice tao keeps `WS_EX_TRANSPARENT |
/// WS_EX_LAYERED` (they come from its own flag) and drops `WS_EX_TOOLWINDOW`,
/// which this puts back; the error branch is the regression alarm.
fn reassert_click_through(app: &AppHandle, label: String) {
    let app2 = app.clone();
    let label_for_err = label.clone();
    let queued = app.run_on_main_thread(move || {
        let Some(win) = app2.get_webview_window(&label) else {
            return;
        };
        match read_exstyle(&win) {
            Ok(ex) => {
                let missing = missing_click_through_bits(ex);
                if missing & exstyle_bits::WS_EX_TRANSPARENT != 0 {
                    // The 2026-11-07 failure mode. Loud on purpose.
                    log::error!(
                        "overlay {label}: WS_EX_TRANSPARENT missing after show/hide \
                         (exstyle {ex:#x}, missing {missing:#x}); restoring click-through"
                    );
                } else if missing != 0 {
                    log::debug!("overlay {label}: restoring ex-style bits {missing:#x} after show/hide");
                }
            }
            Err(e) => log::error!("overlay {label}: cannot read ex-style after show/hide: {e}"),
        }
        if let Err(e) = apply_click_through(&win) {
            log::error!("overlay {label}: re-applying click-through failed: {e}");
        }
    });
    if let Err(e) = queued {
        log::error!("overlay {label_for_err}: run_on_main_thread failed: {e}");
    }
}

/// The monitor `monitor_id` currently enumerates as, if it still exists.
fn find_monitor(monitor_id: &str) -> Option<MonitorInfo> {
    crate::monitors::enumerate()
        .into_iter()
        .find(|m| m.id == monitor_id)
}

/// The live overlay window registered for `monitor_id`, if any. A dead
/// registry entry (webview crash) is dropped here so the caller recreates.
fn existing_overlay(app: &AppHandle, monitor_id: &str) -> Option<WebviewWindow> {
    let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    let label = reg.get(monitor_id)?.clone();
    match app.get_webview_window(&label) {
        Some(win) => Some(win),
        None => {
            reg.remove(monitor_id);
            None
        }
    }
}

/// Find-or-create the overlay window for `monitor_id`, hidden, positioned at
/// the monitor's current full bounds, with click-through styles applied.
fn ensure_overlay(app: &AppHandle, monitor_id: &str) -> Result<WebviewWindow, String> {
    let mon = find_monitor(monitor_id)
        .ok_or_else(|| format!("show/hide_overlay: unknown monitor id {monitor_id:?}"))?;

    if let Some(win) = existing_overlay(app, monitor_id) {
        position_to(&win, &mon)?;
        return Ok(win);
    }

    let label = format!("overlay-{}", NEXT_LABEL.fetch_add(1, Ordering::SeqCst));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(overlay_url(monitor_id).into()))
        .title("Griddle Window Manager Overlay")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .accept_first_mouse(false)
        .visible(false);
    // Same WebView2 constraint the settings window hit: an overlay built
    // without the brain's browser args is refused by the already-running
    // browser process, so the drag preview would never appear.
    if let Some(args) = crate::shell::brain_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let win = builder
        .build()
        .map_err(|e| format!("overlay window build failed: {e}"))?;
    position_to(&win, &mon)?;
    make_click_through(&win)?;
    log::info!("created overlay window {label} for monitor {monitor_id}");
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(monitor_id.to_string(), label);
    Ok(win)
}

/// Hide one overlay window and forget its shown-time.
fn hide_window(win: &WebviewWindow) -> Result<(), String> {
    shown_at()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(win.label());
    win.hide().map_err(|e| format!("overlay hide failed: {e}"))?;
    reassert_click_through(win.app_handle(), win.label().to_string());
    Ok(())
}

/// Tell the brain host that Rust hid an overlay on its own initiative, so the
/// host's shown-set forgets it and the next drag shows it again.
fn notify_hidden(app: &AppHandle, monitor_id: &str, reason: &str) {
    let payload = OverlayHidden {
        monitor_id: monitor_id.to_string(),
        reason: reason.to_string(),
    };
    if let Err(e) = app.emit_to(crate::guard::MAIN_LABEL, events::OVERLAY_HIDDEN, payload) {
        log::error!("failed to emit {}: {e}", events::OVERLAY_HIDDEN);
    }
}

/// Hide every overlay Rust knows about. Safe to call from any thread (tauri
/// marshals `hide` to the main thread). Returns how many were *shown* before.
pub fn hide_all(app: &AppHandle, reason: &str) -> usize {
    let entries: Vec<(String, String)> = registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|(m, l)| (m.clone(), l.clone()))
        .collect();
    let mut were_shown = 0usize;
    for (monitor_id, label) in entries {
        let Some(win) = app.get_webview_window(&label) else {
            continue;
        };
        let was_shown = shown_at()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&label);
        if let Err(e) = hide_window(&win) {
            log::error!("hide_all ({reason}): {label}: {e}");
            continue;
        }
        if was_shown {
            were_shown += 1;
            notify_hidden(app, &monitor_id, reason);
        }
    }
    if were_shown > 0 {
        log::info!("hid {were_shown} shown overlay(s): {reason}");
    }
    were_shown
}

/// Spawn the overlay watchdog thread (module docs, guard 3).
pub fn start_overlay_watchdog(app: AppHandle) {
    if let Err(e) = std::thread::Builder::new()
        .name("overlay-watchdog".into())
        .spawn(move || watchdog_loop(&app))
    {
        log::error!("failed to spawn overlay-watchdog thread: {e}");
    }
}

fn watchdog_loop(app: &AppHandle) {
    loop {
        std::thread::sleep(WATCHDOG_INTERVAL);
        if crate::shell::is_exiting() {
            return;
        }
        let drag_active = crate::drag_pump::any_drag_active();
        let now = Instant::now();
        let stale: Vec<(String, Duration)> = shown_at()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter_map(|(label, since)| {
                let shown_for = now.saturating_duration_since(*since);
                watchdog_should_hide(shown_for, drag_active).then(|| (label.clone(), shown_for))
            })
            .collect();
        for (label, shown_for) in stale {
            let monitor_id = registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .find(|(_, l)| **l == label)
                .map(|(m, _)| m.clone())
                .unwrap_or_default();
            log::warn!(
                "overlay {label} ({monitor_id}) shown for {shown_for:?} with no drag in \
                 progress; hiding it (watchdog)"
            );
            match app.get_webview_window(&label) {
                Some(win) => {
                    if let Err(e) = hide_window(&win) {
                        log::error!("watchdog: {label}: {e}");
                    } else {
                        notify_hidden(app, &monitor_id, "watchdog");
                    }
                }
                None => {
                    // Window is gone; just forget it.
                    shown_at()
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(&label);
                }
            }
        }
    }
}

/// Contract §C2: `show_overlay(monitor_id)`. Async on purpose: creating a
/// webview window inside a synchronous command deadlocks on Windows.
/// Brain-host only (security review: least privilege).
#[tauri::command]
pub async fn show_overlay(
    app: AppHandle,
    window: tauri::Window,
    monitor_id: String,
) -> Result<(), String> {
    crate::guard::authorize("show_overlay", window.label())?;
    let win = ensure_overlay(&app, &monitor_id)?;
    // `ensure_overlay` is shared with `hide_overlay`'s pre-warm, so its
    // "created overlay window" line alone never proves a drag happened.
    // Say which way it went.
    log::debug!("show_overlay: {monitor_id}");
    win.show()
        .map_err(|e| format!("overlay show failed: {e}"))?;
    shown_at()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(win.label().to_string(), Instant::now());
    reassert_click_through(&app, win.label().to_string());
    Ok(())
}

/// Contract §C2: `hide_overlay(monitor_id)`. Creates the window hidden if it
/// does not exist yet (pre-warm; see module docs). Brain-host only (security
/// review: least privilege).
///
/// Hides by *label* first: an overlay that exists must be hidden even when
/// its monitor id no longer enumerates (guard 1 in the module docs).
#[tauri::command]
pub async fn hide_overlay(
    app: AppHandle,
    window: tauri::Window,
    monitor_id: String,
) -> Result<(), String> {
    crate::guard::authorize("hide_overlay", window.label())?;
    log::debug!("hide_overlay: {monitor_id}");
    if let Some(win) = existing_overlay(&app, &monitor_id) {
        hide_window(&win)?;
        // Keep it on its monitor's current bounds if the monitor is still
        // there; a vanished monitor is not an error for a hide.
        if let Some(mon) = find_monitor(&monitor_id) {
            position_to(&win, &mon)?;
        }
        return Ok(());
    }
    let win = ensure_overlay(&app, &monitor_id)?;
    hide_window(&win)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::{is_eligible_probe, style_bits, WindowProbe};

    #[test]
    fn percent_encode_keeps_unreserved_bytes() {
        assert_eq!(
            percent_encode("AZaz09-._~"),
            "AZaz09-._~",
            "unreserved characters must pass through verbatim"
        );
    }

    #[test]
    fn percent_encode_escapes_monitor_id_characters() {
        // Every special character a real monitor id / grid id contains.
        assert_eq!(percent_encode(r"\"), "%5C");
        assert_eq!(percent_encode(":"), "%3A");
        assert_eq!(percent_encode("@"), "%40");
        assert_eq!(percent_encode(","), "%2C");
        assert_eq!(percent_encode(" "), "%20");
    }

    #[test]
    fn percent_encode_escapes_multibyte_utf8_per_byte() {
        // U+00E9 is 0xC3 0xA9 in UTF-8.
        assert_eq!(percent_encode("é"), "%C3%A9");
    }

    #[test]
    fn overlay_url_embeds_the_monitor_id() {
        assert_eq!(
            overlay_url(r"\\.\DISPLAY1@0,0"),
            "/overlay?monitorId=%5C%5C.%5CDISPLAY1%400%2C0"
        );
    }

    #[test]
    fn overlay_url_negative_origin_monitor() {
        assert_eq!(
            overlay_url(r"\\.\DISPLAY2@-1920,-240"),
            "/overlay?monitorId=%5C%5C.%5CDISPLAY2%40-1920%2C-240"
        );
    }

    #[test]
    fn with_overlay_exstyle_sets_all_click_through_bits() {
        let ex = with_overlay_exstyle(0);
        assert_ne!(ex & exstyle_bits::WS_EX_TRANSPARENT, 0);
        assert_ne!(ex & exstyle_bits::WS_EX_TOOLWINDOW, 0);
        assert_ne!(ex & exstyle_bits::WS_EX_LAYERED, 0);
        assert_ne!(ex & exstyle_bits::WS_EX_NOACTIVATE, 0);
    }

    #[test]
    fn with_overlay_exstyle_preserves_existing_bits_and_is_idempotent() {
        // WS_EX_APPWINDOW as a stand-in for "whatever tao already set".
        let existing = 0x0004_0000;
        let once = with_overlay_exstyle(existing);
        assert_eq!(once & existing, existing, "existing bits preserved");
        assert_eq!(with_overlay_exstyle(once), once, "idempotent");
    }

    /// Spec §4.2 / plan Task 15: overlay windows must be excluded from
    /// tracker eligibility. Even if the pid check were bypassed, the
    /// `WS_EX_TOOLWINDOW` bit alone rejects the window.
    #[test]
    fn overlay_exstyle_makes_window_ineligible_regardless_of_pid() {
        let probe = WindowProbe {
            style: style_bits::WS_VISIBLE | style_bits::WS_CAPTION,
            exstyle: with_overlay_exstyle(0) as u32,
            cloaked: false,
            pid: 4242, // a *foreign* pid on purpose
            exe: Some("griddle-wm.exe".into()),
            elevated: false,
        };
        assert!(
            !is_eligible_probe(&probe, 999, &[], false),
            "overlay ex-style must be ineligible even for a foreign pid"
        );

        // Sanity: the same window without the overlay bits would be managed,
        // proving the ex-style is what excludes it.
        let plain = WindowProbe { exstyle: 0, ..probe };
        assert!(is_eligible_probe(&plain, 999, &[], false));
    }

    /// Overlay windows also run in our own process, so the own-pid rule
    /// excludes them independently of their styles — and the spec 2026-08-20
    /// Settings carve-out must not weaken that: it is keyed to the settings
    /// window's exact hwnd, so an overlay is never the allowed one.
    #[test]
    fn own_pid_excludes_overlay_windows_independently() {
        let probe = WindowProbe {
            style: style_bits::WS_VISIBLE | style_bits::WS_CAPTION,
            exstyle: 0,
            cloaked: false,
            pid: 999,
            exe: Some("griddle-wm.exe".into()),
            elevated: false,
        };
        assert!(!is_eligible_probe(&probe, 999, &[], false));
    }

    // -- 2026-11-07 field failure: overlay swallowed every click ------------
    //
    // tao recomputes the whole GWL_EXSTYLE from its own flags on every
    // show()/hide() (tao 0.35 `WindowState::apply_diff`), so the bits
    // `apply_click_through` set once at creation were wiped the first time
    // the overlay was shown. The stuck overlay carried exactly tao's own
    // output: WS_EX_TOPMOST | WS_EX_NOACTIVATE, nothing else.

    /// What tao's `to_window_styles` leaves on an always-on-top,
    /// non-focusable window: the ex-style the stuck overlay actually had.
    const TAO_REWRITTEN_EXSTYLE: isize = 0x0000_0008 /* WS_EX_TOPMOST */
        | exstyle_bits::WS_EX_NOACTIVATE;

    #[test]
    fn tao_rewrite_strips_our_click_through_bits() {
        // Simulate: we set our bits, then tao rewrites from its flags.
        let ours = with_overlay_exstyle(TAO_REWRITTEN_EXSTYLE);
        let after_tao = TAO_REWRITTEN_EXSTYLE;
        assert_eq!(missing_click_through_bits(ours), 0, "fresh overlay is complete");
        assert_ne!(
            missing_click_through_bits(after_tao) & exstyle_bits::WS_EX_TRANSPARENT,
            0,
            "the rewrite must be detected as a missing WS_EX_TRANSPARENT"
        );
    }

    #[test]
    fn missing_click_through_bits_reports_exactly_what_is_absent() {
        let only_transparent_missing = OVERLAY_EXSTYLE & !exstyle_bits::WS_EX_TRANSPARENT;
        assert_eq!(
            missing_click_through_bits(only_transparent_missing),
            exstyle_bits::WS_EX_TRANSPARENT
        );
        assert_eq!(missing_click_through_bits(0), OVERLAY_EXSTYLE);
        assert_eq!(missing_click_through_bits(OVERLAY_EXSTYLE | 0x8), 0);
    }

    // -- Watchdog: a shown overlay must never outlive its drag ---------------

    #[test]
    fn watchdog_leaves_a_fresh_overlay_alone() {
        assert!(!watchdog_should_hide(Duration::from_secs(1), false));
        assert!(!watchdog_should_hide(OVERLAY_MAX_LINGER - Duration::from_millis(1), false));
    }

    #[test]
    fn watchdog_hides_a_lingering_overlay_when_no_drag_is_active() {
        assert!(watchdog_should_hide(OVERLAY_MAX_LINGER, false));
        assert!(watchdog_should_hide(Duration::from_secs(3600), false));
    }

    #[test]
    fn watchdog_never_hides_during_a_live_drag() {
        assert!(!watchdog_should_hide(Duration::from_secs(3600), true));
    }

    #[test]
    fn linger_budget_covers_the_longest_post_drag_notice() {
        // host.ts: REFUSAL_LINGER_MS 1500 + OVERLAY_FADE_OUT_MS 200, and
        // ELEVATED_NOTICE_MS 3200 — the watchdog must not cut those short.
        assert!(OVERLAY_MAX_LINGER >= Duration::from_millis(3200 + 200 + 1000));
    }
}
