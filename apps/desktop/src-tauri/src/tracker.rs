//! Native window tracking (plan Task 10, spec §5.1).
//!
//! Three layers:
//!
//! 1. **Pure eligibility filter** — [`is_eligible_probe`] decides managed-or-not
//!    from a [`WindowProbe`] (style/exstyle bits, cloak state, owning pid, exe
//!    basename) with zero Win32 calls, so the spec §5.1 truth table is unit
//!    tested with synthetic bitmasks on any platform.
//! 2. **Snapshotting** — [`snapshot`] walks top-level windows via `EnumWindows`,
//!    keeps the eligible ones, and maps each to the contract C1 `WindowInfo`
//!    shape (`DWMWA_EXTENDED_FRAME_BOUNDS` rects in physical virtual-desktop
//!    pixels, exe via `QueryFullProcessImageNameW`, `resizable` from
//!    `WS_THICKFRAME`). The result also reseeds the live eligible set.
//! 3. **Event pump** — [`start_tracker`] installs `SetWinEventHook`
//!    (`WINEVENT_OUTOFCONTEXT`) hooks on a dedicated message-pump thread for
//!    CREATE/DESTROY/SHOW/HIDE, CLOAKED/UNCLOAKED, MINIMIZESTART/END and
//!    MOVESIZESTART/END, translating them into the contract C2 events
//!    (`window-appeared`, `window-destroyed`, `window-minimized`,
//!    `window-restored`, `movesize-start`, `movesize-end`). SHOW/HIDE are
//!    hooked in addition to the plan's list because `EVENT_OBJECT_CREATE`
//!    fires before most windows become visible (and thus eligible) — a window
//!    that turns visible later would otherwise never appear. HIDE/CLOAKED map
//!    to `window-destroyed` (the window left the managed universe), matching
//!    UNCLOAKED/SHOW mapping to `window-appeared`.
//!
//! The live eligible set (`HWND -> WindowInfo` behind a `Mutex`) is the
//! authority the contract C2 security rule checks against: `apply_layout` /
//! `focus_window` (Task 11) must refuse hwnds that are not in this set.

use crate::ipc::WindowInfo;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Win32 style bits used by the eligibility filter, mirrored as plain `u32`
/// constants so the pure filter and its truth-table tests need no Win32
/// bindings. Values are the canonical WinUser.h definitions.
pub mod style_bits {
    /// `WS_VISIBLE`
    pub const WS_VISIBLE: u32 = 0x1000_0000;
    /// `WS_CHILD` — set on non-top-level windows.
    pub const WS_CHILD: u32 = 0x4000_0000;
    /// `WS_CAPTION` == `WS_BORDER | WS_DLGFRAME`; both bits must be set.
    pub const WS_CAPTION: u32 = 0x00C0_0000;
    /// `WS_THICKFRAME` — resizable sizing border.
    pub const WS_THICKFRAME: u32 = 0x0004_0000;
    /// `WS_EX_TOOLWINDOW` — floating toolbars/palettes, never managed.
    pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    /// `WS_EX_APPWINDOW` — forces a taskbar button; treated like a caption.
    pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
}

/// Everything the eligibility filter needs to know about a window, gathered
/// in one place so the decision itself is a pure function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowProbe {
    /// `GWL_STYLE` bits.
    pub style: u32,
    /// `GWL_EXSTYLE` bits.
    pub exstyle: u32,
    /// `DwmGetWindowAttribute(DWMWA_CLOAKED) != 0` (UWP ghosts, other
    /// virtual desktops).
    pub cloaked: bool,
    /// Owning process id from `GetWindowThreadProcessId`.
    pub pid: u32,
    /// Lowercase exe basename (e.g. `"slack.exe"`), or `None` when the
    /// process cannot be queried (elevated beyond us / protected) — such
    /// windows are ineligible per spec §5.1/§7 (we could not move them
    /// anyway).
    pub exe: Option<String>,
}

/// Spec §5.1 eligibility, as a pure function. Managed iff: visible, top-level
/// (not `WS_CHILD`), not DWM-cloaked, not `WS_EX_TOOLWINDOW`, has a full
/// caption or is `WS_EX_APPWINDOW`-styled, belongs to a real foreign process
/// (`pid != 0`, `pid != own_pid`) whose exe could be queried and is not in
/// the user's exclusion list.
pub fn is_eligible_probe(probe: &WindowProbe, own_pid: u32, exclusions: &[String]) -> bool {
    use style_bits::*;
    let visible = probe.style & WS_VISIBLE != 0;
    let top_level = probe.style & WS_CHILD == 0;
    let tool_window = probe.exstyle & WS_EX_TOOLWINDOW != 0;
    let has_caption = probe.style & WS_CAPTION == WS_CAPTION;
    let app_window = probe.exstyle & WS_EX_APPWINDOW != 0;
    let Some(exe) = probe.exe.as_deref() else {
        return false;
    };
    visible
        && top_level
        && !probe.cloaked
        && !tool_window
        && (has_caption || app_window)
        && probe.pid != 0
        && probe.pid != own_pid
        && !exclusions.iter().any(|excluded| excluded == exe)
}

// ---------------------------------------------------------------------------
// Live eligible set + exclusions (platform-independent state)
// ---------------------------------------------------------------------------

fn tracked_map() -> &'static Mutex<HashMap<isize, WindowInfo>> {
    static MAP: OnceLock<Mutex<HashMap<isize, WindowInfo>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exclusions_lock() -> &'static Mutex<Vec<String>> {
    static EXCL: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    EXCL.get_or_init(|| Mutex::new(Vec::new()))
}

/// Replace the exclusion list (lowercase exe basenames). Called when config
/// loads/changes (Task 12+); entries are normalized to lowercase here so the
/// pure filter can compare verbatim.
pub fn set_exclusions(exes: Vec<String>) {
    let mut lock = exclusions_lock().lock().unwrap_or_else(|p| p.into_inner());
    *lock = exes.into_iter().map(|e| e.to_ascii_lowercase()).collect();
}

/// Current exclusion list (lowercase exe basenames).
pub fn exclusions() -> Vec<String> {
    exclusions_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Contract C2 security rule: is this hwnd in the live eligible set?
/// Consulted by `apply_layout` / `focus_window` (Task 11).
pub fn is_tracked(hwnd: isize) -> bool {
    tracked_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(&hwnd)
}

/// Last-known `WindowInfo` for a tracked hwnd.
pub fn tracked_window(hwnd: isize) -> Option<WindowInfo> {
    tracked_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&hwnd)
        .cloned()
}

/// All currently tracked windows (order unspecified).
pub fn tracked_windows() -> Vec<WindowInfo> {
    tracked_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect()
}

fn insert_tracked(hwnd: isize, info: WindowInfo) {
    tracked_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(hwnd, info);
}

fn remove_tracked(hwnd: isize) -> Option<WindowInfo> {
    tracked_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&hwnd)
}

fn reseed_tracked(windows: &[WindowInfo]) {
    let mut lock = tracked_map().lock().unwrap_or_else(|p| p.into_inner());
    lock.clear();
    for w in windows {
        if let Ok(key) = w.hwnd.parse::<isize>() {
            lock.insert(key, w.clone());
        }
    }
}

/// Serializes tests that touch the (process-global) live eligible set;
/// cargo runs `#[test]`s on parallel threads within one process.
#[cfg(test)]
pub(crate) fn live_set_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Contract §C2: `list_windows() -> WindowInfo[]`. Takes a fresh snapshot so
/// callers always see the current desktop (and the live set is resynced).
#[tauri::command]
pub fn list_windows() -> Vec<WindowInfo> {
    snapshot()
}

#[cfg(windows)]
pub use win::{is_eligible, snapshot, start_tracker};

#[cfg(not(windows))]
pub fn snapshot() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn start_tracker(_app: tauri::AppHandle) {}

#[cfg(windows)]
mod win {
    use super::{
        exclusions, insert_tracked, is_eligible_probe, is_tracked, remove_tracked, reseed_tracked,
        style_bits, tracked_map, WindowProbe,
    };
    use crate::ipc::{events, HwndPayload, MoveSizeEnd, WindowInfo};
    use crate::monitors::monitor_id;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EnumWindows, GetMessageW, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, TranslateMessage,
        EVENT_OBJECT_CLOAKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
        EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_MINIMIZEEND,
        EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
        GWL_EXSTYLE, GWL_STYLE, MSG, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
        WINEVENT_SKIPOWNPROCESS,
    };

    /// Handle used by the hook callbacks to emit contract C2 events.
    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    // -- probing ------------------------------------------------------------

    /// Lowercase exe basename for a pid, or `None` if the process cannot be
    /// queried (elevated beyond us, protected, or already gone).
    pub(super) fn process_exe(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(handle);
            result.ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let base = path.rsplit(['\\', '/']).next()?.trim().to_ascii_lowercase();
            if base.is_empty() {
                None
            } else {
                Some(base)
            }
        }
    }

    /// Gather the eligibility inputs for a window. `None` if the handle is
    /// no longer a window.
    pub(super) fn probe_window(hwnd: HWND) -> Option<WindowProbe> {
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return None;
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            // Cloak check filters UWP ghost windows and windows on other
            // virtual desktops. A failed call (e.g. DWM unavailable) is
            // treated as "not cloaked".
            let mut cloaked_val: u32 = 0;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked_val as *mut u32 as *mut c_void,
                size_of::<u32>() as u32,
            );
            let mut pid: u32 = 0;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            Some(WindowProbe {
                style,
                exstyle,
                cloaked: cloaked_val != 0,
                pid,
                exe: process_exe(pid),
            })
        }
    }

    /// Spec §5.1 eligibility for a live window handle.
    pub fn is_eligible(hwnd: isize) -> bool {
        let hwnd = HWND(hwnd as *mut c_void);
        let Some(probe) = probe_window(hwnd) else {
            return false;
        };
        is_eligible_probe(&probe, unsafe { GetCurrentProcessId() }, &exclusions())
    }

    // -- WindowInfo construction --------------------------------------------

    /// The visible frame rect: `DWMWA_EXTENDED_FRAME_BOUNDS` (excludes the
    /// invisible resize borders), falling back to `GetWindowRect` when DWM
    /// declines. Physical virtual-desktop pixels either way.
    pub(super) fn extended_frame_bounds(hwnd: HWND) -> Option<RECT> {
        unsafe {
            let mut rect = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut RECT as *mut c_void,
                size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                return Some(rect);
            }
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).ok().map(|()| rect)
        }
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..len.max(0) as usize])
        }
    }

    /// Contract C1 monitor id of the monitor hosting (most of) the window.
    fn monitor_id_of(hwnd: HWND) -> String {
        unsafe {
            let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            if !GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
                .as_bool()
            {
                return String::new();
            }
            let device_len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let device = String::from_utf16_lossy(&info.szDevice[..device_len]);
            let full = info.monitorInfo.rcMonitor;
            monitor_id(&device, full.left, full.top)
        }
    }

    /// Build the contract C1 `WindowInfo` for an (eligible) window.
    pub(super) fn window_info(hwnd: HWND, probe: &WindowProbe) -> Option<WindowInfo> {
        let rect = extended_frame_bounds(hwnd)?;
        let exe = probe.exe.clone()?;
        Some(WindowInfo {
            hwnd: (hwnd.0 as isize).to_string(),
            title: window_title(hwnd),
            exe,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            monitor_id: monitor_id_of(hwnd),
            minimized: unsafe { IsIconic(hwnd) }.as_bool(),
            resizable: probe.style & style_bits::WS_THICKFRAME != 0,
        })
    }

    // -- snapshotting -------------------------------------------------------

    /// Enumerate all eligible top-level windows and resync the live eligible
    /// set to exactly this snapshot.
    pub fn snapshot() -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = Vec::new();
        unsafe {
            // EnumWindows fails only if the callback returns FALSE, which
            // ours never does.
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut out as *mut Vec<WindowInfo> as isize),
            );
        }
        reseed_tracked(&out);
        out
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        if let Some(probe) = probe_window(hwnd) {
            if is_eligible_probe(&probe, GetCurrentProcessId(), &exclusions()) {
                if let Some(info) = window_info(hwnd, &probe) {
                    out.push(info);
                }
            }
        }
        BOOL(1) // keep enumerating
    }

    // -- event pump ---------------------------------------------------------

    /// Seed the live set and start the WinEvent hook thread. Idempotent: a
    /// second call is a no-op.
    pub fn start_tracker(app: AppHandle) {
        if APP_HANDLE.set(app).is_err() {
            log::warn!("tracker already started; ignoring second start");
            return;
        }
        let seeded = snapshot();
        log::info!("tracker seeded with {} eligible window(s)", seeded.len());
        if let Err(e) = std::thread::Builder::new()
            .name("window-tracker".into())
            .spawn(|| unsafe { run_hook_pump() })
        {
            log::error!("failed to spawn window-tracker thread: {e}");
        }
    }

    /// Install the WinEvent hooks and pump messages forever.
    /// `WINEVENT_OUTOFCONTEXT` hooks deliver on the installing thread via its
    /// message loop, so this thread must live for the process lifetime.
    unsafe fn run_hook_pump() {
        // Contiguous ranges covering exactly the events we translate.
        let ranges: [(u32, u32); 4] = [
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            // CREATE(0x8000), DESTROY(0x8001), SHOW(0x8002), HIDE(0x8003)
            (EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE),
            (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
        ];
        let mut installed = 0usize;
        for (min, max) in ranges {
            let hook: HWINEVENTHOOK = SetWinEventHook(
                min,
                max,
                None,
                Some(win_event_proc),
                0, // all processes
                0, // all threads
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_invalid() {
                log::error!("SetWinEventHook({min:#x}..{max:#x}) failed");
            } else {
                installed += 1;
            }
        }
        if installed == 0 {
            log::error!("no WinEvent hooks installed; window tracking disabled");
            return;
        }
        log::info!("window tracker running with {installed} WinEvent hook range(s)");

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                if r.0 < 0 {
                    log::error!(
                        "GetMessageW failed in window tracker: {:?}",
                        windows::core::Error::from_thread()
                    );
                }
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _id_event_thread: u32,
        _time: u32,
    ) {
        // Only whole-window events; child-object noise (scrollbars, carets,
        // accessibility children) is ignored.
        if hwnd.is_invalid() || id_object != OBJID_WINDOW.0 || id_child != 0 {
            return;
        }
        match event {
            EVENT_OBJECT_CREATE | EVENT_OBJECT_SHOW | EVENT_OBJECT_UNCLOAKED => {
                on_appear_candidate(hwnd)
            }
            EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE | EVENT_OBJECT_CLOAKED => on_gone(hwnd),
            EVENT_SYSTEM_MINIMIZESTART => on_minimize(hwnd),
            EVENT_SYSTEM_MINIMIZEEND => on_restore(hwnd),
            EVENT_SYSTEM_MOVESIZESTART => on_movesize_start(hwnd),
            EVENT_SYSTEM_MOVESIZEEND => on_movesize_end(hwnd),
            _ => {}
        }
    }

    fn emit<T: serde::Serialize + Clone>(event: &str, payload: T) {
        let Some(app) = APP_HANDLE.get() else {
            return;
        };
        if let Err(e) = app.emit(event, payload) {
            log::error!("failed to emit {event}: {e}");
        }
    }

    fn on_appear_candidate(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if is_tracked(key) {
            return;
        }
        let Some(probe) = probe_window(hwnd) else {
            return;
        };
        if !is_eligible_probe(&probe, unsafe { GetCurrentProcessId() }, &exclusions()) {
            return;
        }
        let Some(info) = window_info(hwnd, &probe) else {
            return;
        };
        insert_tracked(key, info.clone());
        emit(events::WINDOW_APPEARED, info);
    }

    fn on_gone(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if remove_tracked(key).is_some() {
            emit(
                events::WINDOW_DESTROYED,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
        }
    }

    fn on_minimize(hwnd: HWND) {
        let key = hwnd.0 as isize;
        let mut lock = tracked_map().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(info) = lock.get_mut(&key) {
            info.minimized = true;
            drop(lock);
            emit(
                events::WINDOW_MINIMIZED,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
        }
    }

    fn on_restore(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if !is_tracked(key) {
            // A window we never tracked (e.g. minimized before the tracker
            // started, or newly eligible) — treat restore as appearance.
            on_appear_candidate(hwnd);
            return;
        }
        let Some(probe) = probe_window(hwnd) else {
            return;
        };
        let Some(mut info) = window_info(hwnd, &probe) else {
            return;
        };
        // MINIMIZEEND can race the restore animation; the contract event is
        // definitionally "restored".
        info.minimized = false;
        insert_tracked(key, info.clone());
        emit(events::WINDOW_RESTORED, info);
    }

    fn on_movesize_start(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if is_tracked(key) {
            emit(
                events::MOVESIZE_START,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
        }
    }

    fn on_movesize_end(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if !is_tracked(key) {
            return;
        }
        let Some(rect) = extended_frame_bounds(hwnd) else {
            return;
        };
        let payload = MoveSizeEnd {
            hwnd: key.to_string(),
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        };
        let mut lock = tracked_map().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(info) = lock.get_mut(&key) {
            info.x = payload.x;
            info.y = payload.y;
            info.width = payload.width;
            info.height = payload.height;
        }
        drop(lock);
        emit(events::MOVESIZE_END, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::style_bits::*;
    use super::*;

    /// Pid used as "our own process" throughout the truth table.
    const OWN_PID: u32 = 4242;
    /// Any pid that is not ours.
    const OTHER_PID: u32 = 1337;

    fn probe(style: u32, exstyle: u32) -> WindowProbe {
        WindowProbe {
            style,
            exstyle,
            cloaked: false,
            pid: OTHER_PID,
            exe: Some("notepad.exe".into()),
        }
    }

    /// Style of a plain resizable app window (Notepad-like).
    const APP_STYLE: u32 = WS_VISIBLE | WS_CAPTION | WS_THICKFRAME;

    fn eligible(p: &WindowProbe) -> bool {
        is_eligible_probe(p, OWN_PID, &[])
    }

    // -- spec §5.1 truth table ---------------------------------------------

    #[test]
    fn normal_app_window_is_eligible() {
        assert!(eligible(&probe(APP_STYLE, 0)));
    }

    #[test]
    fn invisible_window_is_ineligible() {
        assert!(!eligible(&probe(WS_CAPTION | WS_THICKFRAME, 0)));
    }

    #[test]
    fn child_window_is_ineligible() {
        assert!(!eligible(&probe(APP_STYLE | WS_CHILD, 0)));
    }

    #[test]
    fn cloaked_window_is_ineligible() {
        let mut p = probe(APP_STYLE, 0);
        p.cloaked = true;
        assert!(!eligible(&p));
    }

    #[test]
    fn tool_window_is_ineligible() {
        assert!(!eligible(&probe(APP_STYLE, WS_EX_TOOLWINDOW)));
    }

    #[test]
    fn tool_window_beats_app_window_flag() {
        // WS_EX_TOOLWINDOW excludes even when WS_EX_APPWINDOW is also set.
        assert!(!eligible(&probe(
            APP_STYLE,
            WS_EX_TOOLWINDOW | WS_EX_APPWINDOW
        )));
    }

    #[test]
    fn captionless_popup_is_ineligible() {
        // Splash screens / borderless popups float free (spec §5.1).
        assert!(!eligible(&probe(WS_VISIBLE, 0)));
    }

    #[test]
    fn partial_caption_bits_do_not_count_as_caption() {
        // WS_CAPTION is two bits (WS_BORDER | WS_DLGFRAME); WS_BORDER alone
        // (0x0080_0000) is not a caption.
        assert!(!eligible(&probe(WS_VISIBLE | 0x0080_0000, 0)));
    }

    #[test]
    fn captionless_app_window_styled_is_eligible() {
        // WS_EX_APPWINDOW substitutes for a caption (custom-frame apps).
        assert!(eligible(&probe(WS_VISIBLE, WS_EX_APPWINDOW)));
    }

    #[test]
    fn own_process_window_is_ineligible() {
        // Our overlay/settings/brain windows must never manage themselves.
        let mut p = probe(APP_STYLE, 0);
        p.pid = OWN_PID;
        assert!(!eligible(&p));
    }

    #[test]
    fn pid_zero_is_ineligible() {
        let mut p = probe(APP_STYLE, 0);
        p.pid = 0;
        p.exe = None;
        assert!(!eligible(&p));
    }

    #[test]
    fn unqueryable_process_is_ineligible() {
        // Elevated-beyond-us / protected processes: exe query fails -> skip.
        let mut p = probe(APP_STYLE, 0);
        p.exe = None;
        assert!(!eligible(&p));
    }

    #[test]
    fn excluded_exe_is_ineligible() {
        let p = probe(APP_STYLE, 0);
        let exclusions = vec!["slack.exe".to_string(), "notepad.exe".to_string()];
        assert!(!is_eligible_probe(&p, OWN_PID, &exclusions));
    }

    #[test]
    fn non_excluded_exe_stays_eligible() {
        let p = probe(APP_STYLE, 0);
        let exclusions = vec!["slack.exe".to_string()];
        assert!(is_eligible_probe(&p, OWN_PID, &exclusions));
    }

    #[test]
    fn non_resizable_window_is_still_eligible() {
        // WS_THICKFRAME affects `resizable` (absolute-tile placement), not
        // eligibility.
        assert!(eligible(&probe(WS_VISIBLE | WS_CAPTION, 0)));
    }

    #[test]
    fn minimized_window_is_still_eligible() {
        // WS_MINIMIZE does not revoke eligibility; minimize/restore is
        // tracked via the dedicated events.
        assert!(eligible(&probe(APP_STYLE | 0x2000_0000, 0)));
    }

    // -- exclusion-list state ------------------------------------------------

    #[test]
    fn set_exclusions_normalizes_to_lowercase() {
        set_exclusions(vec!["Slack.EXE".into(), "FIGMA.exe".into()]);
        assert_eq!(exclusions(), vec!["slack.exe", "figma.exe"]);
        set_exclusions(Vec::new());
        assert!(exclusions().is_empty());
    }

    // -- live-set bookkeeping -------------------------------------------------

    fn fake_info(hwnd: isize) -> WindowInfo {
        WindowInfo {
            hwnd: hwnd.to_string(),
            title: "T".into(),
            exe: "t.exe".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            monitor_id: "m".into(),
            minimized: false,
            resizable: true,
        }
    }

    #[test]
    fn tracked_set_insert_query_remove_roundtrip() {
        let _guard = live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // Use hwnd keys no real window can collide with in other tests.
        let a = -101;
        let b = -102;
        insert_tracked(a, fake_info(a));
        insert_tracked(b, fake_info(b));
        assert!(is_tracked(a));
        assert_eq!(tracked_window(a).unwrap().hwnd, a.to_string());
        assert!(tracked_windows().iter().any(|w| w.hwnd == b.to_string()));
        assert!(remove_tracked(a).is_some());
        assert!(!is_tracked(a));
        assert!(remove_tracked(a).is_none());
        let _ = remove_tracked(b);
    }
}

#[cfg(all(test, windows))]
mod win_tests {
    use super::win::{extended_frame_bounds, probe_window, process_exe, window_info};
    use super::*;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, CW_USEDEFAULT,
        WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe extern "system" fn test_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Register the shared test window class exactly once (tests run in
    /// parallel threads within one process).
    fn ensure_class() {
        static REGISTERED: OnceLock<()> = OnceLock::new();
        REGISTERED.get_or_init(|| unsafe {
            let hinstance = GetModuleHandleW(None).expect("GetModuleHandleW");
            let wc = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(test_wndproc),
                hInstance: hinstance.into(),
                lpszClassName: w!("GriddleWmTrackerTestWindow"),
                ..Default::default()
            };
            assert_ne!(RegisterClassExW(&wc), 0, "RegisterClassExW failed");
        });
    }

    /// Create a real top-level window with the given styles.
    fn create_test_window(
        style: windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE,
        exstyle: windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE,
    ) -> HWND {
        ensure_class();
        unsafe {
            let hinstance = GetModuleHandleW(None).expect("GetModuleHandleW");
            CreateWindowExW(
                exstyle,
                w!("GriddleWmTrackerTestWindow"),
                w!("Griddle tracker test window"),
                style,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                400,
                300,
                None,
                None,
                Some(hinstance.into()),
                None,
            )
            .expect("CreateWindowExW")
        }
    }

    #[test]
    fn probe_of_real_window_reports_styles_pid_and_exe() {
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, Default::default());
        let probe = probe_window(hwnd).expect("probe_window");

        assert_ne!(probe.style & style_bits::WS_VISIBLE, 0, "visible bit");
        assert_eq!(
            probe.style & style_bits::WS_CAPTION,
            style_bits::WS_CAPTION,
            "WS_OVERLAPPEDWINDOW carries a full caption"
        );
        assert_ne!(probe.style & style_bits::WS_THICKFRAME, 0, "sizing border");
        assert!(!probe.cloaked, "fresh window is not cloaked");
        assert_eq!(probe.pid, std::process::id(), "owning pid is this process");
        let exe = probe.exe.clone().expect("exe queryable for own process");
        assert!(exe.ends_with(".exe"), "exe basename: {exe}");
        assert_eq!(exe, exe.to_ascii_lowercase(), "exe is lowercased");

        // The real filter must reject it (own process)...
        assert!(!is_eligible(hwnd.0 as isize));
        // ...while the same probe from a foreign process would be eligible.
        assert!(is_eligible_probe(&probe, probe.pid + 1, &[]));

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn window_info_of_real_window_matches_contract_shape() {
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, Default::default());
        let probe = probe_window(hwnd).unwrap();
        let info = window_info(hwnd, &probe).expect("window_info");

        assert_eq!(info.hwnd, (hwnd.0 as isize).to_string());
        assert_eq!(info.title, "Griddle tracker test window");
        assert!(info.width > 0 && info.height > 0, "non-empty frame: {info:?}");
        assert!(!info.minimized);
        assert!(info.resizable, "WS_THICKFRAME implies resizable");
        assert!(
            info.monitor_id.contains('@'),
            "contract C1 monitor id shape: {}",
            info.monitor_id
        );
        // The extended frame rect is within (or equal to) the raw window
        // rect: DWM bounds exclude the invisible resize borders.
        let frame = extended_frame_bounds(hwnd).unwrap();
        assert_eq!(info.x, frame.left);
        assert_eq!(info.y, frame.top);

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn destroyed_window_probes_as_none_and_is_ineligible() {
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, Default::default());
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
        assert!(probe_window(hwnd).is_none());
        assert!(!is_eligible(hwnd.0 as isize));
    }

    #[test]
    fn toolwindow_probe_carries_the_exstyle_bit() {
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WS_EX_TOOLWINDOW);
        let probe = probe_window(hwnd).unwrap();
        assert_ne!(probe.exstyle & style_bits::WS_EX_TOOLWINDOW, 0);
        // Even from a foreign process this would be rejected.
        assert!(!is_eligible_probe(&probe, probe.pid + 1, &[]));
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn process_exe_of_current_process_is_this_test_binary() {
        let exe = process_exe(std::process::id()).expect("own process queryable");
        // Cargo test binaries are named after the crate: griddle_wm-<hash>.exe
        assert!(exe.ends_with(".exe"), "{exe}");
        assert!(exe.contains("griddle"), "{exe}");
    }

    #[test]
    fn process_exe_of_pid_zero_is_none() {
        assert!(process_exe(0).is_none());
    }

    /// Snapshot against the live desktop: sane shapes, and the live set is
    /// reseeded to exactly the returned windows.
    #[test]
    fn snapshot_returns_sane_windows_and_seeds_live_set() {
        let _guard = live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let windows = snapshot();
        for w in &windows {
            let key: isize = w.hwnd.parse().expect("hwnd is a decimal string");
            assert!(is_tracked(key), "snapshot seeds the live set: {}", w.hwnd);
            assert!(!w.exe.is_empty());
            assert_eq!(w.exe, w.exe.to_ascii_lowercase(), "lowercase exe");
            // Our own windows are never eligible.
            assert_ne!(w.exe, process_exe(std::process::id()).unwrap());
        }
        // No duplicate hwnds.
        let mut hwnds: Vec<&str> = windows.iter().map(|w| w.hwnd.as_str()).collect();
        hwnds.sort_unstable();
        hwnds.dedup();
        assert_eq!(hwnds.len(), windows.len());
    }
}
