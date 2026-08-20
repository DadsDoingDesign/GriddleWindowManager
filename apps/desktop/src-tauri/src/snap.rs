//! Windows-native snap suppression (spec 2026-08-19).
//!
//! Windows' own mouse-driven snapping — drag-to-edge dock, drag-to-edge
//! resize, and the Snap Layouts flyout — competes with Griddle for the same
//! drag gesture: the OS resizes the window mid-drag, which both overrides the
//! grid placement and desynchronises the cursor from its grab point. When the
//! user opts in, Griddle turns those three off and puts them back on quit.
//! Keyboard snapping (`Win+Arrow`, governed by `WindowArrangementActive`) is
//! deliberately left alone.
//!
//! Layering matches `actuator.rs`: a pure, unit-tested decision core
//! ([`plan`]) and a thin `#[cfg(windows)]` edge that talks to
//! `SystemParametersInfoW` (dock/sizing) and the registry (flyout — Windows
//! exposes no SPI for it).
//!
//! Crash safety: the pre-Griddle values are captured once and *persisted in
//! the config* (`AppConfig::windows_snap_original`), so restore never depends
//! on the process that made the change still being alive. The capture is
//! `Some` exactly while Griddle believes it has modified the OS. Quit
//! restores the OS but keeps the capture (the debounced config writer may
//! never run again); the next launch reconciles: preference still on →
//! re-suppress; preference off + capture present → restore and clear.

use crate::ipc::SnapState;

/// What [`plan`] decided should happen to the OS settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// First enable: read the OS values, persist them, then suppress.
    CaptureAndSuppress,
    /// Preference on and a capture already exists (relaunch): suppress,
    /// keep the existing capture.
    Suppress,
    /// Preference off but a capture exists: put these values back and clear
    /// the capture.
    Restore(SnapState),
    /// Preference off and Griddle never touched the OS: do nothing.
    Nothing,
}

/// Pure decision core: preference + persisted capture → action.
pub fn plan(wanted: bool, original: Option<SnapState>) -> Action {
    match (wanted, original) {
        (true, None) => Action::CaptureAndSuppress,
        (true, Some(_)) => Action::Suppress,
        (false, Some(orig)) => Action::Restore(orig),
        (false, None) => Action::Nothing,
    }
}

/// The values Griddle writes when suppressing: everything off.
pub const SUPPRESSED: SnapState = SnapState {
    dock_moving: false,
    snap_sizing: false,
    snap_assist_flyout: false,
};

/// Converge the OS onto the config (called from `shell::sync_from_config`,
/// beside the hotkey and autostart syncs). Returns the capture the caller
/// must persist (`Some` = store this, `None` = clear it), or `None` inside
/// `Err` paths — errors are log-only, matching `sync_autostart`.
pub fn sync(wanted: bool, original: Option<SnapState>) -> Option<SnapState> {
    match plan(wanted, original) {
        Action::CaptureAndSuppress => match read_os() {
            Some(orig) => {
                log::info!(
                    "windows-snap: suppressing (captured dock_moving={} snap_sizing={} flyout={})",
                    orig.dock_moving,
                    orig.snap_sizing,
                    orig.snap_assist_flyout,
                );
                write_os(SUPPRESSED);
                Some(orig)
            }
            None => {
                log::error!("windows-snap: cannot read current OS values; not suppressing");
                None
            }
        },
        Action::Suppress => {
            // Idempotence is not optional here: this sync runs on every
            // config sighting, and the brain writes config on a 500 ms
            // debounce after every drag. An unconditional write costs three
            // SPI broadcasts plus a WM_SETTINGCHANGE to every top-level
            // window in the session — per drop. That storm made drags
            // visibly laggy in the field (2026-08-19). Read first, write
            // only what differs; reads broadcast nothing.
            if read_os() == Some(SUPPRESSED) {
                log::debug!("windows-snap: already suppressed; nothing to write");
            } else {
                log::info!("windows-snap: re-applying suppression (capture retained)");
                write_os(SUPPRESSED);
            }
            original
        }
        Action::Restore(orig) => {
            if read_os() == Some(orig) {
                log::debug!("windows-snap: OS already matches the capture; nothing to write");
            } else {
                log::info!(
                    "windows-snap: restoring (dock_moving={} snap_sizing={} flyout={})",
                    orig.dock_moving,
                    orig.snap_sizing,
                    orig.snap_assist_flyout,
                );
                write_os(orig);
            }
            None
        }
        Action::Nothing => None,
    }
}

/// Quit-time restore: put the OS back without touching the persisted capture
/// (the config writer may never run again — the capture stays on disk and the
/// next launch reconciles). No-op when Griddle never suppressed.
pub fn restore_on_quit(wanted: bool, original: Option<SnapState>) {
    if !wanted {
        return;
    }
    if let Some(orig) = original {
        log::info!("windows-snap: quit — restoring OS snap settings");
        write_os(orig);
    }
}

#[cfg(windows)]
pub use win::{read_os, write_os};

#[cfg(not(windows))]
pub fn read_os() -> Option<SnapState> {
    None
}

#[cfg(not(windows))]
pub fn write_os(_state: SnapState) {}

#[cfg(windows)]
mod win {
    use super::SnapState;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, SystemParametersInfoW, HWND_BROADCAST, SMTO_ABORTIFHUNG,
        SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETDOCKMOVING, SPI_GETSNAPSIZING,
        SPI_SETDOCKMOVING, SPI_SETSNAPSIZING, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        WM_SETTINGCHANGE,
    };

    const FLYOUT_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
    const FLYOUT_VALUE: &str = "EnableSnapAssistFlyout";

    /// Read the three live values. `None` if any SPI read fails (never seen
    /// in practice; treated as "do not touch anything").
    pub fn read_os() -> Option<SnapState> {
        let dock_moving = spi_get_bool(SPI_GETDOCKMOVING)?;
        let snap_sizing = spi_get_bool(SPI_GETSNAPSIZING)?;
        // Absent registry value = Windows default = on.
        let snap_assist_flyout = read_flyout().unwrap_or(true);
        Some(SnapState {
            dock_moving,
            snap_sizing,
            snap_assist_flyout,
        })
    }

    /// Write the fields that differ from the live values (each write is a
    /// system-wide broadcast, so skipping unchanged fields matters). Failures
    /// are per-setting and log-only, so one broken write never blocks the
    /// others (nor a later restore retry).
    pub fn write_os(state: SnapState) {
        let live = read_os();
        if live.map(|l| l.dock_moving) != Some(state.dock_moving) {
            spi_set_bool(SPI_SETDOCKMOVING, state.dock_moving);
        }
        if live.map(|l| l.snap_sizing) != Some(state.snap_sizing) {
            spi_set_bool(SPI_SETSNAPSIZING, state.snap_sizing);
        }
        if live.map(|l| l.snap_assist_flyout) != Some(state.snap_assist_flyout) {
            write_flyout(state.snap_assist_flyout);
        }
    }

    fn spi_get_bool(
        action: windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_ACTION,
    ) -> Option<bool> {
        let mut value = windows::core::BOOL(0);
        unsafe {
            SystemParametersInfoW(
                action,
                0,
                Some(&mut value as *mut _ as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .inspect_err(|e| log::error!("windows-snap: SPI get {action:?} failed: {e}"))
        .ok()
        .map(|()| value.as_bool())
    }

    fn spi_set_bool(
        action: windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_ACTION,
        value: bool,
    ) {
        // Boolean SPI setters take the value in uiParam; UPDATEINIFILE
        // persists it for the user, SENDCHANGE broadcasts WM_SETTINGCHANGE.
        if let Err(e) = unsafe {
            SystemParametersInfoW(
                action,
                u32::from(value),
                None,
                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
            )
        } {
            log::error!("windows-snap: SPI set {action:?}={value} failed: {e}");
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Raw registry read; no SPI exists for the Snap Layouts flyout.
    /// `None` when the value is absent (Windows default applies).
    fn read_flyout() -> Option<bool> {
        use windows::Win32::System::Registry::{
            RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
        };
        let key = to_wide(FLYOUT_KEY);
        let value = to_wide(FLYOUT_VALUE);
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut data as *mut _ as *mut core::ffi::c_void),
                Some(&mut size),
            )
        };
        status.is_ok().then_some(data != 0)
    }

    fn write_flyout(value: bool) {
        use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD};
        let key_path = to_wide(FLYOUT_KEY);
        let value_name = to_wide(FLYOUT_VALUE);
        let data: u32 = value.into();
        // One-call set; Explorer\Advanced always exists on a real session and
        // RegSetKeyValue creates the value if absent.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key_path.as_ptr()),
                PCWSTR(value_name.as_ptr()),
                REG_DWORD.0,
                Some(&data as *const _ as *const core::ffi::c_void),
                std::mem::size_of::<u32>() as u32,
            )
        };
        if status.is_err() {
            log::error!("windows-snap: writing {FLYOUT_VALUE}={value} failed: {status:?}");
            return;
        }
        broadcast_setting_change();
    }

    /// Explorer picks the flyout change up from WM_SETTINGCHANGE. Timeout so a
    /// hung window can never stall Griddle (same rationale as the actuator's
    /// ASYNCWINDOWPOS).
    fn broadcast_setting_change() {
        let policy: Vec<u16> = "TraySettings\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(PCWSTR(policy.as_ptr()).0 as isize),
                SMTO_ABORTIFHUNG,
                1000,
                None,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orig() -> SnapState {
        SnapState {
            dock_moving: true,
            snap_sizing: true,
            snap_assist_flyout: false, // user had the flyout off themselves
        }
    }

    #[test]
    fn plan_covers_all_four_states() {
        assert_eq!(plan(true, None), Action::CaptureAndSuppress, "first enable");
        assert_eq!(plan(true, Some(orig())), Action::Suppress, "relaunch");
        assert_eq!(
            plan(false, Some(orig())),
            Action::Restore(orig()),
            "toggle off restores the exact captured values"
        );
        assert_eq!(plan(false, None), Action::Nothing, "never touched");
    }

    #[test]
    fn suppressed_turns_everything_off() {
        assert!(!SUPPRESSED.dock_moving);
        assert!(!SUPPRESSED.snap_sizing);
        assert!(!SUPPRESSED.snap_assist_flyout);
    }

    #[test]
    fn snap_state_serde_round_trips_camel_case() {
        let s = orig();
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            json.contains("dockMoving") && json.contains("snapAssistFlyout"),
            "contract C1 uses camelCase: {json}"
        );
        assert_eq!(serde_json::from_str::<SnapState>(&json).unwrap(), s);
    }
}
