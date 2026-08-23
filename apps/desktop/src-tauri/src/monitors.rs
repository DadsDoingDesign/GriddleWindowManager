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

/// Contract §C2: `list_monitors() -> MonitorInfo[]`. Callers: brain host,
/// settings and overlay webviews (security review: least privilege).
#[tauri::command]
pub fn list_monitors(window: tauri::Window) -> Vec<MonitorInfo> {
    if crate::guard::authorize("list_monitors", window.label()).is_err() {
        return Vec::new();
    }
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
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_BINARY};
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
        // Raw-pointer work stays outside the guard closure; a panic in the
        // body must not unwind into EnumDisplayMonitors (security review:
        // FFI panic safety).
        let monitors = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
        crate::ffi_guard::guard("EnumDisplayMonitors callback", BOOL(1), move || {
            push_monitor(hmonitor, monitors);
            BOOL(1) // keep enumerating
        })
    }

    /// Query one monitor and append its `MonitorInfo`; failures skip the
    /// monitor. Safe wrapper so the FFI callback body is panic-guarded.
    fn push_monitor(hmonitor: HMONITOR, monitors: &mut Vec<MonitorInfo>) {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        // MONITORINFO is the first field of MONITORINFOEXW; passing the
        // outer struct with cbSize = sizeof(MONITORINFOEXW) makes the API
        // fill szDevice too.
        if !unsafe {
            GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
        }
        .as_bool()
        {
            log::warn!("GetMonitorInfoW failed for a monitor; skipping it");
            return;
        }

        let device_len = info
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.szDevice.len());
        let device = String::from_utf16_lossy(&info.szDevice[..device_len]);

        // Effective DPI (scale-adjusted). Fall back to 96 if the call fails.
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        if let Err(e) =
            unsafe { GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) }
        {
            log::warn!("GetDpiForMonitor failed for {device}: {e}; assuming 96");
            dpi_x = 96;
        }

        let full = info.monitorInfo.rcMonitor;
        let work = info.monitorInfo.rcWork;
        // Log review 2026-08-22: a monitor whose work area is empty or
        // inverted must never enter the snapshot.
        //
        // At boot the displays arrive one at a time — the log shows "1
        // monitor" then "2 monitors" within a second, repeatedly — and during
        // that churn `GetMonitorInfoW` can hand back a degenerate rcWork. The
        // brain divides the work area into cells, so a zero or negative
        // extent turns straight into zero or negative *window* sizes: 88 of
        // them reached SetWindowPos in three days, 68 of those 0x0. Applying
        // that to a real window collapses it, which is what "my browser came
        // back looking like this" was.
        //
        // Skipping is right rather than clamping: the topology is mid-change,
        // another `monitors-changed` is already on its way, and a monitor we
        // cannot measure is one we cannot lay out.
        let (work_width, work_height) = (work.right - work.left, work.bottom - work.top);
        if work_width <= 0 || work_height <= 0 {
            log::warn!(
                "{device}: work area is {work_width}x{work_height}; skipping it this sweep                  (display topology is probably still settling)"
            );
            return;
        }
        monitors.push(MonitorInfo {
            id: monitor_id(&device, full.left, full.top),
            x: full.left,
            y: full.top,
            width: full.right - full.left,
            height: full.bottom - full.top,
            work_x: work.left,
            work_y: work.top,
            work_width,
            work_height,
            dpi: dpi_x,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            model: monitor_model(&device),
        });
    }

    /// `EDD_GET_DEVICE_INTERFACE_NAME` — asks `EnumDisplayDevicesW` for the
    /// PnP interface path in `DeviceID` rather than a driver description. The
    /// `windows` crate does not re-export it, and it is a stable Win32 flag.
    const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x0000_0001;

    /// The monitor's own name, read out of its EDID.
    ///
    /// `\.\DISPLAY1` is an adapter output, not a monitor — it says nothing
    /// about what is plugged into it, and the numbering shuffles when displays
    /// are re-detected. The EDID carries the name the manufacturer wrote, so
    /// the UI can say "Gigabyte M28U" instead of "DISPLAY1".
    ///
    /// Best-effort at every step. Virtual, remote and some capture displays
    /// have no EDID at all, and the caller falls back to the device name.
    fn monitor_model(device: &str) -> Option<String> {
        let wide: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // Index 0: the monitor attached to this output.
        let ok = unsafe {
            EnumDisplayDevicesW(
                PCWSTR(wide.as_ptr()),
                0,
                &mut dd,
                EDD_GET_DEVICE_INTERFACE_NAME,
            )
        };
        if !ok.as_bool() {
            return None;
        }
        let id = wide_to_string(&dd.DeviceID);
        // \\?\DISPLAY#GSM5B09#5&1234abcd&0&UID4353#{guid}
        let rest = id.strip_prefix("\\\\?\\").unwrap_or(&id);
        let parts: Vec<&str> = rest.split('#').collect();
        if parts.len() < 3 {
            return None;
        }
        let key = format!(
            "SYSTEM\\CurrentControlSet\\Enum\\{}\\{}\\{}\\Device Parameters",
            parts[0], parts[1], parts[2]
        );
        let edid = read_binary_value(&key, "EDID")?;
        parse_edid_name(&edid)
    }

    /// Pull the display name out of an EDID block.
    ///
    /// An EDID has four 18-byte descriptors at 0x36, 0x48, 0x5A and 0x6C. A
    /// descriptor whose first three bytes are zero is a text block, and type
    /// 0xFC is the monitor name — up to 13 characters, terminated by 0x0A and
    /// space-padded. Any other descriptor (timings, serial, range limits) is
    /// skipped, and a block with no 0xFC descriptor simply has no name.
    pub(super) fn parse_edid_name(edid: &[u8]) -> Option<String> {
        if edid.len() < 128 {
            return None;
        }
        for off in [0x36usize, 0x48, 0x5A, 0x6C] {
            let d = &edid[off..off + 18];
            if d[0] != 0 || d[1] != 0 || d[2] != 0 || d[3] != 0xFC {
                continue;
            }
            let raw = &d[5..18];
            let end = raw.iter().position(|&b| b == 0x0A).unwrap_or(raw.len());
            let name = String::from_utf8_lossy(&raw[..end]).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
        None
    }

    /// Read one REG_BINARY value from HKLM, or `None` for any failure.
    fn read_binary_value(subkey: &str, value: &str) -> Option<Vec<u8>> {
        let k: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let v: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let mut len: u32 = 0;
        // First call sizes the buffer.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(k.as_ptr()),
                PCWSTR(v.as_ptr()),
                RRF_RT_REG_BINARY,
                None,
                None,
                Some(&mut len),
            )
        };
        if rc.is_err() || len == 0 || len > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(k.as_ptr()),
                PCWSTR(v.as_ptr()),
                RRF_RT_REG_BINARY,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut len),
            )
        };
        if rc.is_err() {
            return None;
        }
        buf.truncate(len as usize);
        Some(buf)
    }

    /// Decode a UTF-16 field that may or may not be NUL-terminated.
    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
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
        // The tray syncs on every brain snapshot; it works from this cache so
        // the hot path never re-walks the display topology (critique round 3).
        crate::shell::refresh_monitor_cache(&monitors);
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
                // Panic-guarded: emit calls into tauri internals and must not
                // unwind into the message dispatcher (security review).
                crate::ffi_guard::guard("watcher WM_DISPLAYCHANGE", (), emit_monitors_changed);
                LRESULT(0)
            }
            // Taskbar work-area changes arrive as WM_SETTINGCHANGE with
            // wParam = SPI_SETWORKAREA and no WM_DISPLAYCHANGE.
            WM_SETTINGCHANGE if wparam.0 as u32 == SPI_SETWORKAREA.0 => {
                crate::ffi_guard::guard("watcher WM_SETTINGCHANGE", (), emit_monitors_changed);
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
            w!("Griddle Window Manager monitor watcher"),
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
    /// EDID descriptor 0xFC carries the manufacturer's own name for the
    /// display. Pure, so the parsing is testable without a monitor attached.
    #[test]
    fn edid_monitor_name_is_read_from_the_fc_descriptor() {
        let mut edid = vec![0u8; 128];
        // Descriptor 2 (offset 0x48): type 0xFC, "Gigabyte M28U" + 0x0A pad.
        edid[0x48 + 3] = 0xFC;
        let name = b"Gigabyte M28U";
        edid[0x48 + 5..0x48 + 5 + name.len()].copy_from_slice(name);
        edid[0x48 + 5 + name.len()] = 0x0A;
        assert_eq!(super::win::parse_edid_name(&edid).as_deref(), Some("Gigabyte M28U"));

        // No 0xFC descriptor anywhere: nothing to report, and no panic.
        assert_eq!(super::win::parse_edid_name(&vec![0u8; 128]), None);
        // Too short to be an EDID block at all.
        assert_eq!(super::win::parse_edid_name(&[0u8; 10]), None);
    }

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
