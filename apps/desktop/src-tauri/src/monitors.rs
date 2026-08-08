//! Monitor enumeration + display-change watching (plan Task 9).
//!
//! `enumerate()` walks the display topology via `EnumDisplayMonitors` +
//! `GetMonitorInfoW` (MONITORINFOEXW for the device name) + `GetDpiForMonitor`
//! and maps it to the contract C1 `MonitorInfo` shape (all coordinates are
//! physical virtual-desktop pixels).
//!
//! `start_display_watcher()` spawns a thread owning an invisible top-level
//! window whose wndproc listens for `WM_DISPLAYCHANGE` (resolution/topology
//! changes) and `WM_SETTINGCHANGE` with `SPI_SETWORKAREA` (taskbar moves or
//! auto-hide toggles change the work area without a display change). Both
//! re-enumerate and emit the C2 `monitors-changed` event with the fresh
//! `MonitorInfo[]`. The window must be a *hidden top-level* window, not a
//! message-only (`HWND_MESSAGE`) window: broadcast messages such as
//! `WM_DISPLAYCHANGE` are only delivered to top-level windows.

use crate::ipc::MonitorInfo;

/// Stable monitor id per contract C1: `device name + "@" + x + "," + y`.
///
/// The device name (e.g. `\\.\DISPLAY1`) can be reassigned when monitors are
/// re-plugged, so the top-left position of the monitor in the virtual desktop
/// is folded in to keep ids distinct and stable for a given arrangement.
pub fn monitor_id(device: &str, x: i32, y: i32) -> String {
    format!("{device}@{x},{y}")
}

/// Contract §C2: `list_monitors() -> MonitorInfo[]`.
#[tauri::command]
pub fn list_monitors() -> Vec<MonitorInfo> {
    enumerate()
}

#[cfg(windows)]
pub use win::{enumerate, start_display_watcher};

#[cfg(not(windows))]
pub fn enumerate() -> Vec<MonitorInfo> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn start_display_watcher(_app: tauri::AppHandle) {}

#[cfg(windows)]
mod win {
    use super::monitor_id;
    use crate::ipc::{events, MonitorInfo};
    use std::mem::size_of;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::core::{w, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
        TranslateMessage, MONITORINFOF_PRIMARY, MSG, SPI_SETWORKAREA, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_DISPLAYCHANGE, WM_SETTINGCHANGE, WNDCLASSEXW,
    };

    /// Handle used by the watcher wndproc to emit `monitors-changed`.
    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    /// Enumerate all display monitors in a deterministic order (primary
    /// first, then by virtual-desktop position).
    pub fn enumerate() -> Vec<MonitorInfo> {
        let mut monitors: Vec<MonitorInfo> = Vec::new();
        unsafe {
            // Return value ignored: a partial list is still useful and the
            // callback itself never asks for early termination.
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_proc),
                LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize),
            );
        }
        monitors.sort_by_key(|m| (!m.primary, m.x, m.y));
        monitors
    }

    unsafe extern "system" fn enum_proc(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<MonitorInfo>);

        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        // MONITORINFO is the first field of MONITORINFOEXW; passing the
        // outer struct with cbSize = sizeof(MONITORINFOEXW) makes the API
        // fill szDevice too.
        if !GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
            .as_bool()
        {
            log::warn!("GetMonitorInfoW failed for a monitor; skipping it");
            return BOOL(1); // keep enumerating
        }

        let device_len = info
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.szDevice.len());
        let device = String::from_utf16_lossy(&info.szDevice[..device_len]);

        // Effective DPI (scale-adjusted). Fall back to 96 if the call fails.
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        if let Err(e) = GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) {
            log::warn!("GetDpiForMonitor failed for {device}: {e}; assuming 96");
            dpi_x = 96;
        }

        let full = info.monitorInfo.rcMonitor;
        let work = info.monitorInfo.rcWork;
        monitors.push(MonitorInfo {
            id: monitor_id(&device, full.left, full.top),
            x: full.left,
            y: full.top,
            width: full.right - full.left,
            height: full.bottom - full.top,
            work_x: work.left,
            work_y: work.top,
            work_width: work.right - work.left,
            work_height: work.bottom - work.top,
            dpi: dpi_x,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
        BOOL(1)
    }

    /// Spawn the display-change watcher thread. Idempotent: a second call is
    /// a no-op (the `AppHandle` slot is already taken).
    pub fn start_display_watcher(app: AppHandle) {
        if APP_HANDLE.set(app).is_err() {
            log::warn!("display watcher already started; ignoring second start");
            return;
        }
        if let Err(e) = std::thread::Builder::new()
            .name("monitor-watcher".into())
            .spawn(|| unsafe { run_watcher_window() })
        {
            log::error!("failed to spawn monitor-watcher thread: {e}");
        }
    }

    /// Re-enumerate and broadcast `monitors-changed` to all webviews.
    fn emit_monitors_changed() {
        let Some(app) = APP_HANDLE.get() else {
            return;
        };
        let monitors = enumerate();
        log::info!(
            "display change detected: {} monitor(s), emitting {}",
            monitors.len(),
            events::MONITORS_CHANGED
        );
        if let Err(e) = app.emit(events::MONITORS_CHANGED, &monitors) {
            log::error!("failed to emit {}: {e}", events::MONITORS_CHANGED);
        }
    }

    unsafe extern "system" fn watcher_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_DISPLAYCHANGE => {
                emit_monitors_changed();
                LRESULT(0)
            }
            // Taskbar work-area changes arrive as WM_SETTINGCHANGE with
            // wParam = SPI_SETWORKAREA and no WM_DISPLAYCHANGE.
            WM_SETTINGCHANGE if wparam.0 as u32 == SPI_SETWORKAREA.0 => {
                emit_monitors_changed();
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Create the invisible top-level watcher window and pump its messages.
    /// Runs for the lifetime of the process on the monitor-watcher thread.
    unsafe fn run_watcher_window() {
        let hinstance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                log::error!("GetModuleHandleW failed: {e}; display watcher disabled");
                return;
            }
        };
        let class_name = w!("GriddleWmMonitorWatcher");
        let wc = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(watcher_wndproc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassExW(&wc) == 0 {
            log::error!(
                "RegisterClassExW failed: {:?}; display watcher disabled",
                windows::core::Error::from_thread()
            );
            return;
        }
        // Top-level (no parent), zero-size, never shown. NOT HWND_MESSAGE:
        // message-only windows do not receive broadcasts like
        // WM_DISPLAYCHANGE.
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Griddle WM monitor watcher"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance.into()),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                log::error!("CreateWindowExW failed: {e}; display watcher disabled");
                return;
            }
        };
        log::info!("display watcher window created (hwnd {})", hwnd.0 as isize);

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                // 0 = WM_QUIT, -1 = error; either way the watcher is done.
                if r.0 < 0 {
                    log::error!(
                        "GetMessageW failed in display watcher: {:?}",
                        windows::core::Error::from_thread()
                    );
                }
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_id_formats_device_at_position() {
        assert_eq!(
            monitor_id(r"\\.\DISPLAY1", 0, 0),
            r"\\.\DISPLAY1@0,0"
        );
    }

    #[test]
    fn monitor_id_keeps_negative_coordinates() {
        // Monitors left of / above the primary have negative virtual-desktop
        // origins; the id must preserve the sign verbatim.
        assert_eq!(
            monitor_id(r"\\.\DISPLAY2", -1920, -240),
            r"\\.\DISPLAY2@-1920,-240"
        );
    }

    #[test]
    fn monitor_id_is_deterministic() {
        assert_eq!(
            monitor_id(r"\\.\DISPLAY3", 2560, 0),
            monitor_id(r"\\.\DISPLAY3", 2560, 0)
        );
    }

    #[test]
    fn monitor_id_distinguishes_device_and_position() {
        let a = monitor_id(r"\\.\DISPLAY1", 0, 0);
        let b = monitor_id(r"\\.\DISPLAY2", 0, 0);
        let c = monitor_id(r"\\.\DISPLAY1", 1920, 0);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    /// Smoke test against the real display topology of the machine running
    /// the tests (any interactive Windows session has >= 1 monitor).
    #[cfg(windows)]
    #[test]
    fn enumerate_returns_sane_monitors() {
        let monitors = enumerate();
        assert!(
            !monitors.is_empty(),
            "expected at least one monitor on a live session"
        );
        let primaries = monitors.iter().filter(|m| m.primary).count();
        assert_eq!(primaries, 1, "exactly one primary monitor expected");
        // Primary-first deterministic ordering.
        assert!(monitors[0].primary);

        let mut ids: Vec<&str> = monitors.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), monitors.len(), "monitor ids must be unique");

        for m in &monitors {
            assert!(m.width > 0 && m.height > 0, "bounds must be non-empty: {m:?}");
            assert!(
                m.work_width > 0 && m.work_height > 0,
                "work area must be non-empty: {m:?}"
            );
            // Work area is contained in the full bounds.
            assert!(m.work_x >= m.x && m.work_y >= m.y, "work origin inside bounds: {m:?}");
            assert!(
                m.work_x + m.work_width <= m.x + m.width
                    && m.work_y + m.work_height <= m.y + m.height,
                "work area inside bounds: {m:?}"
            );
            assert!(m.dpi >= 96, "effective DPI is at least 96: {m:?}");
            assert_eq!(m.id, monitor_id(&m.id[..m.id.rfind('@').unwrap()], m.x, m.y));
        }
    }
}
