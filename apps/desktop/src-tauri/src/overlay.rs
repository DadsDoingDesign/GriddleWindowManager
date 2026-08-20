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
//! Click-through: Tauri's builder provides `transparent + no decorations +
//! always-on-top + skip-taskbar + not-focusable`; on top of that the window
//! ex-style is extended with `WS_EX_LAYERED | WS_EX_TRANSPARENT |
//! WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` (plus `SetLayeredWindowAttributes`
//! alpha 255 — a layered window is never painted until its attributes are
//! set) so the window is invisible to hit-testing, activation and Alt-Tab.
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
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::ipc::MonitorInfo;

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
/// Monotonic label counter; labels are never reused even if a window died.
static NEXT_LABEL: AtomicUsize = AtomicUsize::new(0);

fn registry() -> &'static Mutex<HashMap<String, String>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Move/size the overlay to the monitor's current full bounds (physical px).
fn position_to(win: &WebviewWindow, mon: &MonitorInfo) -> Result<(), String> {
    win.set_position(tauri::PhysicalPosition::new(mon.x, mon.y))
        .map_err(|e| format!("overlay set_position failed: {e}"))?;
    win.set_size(tauri::PhysicalSize::new(mon.width as u32, mon.height as u32))
        .map_err(|e| format!("overlay set_size failed: {e}"))?;
    Ok(())
}

/// Apply the click-through ex-style bits to a freshly created overlay window.
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

/// Find-or-create the overlay window for `monitor_id`, hidden, positioned at
/// the monitor's current full bounds, with click-through styles applied.
fn ensure_overlay(app: &AppHandle, monitor_id: &str) -> Result<WebviewWindow, String> {
    let mon = crate::monitors::enumerate()
        .into_iter()
        .find(|m| m.id == monitor_id)
        .ok_or_else(|| format!("show/hide_overlay: unknown monitor id {monitor_id:?}"))?;

    let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(label) = reg.get(monitor_id) {
        if let Some(win) = app.get_webview_window(label) {
            position_to(&win, &mon)?;
            return Ok(win);
        }
        // The window died (webview crash); drop the stale entry and recreate.
        reg.remove(monitor_id);
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
    apply_click_through(&win)?;
    log::info!("created overlay window {label} for monitor {monitor_id}");
    reg.insert(monitor_id.to_string(), label);
    Ok(win)
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
        .map_err(|e| format!("overlay show failed: {e}"))
}

/// Contract §C2: `hide_overlay(monitor_id)`. Creates the window hidden if it
/// does not exist yet (pre-warm; see module docs). Brain-host only (security
/// review: least privilege).
#[tauri::command]
pub async fn hide_overlay(
    app: AppHandle,
    window: tauri::Window,
    monitor_id: String,
) -> Result<(), String> {
    crate::guard::authorize("hide_overlay", window.label())?;
    let win = ensure_overlay(&app, &monitor_id)?;
    log::debug!("hide_overlay: {monitor_id}");
    win.hide()
        .map_err(|e| format!("overlay hide failed: {e}"))
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
        };
        assert!(
            !is_eligible_probe(&probe, 999, &[]),
            "overlay ex-style must be ineligible even for a foreign pid"
        );

        // Sanity: the same window without the overlay bits would be managed,
        // proving the ex-style is what excludes it.
        let plain = WindowProbe { exstyle: 0, ..probe };
        assert!(is_eligible_probe(&plain, 999, &[]));
    }

    /// Overlay windows also run in our own process, so the own-pid rule
    /// excludes them independently of their styles.
    #[test]
    fn own_pid_excludes_overlay_windows_independently() {
        let probe = WindowProbe {
            style: style_bits::WS_VISIBLE | style_bits::WS_CAPTION,
            exstyle: 0,
            cloaked: false,
            pid: 999,
            exe: Some("griddle-wm.exe".into()),
        };
        assert!(!is_eligible_probe(&probe, 999, &[]));
    }
}
