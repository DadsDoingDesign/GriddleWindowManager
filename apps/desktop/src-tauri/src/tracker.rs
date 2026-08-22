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

use crate::ipc::{Hwnd, WindowInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// `WS_MAXIMIZE` — window is currently maximized.
    pub const WS_MAXIMIZE: u32 = 0x0100_0000;
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
    /// process cannot be queried at all (protected) — such windows are
    /// ineligible per spec §5.1/§7 (we could not move them anyway).
    pub exe: Option<String>,
    /// The owning process runs at a higher integrity level than Griddle —
    /// "run as administrator" while we are not (log review 2026-08-21).
    ///
    /// This is its own field because the exe name is *not* the signal it was
    /// assumed to be. `PROCESS_QUERY_LIMITED_INFORMATION` is deliberately
    /// granted across integrity levels, so `QueryFullProcessImageNameW`
    /// happily names an elevated process, `exe` comes back `Some`, and the
    /// window sailed through eligibility — then every `SetWindowPos` on it
    /// failed with access-denied while the grid kept a tile for it and shoved
    /// real windows aside to make room.
    pub elevated: bool,
}

/// Spec §5.1 eligibility, as a pure function. Managed iff: visible, top-level
/// (not `WS_CHILD`), not DWM-cloaked, not `WS_EX_TOOLWINDOW`, belongs to a
/// real foreign process (`pid != 0`, `pid != own_pid`) whose exe could be
/// queried and is not in the user's exclusion list.
///
/// There is deliberately no caption requirement (user decision 2026-08-20,
/// "do not exclude any windows from the grid"): custom-chrome apps
/// (Electron frameless, game launchers) and borderless windows are real
/// windows to the user, and the caption gate was silently rejecting them.
/// What still cannot be included, and why, lives in
/// docs/window-eligibility.md — Griddle's own overlays (the product must not
/// tile itself), other virtual desktops (cloaked — invisible workspaces),
/// tool windows (the OS marker for transient flyouts like the volume OSD and
/// in-game overlays, which appear and vanish by themselves), and windows
/// Windows itself refuses to move or even name (elevation).
///
/// `allowed_own` (spec 2026-08-20, window-eligibility audit) is the one
/// sanctioned exception to the own-process rule: the caller sets it for
/// Griddle's *Settings* window — from the user's side of the screen a normal
/// window, which they expect to tile like any other. Every other own window
/// (hidden brain, overlays) stays ineligible: the overlays also carry
/// `WS_EX_TOOLWINDOW`, and the brain is invisible outside GRIDDLE_DEBUG —
/// and even then it is not the allowed hwnd.
pub fn is_eligible_probe(
    probe: &WindowProbe,
    own_pid: u32,
    exclusions: &[String],
    allowed_own: bool,
) -> bool {
    use style_bits::*;
    let visible = probe.style & WS_VISIBLE != 0;
    let top_level = probe.style & WS_CHILD == 0;
    let tool_window = probe.exstyle & WS_EX_TOOLWINDOW != 0;
    let Some(exe) = probe.exe.as_deref() else {
        return false;
    };
    visible
        && top_level
        && !probe.cloaked
        && !tool_window
        && !probe.elevated
        && probe.pid != 0
        && (probe.pid != own_pid || allowed_own)
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
/// pure filter can compare verbatim. Returns `true` when the stored list
/// actually changed — the caller then owes a [`resync`] so exclusion edits
/// take effect on live windows without a restart (Task 19).
pub fn set_exclusions(exes: Vec<String>) -> bool {
    let normalized: Vec<String> = exes.into_iter().map(|e| e.to_ascii_lowercase()).collect();
    let mut lock = exclusions_lock().lock().unwrap_or_else(|p| p.into_inner());
    if *lock == normalized {
        return false;
    }
    *lock = normalized;
    true
}

/// Pure diff behind [`resync`]: which tracked hwnds are gone from a fresh
/// snapshot (→ `window-destroyed`) and which snapshot windows are new
/// (→ `window-appeared`). Gone hwnds are returned in ascending order for
/// deterministic emission.
pub(crate) fn diff_live_set(
    before: &HashMap<isize, WindowInfo>,
    after: &[WindowInfo],
) -> (Vec<Hwnd>, Vec<WindowInfo>) {
    let after_keys: std::collections::HashSet<isize> =
        after.iter().filter_map(|w| w.hwnd.parse().ok()).collect();
    let mut gone: Vec<isize> = before
        .keys()
        .copied()
        .filter(|k| !after_keys.contains(k))
        .collect();
    gone.sort_unstable();
    let appeared: Vec<WindowInfo> = after
        .iter()
        .filter(|w| {
            w.hwnd
                .parse::<isize>()
                .is_ok_and(|k| !before.contains_key(&k))
        })
        .cloned()
        .collect();
    (gone.into_iter().map(|k| k.to_string()).collect(), appeared)
}

/// Current exclusion list (lowercase exe basenames).
pub fn exclusions() -> Vec<String> {
    exclusions_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Would this window be managed if it were not elevated?
///
/// Shared by the log notice and the drag-time overlay notice so the two can
/// never disagree about which windows the message is about. A cloaked or tool
/// window that also happens to be elevated is being skipped for reasons the
/// user does not need a notice about, so it answers false — the notice is
/// only ever "this would have tiled, but it runs as administrator".
///
/// Pure, and deliberately outside `mod win`: it makes no Win32 call, and
/// keeping it here is what lets the truth table below cover it.
pub fn elevated_is_the_only_reason(probe: &WindowProbe, own_pid: u32, allowed_own: bool) -> bool {
    if !probe.elevated {
        return false;
    }
    let mut as_if_normal = probe.clone();
    as_if_normal.elevated = false;
    is_eligible_probe(&as_if_normal, own_pid, &exclusions(), allowed_own)
}

/// Whether the settings pop-out is eligible for tiling like any other window
/// (`AppConfig.manage_settings_window`, spec 2026-08-20 addendum). Mirrored
/// out of the config so the hot WinEvent path can read it without touching
/// disk, exactly like the exclusion list.
static MANAGE_SETTINGS: AtomicBool = AtomicBool::new(false);

/// Mirror the config flag. Returns `true` when the value actually changed —
/// the caller then owes a [`resync`], so flipping the toggle takes effect on
/// the live window rather than at the next restart.
pub fn set_manage_settings_window(on: bool) -> bool {
    MANAGE_SETTINGS.swap(on, Ordering::SeqCst) != on
}

/// Is the settings pop-out currently opted in to being tiled?
pub fn manage_settings_window() -> bool {
    MANAGE_SETTINGS.load(Ordering::SeqCst)
}

/// The one own-process window Griddle may manage, and only while the user has
/// opted in. Everything else of ours - the brain, the overlays - stays out of
/// the managed set unconditionally.
fn own_window_is_managed(hwnd: isize) -> bool {
    manage_settings_window() && crate::shell::settings_hwnd() == Some(hwnd)
}

/// Actuation-time identity check (security review, "handle reuse"): does a
/// fresh probe of a handle still denote the window we tracked? Windows
/// recycles HWND values quickly, so a handle that died and was re-issued to
/// another process between tracking and actuation must not be moved/focused.
/// The owning exe is the stable identity we hold for a tracked window; a
/// probe whose exe differs (or could not be queried) is a different window.
pub fn probe_matches_tracked(tracked: &WindowInfo, probe: &WindowProbe) -> bool {
    probe.exe.as_deref() == Some(tracked.exe.as_str())
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

/// Remove a window from the live eligible set. Used by the actuator when it
/// discovers a dead handle mid-apply (spec §6: skip + `window-destroyed`);
/// the actuator emits the event, this keeps the security-rule set truthful.
pub fn untrack(hwnd: isize) -> Option<WindowInfo> {
    remove_tracked(hwnd)
}

/// Test-only: seed the live eligible set directly so actuator tests can
/// exercise the contract C2 security rule against real test windows.
#[cfg(test)]
pub(crate) fn track_for_test(hwnd: isize, info: WindowInfo) {
    insert_tracked(hwnd, info);
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
    // Merge, don't clear+rebuild: a window the hook inserted while the
    // enumeration was running would be wiped by a clear even though its
    // window-appeared already reached the brain — leaving a tile the
    // security rule then rejects on every apply. Removing only the hwnds the
    // enumeration proves absent keeps that race window minimal.
    let present: std::collections::HashSet<isize> =
        windows.iter().filter_map(|w| w.hwnd.parse().ok()).collect();
    lock.retain(|key, _| present.contains(key));
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
/// callers always see the current desktop. Callers: brain host + settings
/// (security review: least privilege). Only the brain host's call reseeds
/// the live eligible set — the live set is the authority behind the
/// `apply_layout`/`focus_window` security rule, and a read-shaped command
/// from the less-privileged settings window must not mutate security-
/// relevant state as a side effect (critique round 2).
#[tauri::command]
pub fn list_windows(window: tauri::Window) -> Vec<WindowInfo> {
    if crate::guard::authorize("list_windows", window.label()).is_err() {
        return Vec::new();
    }
    let out = if window.label() == crate::guard::MAIN_LABEL {
        // A sweep request proves the brain page's event loop is alive —
        // count it as a heartbeat (see shell::note_brain_activity).
        crate::shell::note_brain_activity();
        snapshot()
    } else {
        snapshot_readonly()
    };
    // Debug-only tally. Counts per monitor and how many are minimized —
    // never a title or an exe, per the log privacy rule in `config::logs_dir`.
    if log::log_enabled!(log::Level::Debug) {
        let mut per: std::collections::BTreeMap<&str, (usize, usize)> =
            std::collections::BTreeMap::new();
        for w in &out {
            let e = per.entry(w.monitor_id.as_str()).or_default();
            e.0 += 1;
            if w.minimized {
                e.1 += 1;
            }
        }
        let tally: Vec<String> = per
            .iter()
            .map(|(m, (n, min))| format!("{m} => {n} ({min} minimized)"))
            .collect();
        log::debug!(
            "list_windows for {:?}: {} window(s) [{}]",
            window.label(),
            out.len(),
            tally.join(", "),
        );
    }
    out
}

/// Contract C2 extension (critique fix, event-storm hardening): is `hwnd`
/// still in the live eligible set? The brain host uses this O(1) check to
/// vet `window-destroyed` events against forgery (Tauri events carry no
/// sender identity) instead of running a full desktop sweep per event: a
/// genuine destroy/hide/cloak was untracked by the hook before the event was
/// emitted, so a *tracked* hwnd means the event is forged or stale.
/// Brain-host only (security review: least privilege).
#[tauri::command]
pub fn window_is_tracked(window: tauri::Window, hwnd: Hwnd) -> bool {
    if crate::guard::authorize("window_is_tracked", window.label()).is_err() {
        return false;
    }
    hwnd.parse::<isize>().is_ok_and(is_tracked)
}

#[cfg(windows)]
pub use win::{
    is_eligible, resync, snapshot, snapshot_readonly, start_tracker, verify_for_actuation,
};
#[cfg(windows)]
pub(crate) use win::extended_frame_bounds;
#[cfg(all(test, windows))]
pub(crate) use win::process_exe;

#[cfg(not(windows))]
pub fn snapshot() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn snapshot_readonly() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn start_tracker(_app: tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn resync() {}

#[cfg(not(windows))]
pub fn verify_for_actuation(_hwnd: isize) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use super::{
        diff_live_set, exclusions, insert_tracked, is_eligible_probe, is_tracked, remove_tracked,
        reseed_tracked, style_bits, tracked_map, WindowProbe,
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
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EnumWindows, GetMessageW, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsZoomed,
        TranslateMessage, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
        EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_SHOW,
        EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART,
        EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, GWL_EXSTYLE, GWL_STYLE, MSG,
        OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    };

    /// Handle used by the hook callbacks to emit contract C2 events.
    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    /// Tracked hwnds currently observed maximized (critique fix, untracked
    /// window-state changes). Membership drives the maximize→`window-minimized`
    /// / unmaximize→`window-restored` translation in [`sync_zoom_state`].
    fn zoomed_lock() -> &'static std::sync::Mutex<std::collections::HashSet<isize>> {
        static ZOOMED: OnceLock<std::sync::Mutex<std::collections::HashSet<isize>>> =
            OnceLock::new();
        ZOOMED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
    }

    fn zoomed_insert(key: isize) {
        zoomed_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key);
    }

    fn zoomed_remove(key: isize) {
        zoomed_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&key);
    }

    // -- probing ------------------------------------------------------------

    /// Lowercase exe basename for a pid, or `None` if the process cannot be
    /// queried (elevated beyond us, protected, or already gone).
    pub(crate) fn process_exe(pid: u32) -> Option<String> {
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
                elevated: process_is_elevated(pid),
            })
        }
    }

    /// First time this run that we have seen `exe` as an elevated program?
    fn elevated_notice_is_new(exe: &str) -> bool {
        use std::collections::HashSet;
        use std::sync::{Mutex, OnceLock};
        static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        SEEN.get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(exe.to_string())
    }

    /// An elevated window we are declining to manage: say so, once per
    /// program, per run.
    ///
    /// Without this the exclusion is invisible. The window simply never tiles
    /// and nothing anywhere says why, which is a worse bug report than the one
    /// this replaced — at least the old behaviour was visibly wrong.
    ///
    /// Only fires when elevation is the *sole* reason we passed: a cloaked or
    /// tool window that also happens to be elevated is being skipped for
    /// reasons the user does not need a notice about.
    fn note_elevated(probe: &WindowProbe, own_pid: u32, allowed_own: bool) {
        if !super::elevated_is_the_only_reason(probe, own_pid, allowed_own) {
            return;
        }
        let Some(exe) = probe.exe.as_deref() else {
            return;
        };
        // Once per program per run: this is re-probed on every sweep, so
        // without the guard it would be a line every few seconds.
        if !elevated_notice_is_new(exe) {
            return;
        }
        log::info!(
            "{exe} runs as administrator; leaving its windows out of the grid              (Windows refuses to move them)"
        );
    }

    /// Does `pid` run at a higher integrity level than Griddle — the
    /// "run as administrator" case?
    ///
    /// The discriminator is the process *token*, not the process handle.
    /// `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` is granted across
    /// integrity levels by design — it is what lets us read an elevated
    /// process's image name — so it tells us nothing. `OpenProcessToken` is
    /// not granted downward, so being refused it is the signal.
    ///
    /// Conservative on every failure: if we cannot tell, we answer `false`
    /// and leave the window managed, because wrongly excluding an ordinary
    /// window is the worse mistake — it would silently vanish from the grid
    /// with no way for the user to find out why.
    ///
    /// When Griddle itself is elevated it can move everything, so the whole
    /// question is moot and this always answers `false`.
    fn process_is_elevated(pid: u32) -> bool {
        if pid == 0 || self_is_elevated() {
            return false;
        }
        unsafe {
            let Ok(proc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut token = windows::Win32::Foundation::HANDLE::default();
            let opened = OpenProcessToken(proc, TOKEN_QUERY, &mut token).is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(proc);
            if !opened {
                // Refused the token on a process we could otherwise open:
                // it sits above us. This is the elevated case.
                return true;
            }
            let _ = windows::Win32::Foundation::CloseHandle(token);
            false
        }
    }

    /// Is Griddle itself elevated? Cached: it cannot change within a run.
    fn self_is_elevated() -> bool {
        use std::sync::OnceLock;
        static SELF: OnceLock<bool> = OnceLock::new();
        *SELF.get_or_init(|| unsafe {
            let mut token = windows::Win32::Foundation::HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut info = TOKEN_ELEVATION::default();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut info as *mut _ as *mut c_void),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
            .is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(token);
            ok && info.TokenIsElevated != 0
        })
    }

    /// Spec §5.1 eligibility for a live window handle.
    pub fn is_eligible(hwnd: isize) -> bool {
        let key = hwnd;
        let hwnd = HWND(hwnd as *mut c_void);
        let Some(probe) = probe_window(hwnd) else {
            return false;
        };
        is_eligible_probe(
            &probe,
            unsafe { GetCurrentProcessId() },
            &exclusions(),
            super::own_window_is_managed(key),
        )
    }

    /// Security review ("handle reuse"): re-verify a tracked hwnd immediately
    /// before the actuator moves or focuses it. `true` only when the handle
    /// is still alive, its owning exe matches the tracked `WindowInfo`
    /// ([`probe_matches_tracked`](super::probe_matches_tracked)) and it still
    /// passes the structural eligibility bits (visible, top-level,
    /// uncloaked, not a tool window, captioned, not excluded). This closes
    /// both the destroy-vs-hook race (the DESTROY WinEvent is asynchronous)
    /// and the recycled-handle case.
    ///
    /// The own-pid rule is applied with a sentinel pid rather than the real
    /// one: the only own window that can enter the tracked set is Settings
    /// (the spec 2026-08-20 carve-out — snapshot and hook paths admit it by
    /// exact hwnd), which the actuator must then be allowed to move; the
    /// exe-identity match still rejects a handle recycled across processes;
    /// and the sentinel keeps this check exercisable from in-process
    /// `CreateWindowExW` test windows.
    pub fn verify_for_actuation(key: isize) -> bool {
        /// No real Windows pid is ever `u32::MAX` (pids are multiples of 4).
        const SENTINEL_OWN_PID: u32 = u32::MAX;
        let Some(tracked) = super::tracked_window(key) else {
            return false;
        };
        let hwnd = HWND(key as *mut c_void);
        let Some(probe) = probe_window(hwnd) else {
            return false;
        };
        is_eligible_probe(&probe, SENTINEL_OWN_PID, &exclusions(), false)
            && super::probe_matches_tracked(&tracked, &probe)
    }

    // -- WindowInfo construction --------------------------------------------

    /// The visible frame rect: `DWMWA_EXTENDED_FRAME_BOUNDS` (excludes the
    /// invisible resize borders), falling back to `GetWindowRect` when DWM
    /// declines. Physical virtual-desktop pixels either way.
    pub(crate) fn extended_frame_bounds(hwnd: HWND) -> Option<RECT> {
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
    ///
    /// Critique fix (untracked window-state changes): a *maximized* window is
    /// reported as `minimized` at this boundary. The brain treats minimized
    /// windows as "not occupying a slot" — exactly the right semantics for
    /// maximized ones too: they are never swept into a grid and never
    /// repositioned while maximized (a tiling manager resizing a maximized
    /// window is the classic embarrassment). The maximize/unmaximize
    /// transitions themselves are translated to `window-minimized` /
    /// `window-restored` by [`on_location_change`].
    pub(super) fn window_info(hwnd: HWND, probe: &WindowProbe) -> Option<WindowInfo> {
        let rect = extended_frame_bounds(hwnd)?;
        let exe = probe.exe.clone()?;
        let (min_width, min_height) = min_track_size(hwnd);
        Some(WindowInfo {
            hwnd: (hwnd.0 as isize).to_string(),
            title: window_title(hwnd),
            exe,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            monitor_id: monitor_id_of(hwnd),
            minimized: unsafe { IsIconic(hwnd) }.as_bool()
                || probe.style & style_bits::WS_MAXIMIZE != 0,
            resizable: probe.style & style_bits::WS_THICKFRAME != 0,
            min_width,
            min_height,
        })
    }

    /// The window's minimum tracking size via `WM_GETMINMAXINFO` (spec
    /// 2026-08-20): Electron apps in particular enforce a minimum the OS
    /// clamps every resize to, so a cell smaller than this overflows —
    /// famously Discord in a thin column. Sent with a short abort-if-hung
    /// timeout so one wedged app cannot stall a resync; a window that never
    /// touches the zeroed struct reports (0, 0) = no known minimum.
    fn min_track_size(hwnd: HWND) -> (i32, i32) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, MINMAXINFO, SMTO_ABORTIFHUNG, WM_GETMINMAXINFO,
        };
        let mut mmi = MINMAXINFO::default();
        let ok = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_GETMINMAXINFO,
                WPARAM(0),
                LPARAM(&mut mmi as *mut _ as isize),
                SMTO_ABORTIFHUNG,
                100,
                None,
            )
        };
        if ok.0 == 0 {
            return (0, 0);
        }
        (mmi.ptMinTrackSize.x.max(0), mmi.ptMinTrackSize.y.max(0))
    }

    // -- snapshotting -------------------------------------------------------

    /// Enumerate all eligible top-level windows and resync the live eligible
    /// set to exactly this snapshot.
    pub fn snapshot() -> Vec<WindowInfo> {
        let out = enumerate_eligible();
        reseed_tracked(&out);
        out
    }

    /// Read-only desktop sweep: the same enumeration, no live-set reseed.
    /// Serves the settings window's `list_windows` calls (critique round 2,
    /// least privilege): the live set is the authority for the actuation
    /// security rule, so a read from a less-privileged webview must not
    /// mutate it.
    pub fn snapshot_readonly() -> Vec<WindowInfo> {
        enumerate_eligible()
    }

    fn enumerate_eligible() -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = Vec::new();
        unsafe {
            // EnumWindows fails only if the callback returns FALSE, which
            // ours never does.
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut out as *mut Vec<WindowInfo> as isize),
            );
        }
        out
    }

    /// Re-sweep the desktop after an eligibility input changed (exclusion
    /// list edit, plan Task 19) and translate the difference into contract C2
    /// events: windows that left the managed universe emit
    /// `window-destroyed`, newly eligible ones emit `window-appeared`. The
    /// sweep itself reseeds the live set, so the security rule is truthful
    /// the moment this returns.
    pub fn resync() {
        let before = tracked_map()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let after = snapshot();
        let (gone, appeared) = diff_live_set(&before, &after);
        if !gone.is_empty() || !appeared.is_empty() {
            log::info!(
                "tracker resync: {} window(s) left, {} appeared",
                gone.len(),
                appeared.len()
            );
        }
        for hwnd in gone {
            emit(events::WINDOW_DESTROYED, HwndPayload { hwnd });
        }
        for w in appeared {
            emit(events::WINDOW_APPEARED, w);
        }
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Raw-pointer work stays outside the guard closure; the closure body
        // is pure safe Rust whose panics must not unwind into EnumWindows
        // (security review: FFI panic safety).
        let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        let own_pid = GetCurrentProcessId();
        crate::ffi_guard::guard("EnumWindows callback", BOOL(1), move || {
            if let Some(probe) = probe_window(hwnd) {
                let allowed_own = super::own_window_is_managed(hwnd.0 as isize);
                if is_eligible_probe(&probe, own_pid, &exclusions(), allowed_own) {
                    if let Some(info) = window_info(hwnd, &probe) {
                        out.push(info);
                    }
                } else {
                    note_elevated(&probe, own_pid, allowed_own);
                }
            }
            BOOL(1) // keep enumerating
        })
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
        let ranges: [(u32, u32); 5] = [
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            // CREATE(0x8000), DESTROY(0x8001), SHOW(0x8002), HIDE(0x8003)
            (EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE),
            (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
            // Maximize/unmaximize produce no dedicated WinEvent; the zoom
            // state is tracked through LOCATIONCHANGE transitions instead
            // (critique fix: untracked window-state changes). The handler is
            // a cheap early-out for untracked windows.
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
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
                // Not SKIPOWNPROCESS (spec 2026-08-20): the Settings
                // window is managed now, so its events must arrive. Every
                // other own window is filtered at the top of the callback.
                WINEVENT_OUTOFCONTEXT,
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
        // Own-process events flow (the hook does not set SKIPOWNPROCESS, so
        // an opted-in Settings window is visible), which makes every overlay
        // fade and brain repaint a callback. Drop all of ours before any real
        // work happens - including Settings unless the user opted it in, so
        // the default path costs exactly what SKIPOWNPROCESS would.
        {
            let mut pid: u32 = 0;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == GetCurrentProcessId() && !super::own_window_is_managed(hwnd.0 as isize) {
                return;
            }
        }
        // The handlers call into allocating/third-party code (tauri emit);
        // a panic there must not unwind into the WinEvent dispatcher
        // (security review: FFI panic safety).
        crate::ffi_guard::guard("WinEvent callback", (), || match event {
            EVENT_OBJECT_CREATE | EVENT_OBJECT_SHOW | EVENT_OBJECT_UNCLOAKED => {
                on_appear_candidate(hwnd)
            }
            EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE | EVENT_OBJECT_CLOAKED => on_gone(hwnd),
            EVENT_SYSTEM_MINIMIZESTART => on_minimize(hwnd),
            EVENT_SYSTEM_MINIMIZEEND => on_restore(hwnd),
            EVENT_SYSTEM_MOVESIZESTART => on_movesize_start(hwnd),
            EVENT_SYSTEM_MOVESIZEEND => on_movesize_end(hwnd),
            EVENT_OBJECT_LOCATIONCHANGE => sync_zoom_state(hwnd),
            _ => {}
        })
    }

    fn emit<T: serde::Serialize + Clone>(event: &str, payload: T) {
        // Plan Task 18: pause short-circuits all tracker emission — the live
        // eligible set keeps updating (the security rule stays truthful) but
        // the brain hears nothing until resume.
        if crate::shell::is_paused() {
            return;
        }
        let Some(app) = APP_HANDLE.get() else {
            return;
        };
        // Targeted emit (critique round 2, drag hot path): window events are
        // consumed only by the brain host, so serializing + delivering them
        // to every webview (settings + one overlay per monitor) is wasted
        // per-event IPC work.
        if let Err(e) = app.emit_to(crate::guard::MAIN_LABEL, event, payload) {
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
        let allowed_own = super::own_window_is_managed(key);
        if !is_eligible_probe(
            &probe,
            unsafe { GetCurrentProcessId() },
            &exclusions(),
            allowed_own,
        ) {
            note_elevated(&probe, unsafe { GetCurrentProcessId() }, allowed_own);
            return;
        }
        let Some(info) = window_info(hwnd, &probe) else {
            return;
        };
        // A window that appears already maximized stays out of the grid
        // (window_info reports it minimized); seed the zoom set so the
        // eventual unmaximize emits window-restored and it gets managed.
        if probe.style & style_bits::WS_MAXIMIZE != 0 {
            zoomed_insert(key);
        }
        insert_tracked(key, info.clone());
        emit(events::WINDOW_APPEARED, info);
    }

    fn on_gone(hwnd: HWND) {
        let key = hwnd.0 as isize;
        // Stop any in-flight drag sampler for this window (Task 14: no
        // leaked pump threads when a window dies mid-drag).
        crate::drag_pump::on_window_gone(key);
        zoomed_remove(key);
        if remove_tracked(key).is_some() {
            emit(
                events::WINDOW_DESTROYED,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
        }
    }

    /// Critique fix (untracked window-state changes): maximize / Win-Arrow
    /// style transitions produce no dedicated WinEvent, so the zoom state is
    /// derived from LOCATIONCHANGE. A tracked window turning maximized emits
    /// `window-minimized` — the brain releases its tile (remembering the
    /// slot) and leaves the maximized window alone; turning unmaximized
    /// emits `window-restored`, re-managing it. Transitions are deferred
    /// while a modal move-size loop runs (drag-to-unsnap) so the brain never
    /// fights the user's drag — [`on_movesize_end`] re-syncs afterwards.
    fn sync_zoom_state(hwnd: HWND) {
        let key = hwnd.0 as isize;
        if !is_tracked(key) {
            return;
        }
        if crate::drag_pump::is_dragging(key) {
            return;
        }
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return; // the minimize flow owns iconic transitions
        }
        let zoomed = unsafe { IsZoomed(hwnd) }.as_bool();
        let mut set = zoomed_lock().lock().unwrap_or_else(|p| p.into_inner());
        if set.contains(&key) == zoomed {
            return;
        }
        if zoomed {
            set.insert(key);
            drop(set);
            emit(
                events::WINDOW_MINIMIZED,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
        } else {
            set.remove(&key);
            drop(set);
            on_restore(hwnd);
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
        if probe.style & style_bits::WS_MAXIMIZE != 0 {
            // Restored from the taskbar straight back into the maximized
            // state: it stays out of the grid; the unmaximize transition
            // (sync_zoom_state) re-manages it later.
            zoomed_insert(key);
            insert_tracked(key, info);
            return;
        }
        // MINIMIZEEND can race the restore animation; the contract event is
        // definitionally "restored".
        info.minimized = false;
        insert_tracked(key, info.clone());
        emit(events::WINDOW_RESTORED, info);
    }

    fn on_movesize_start(hwnd: HWND) {
        // Plan Task 18: while paused a drag is just a drag — no event, and no
        // drag-pos sampler either.
        if crate::shell::is_paused() {
            return;
        }
        let key = hwnd.0 as isize;
        if is_tracked(key) {
            log::debug!("movesize-start: hwnd {key} is tracked; starting drag sampler");
            emit(
                events::MOVESIZE_START,
                HwndPayload {
                    hwnd: key.to_string(),
                },
            );
            // Task 14: start the 16 ms drag sampler emitting `drag-pos`.
            crate::drag_pump::on_move_size_start(key);
        } else {
            // The commonest reason a drag "does nothing": the window is not in
            // the live eligible set, so no overlay and no placement can follow.
            log::debug!("movesize-start: hwnd {key} is NOT tracked; ignoring the drag");
            // When the reason is "runs as administrator", say so. This is the
            // moment the exclusion is confusing: the user is dragging, nothing
            // tiles, and until now nothing anywhere explained it.
            announce_elevated_drag(hwnd, key);
        }
    }

    /// Tell the host the user is dragging an elevated window, so it can put
    /// the reason on that monitor's overlay. Cheap to compute and only ever
    /// runs on an untracked drag start, which is rare.
    fn announce_elevated_drag(hwnd: HWND, key: isize) {
        let Some(probe) = probe_window(hwnd) else {
            return;
        };
        let own_pid = unsafe { GetCurrentProcessId() };
        if !super::elevated_is_the_only_reason(&probe, own_pid, super::own_window_is_managed(key)) {
            return;
        }
        let Some(exe) = probe.exe.clone() else {
            return;
        };
        let monitor_id = monitor_id_of(hwnd);
        emit(
            events::ELEVATED_DRAG,
            crate::ipc::ElevatedDrag {
                hwnd: key.to_string(),
                monitor_id,
                exe,
            },
        );
    }

    fn on_movesize_end(hwnd: HWND) {
        let key = hwnd.0 as isize;
        // Stop the drag sampler even if the window got untracked mid-drag;
        // the final rect travels with the `movesize-end` event below.
        crate::drag_pump::on_move_size_end(key);
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
        // Zoom transitions were deferred while the modal move-size loop ran
        // (drag-to-unsnap unmaximizes mid-drag); converge now.
        sync_zoom_state(hwnd);
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
            elevated: false,
        }
    }

    /// Log review 2026-08-21: an elevated window is ineligible even though it
    /// looks perfectly ordinary from every other angle. The old rule assumed
    /// an unreadable exe stood in for elevation; it does not, because
    /// `PROCESS_QUERY_LIMITED_INFORMATION` names elevated processes happily.
    /// So the admin console sailed through, took a tile, pushed real windows
    /// aside to make room, and then refused every move with access-denied.
    #[test]
    fn elevated_windows_are_never_eligible() {
        let mut p = probe(WS_VISIBLE | WS_CAPTION | WS_THICKFRAME, 0);
        assert!(eligible(&p), "the same window is eligible when not elevated");
        p.elevated = true;
        assert!(
            !eligible(&p),
            "an elevated window must stay out of the managed set entirely"
        );
        // Naming it is not the test: elevated processes can be named.
        assert!(p.exe.is_some());
    }

    /// The drag-time notice must fire for exactly the windows a user would
    /// expect to tile — otherwise it either stays silent on the admin console
    /// (the bug) or shouts about invisible plumbing windows (the overcorrect).
    #[test]
    fn the_elevated_notice_fires_only_when_elevation_is_the_sole_reason() {
        let only = |p: &WindowProbe| elevated_is_the_only_reason(p, OWN_PID, false);

        // The admin console: ordinary in every way except elevation.
        let mut admin = probe(APP_STYLE, 0);
        admin.elevated = true;
        assert!(only(&admin), "an otherwise-ordinary elevated window is the whole point");

        // Not elevated: there is nothing to explain.
        assert!(!only(&probe(APP_STYLE, 0)), "a managed window needs no notice");

        // Elevated *and* ineligible for another reason: the user never
        // expected these to tile, so a notice would be noise.
        let mut cloaked = probe(APP_STYLE, 0);
        cloaked.elevated = true;
        cloaked.cloaked = true;
        assert!(!only(&cloaked), "a cloaked window is skipped for its own reasons");

        let mut tool = probe(APP_STYLE, WS_EX_TOOLWINDOW);
        tool.elevated = true;
        assert!(!only(&tool), "a tool window is skipped for its own reasons");
    }

    /// Style of a plain resizable app window (Notepad-like).
    const APP_STYLE: u32 = WS_VISIBLE | WS_CAPTION | WS_THICKFRAME;

    fn eligible(p: &WindowProbe) -> bool {
        is_eligible_probe(p, OWN_PID, &[], false)
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
    fn captionless_windows_are_eligible() {
        // User decision 2026-08-20 ("do not exclude any windows from the
        // grid"): the caption gate silently rejected custom-chrome apps and
        // borderless windows, which are real windows to the user. A bare
        // visible popup, a WS_BORDER-only frame, and an APPWINDOW-styled
        // frameless app are all managed alike now.
        assert!(eligible(&probe(WS_VISIBLE, 0)));
        assert!(eligible(&probe(WS_VISIBLE | 0x0080_0000, 0)));
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
        assert!(!is_eligible_probe(&p, OWN_PID, &exclusions, false));
    }

    #[test]
    fn non_excluded_exe_stays_eligible() {
        let p = probe(APP_STYLE, 0);
        let exclusions = vec!["slack.exe".to_string()];
        assert!(is_eligible_probe(&p, OWN_PID, &exclusions, false));
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

    // -- actuation-time identity (security review: handle reuse) --------------

    #[test]
    fn probe_matches_tracked_requires_the_same_exe() {
        let tracked = fake_info(10); // exe "t.exe"
        let mut p = probe(APP_STYLE, 0);
        p.exe = Some("t.exe".into());
        assert!(probe_matches_tracked(&tracked, &p));
        p.exe = Some("notepad.exe".into());
        assert!(!probe_matches_tracked(&tracked, &p), "different exe = different window");
        p.exe = None;
        assert!(!probe_matches_tracked(&tracked, &p), "unqueryable exe never matches");
    }

    // -- exclusion-list state ------------------------------------------------

    #[test]
    fn set_exclusions_normalizes_to_lowercase_and_reports_changes() {
        // The exclusion list is process-global and consulted by the
        // actuation-time re-check; serialize with the tests that rely on it.
        let _guard = live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(set_exclusions(vec!["Slack.EXE".into(), "FIGMA.exe".into()]));
        assert_eq!(exclusions(), vec!["slack.exe", "figma.exe"]);
        // Same normalized content (case differences only) is not a change.
        assert!(!set_exclusions(vec!["slack.exe".into(), "Figma.EXE".into()]));
        assert!(set_exclusions(Vec::new()));
        assert!(exclusions().is_empty());
        assert!(!set_exclusions(Vec::new()));
    }

    // -- resync diff (plan Task 19) -------------------------------------------

    #[test]
    fn diff_live_set_reports_gone_and_appeared() {
        let before = HashMap::from([(10, fake_info(10)), (20, fake_info(20))]);
        let after = vec![fake_info(20), fake_info(30)];
        let (gone, appeared) = diff_live_set(&before, &after);
        assert_eq!(gone, vec!["10".to_string()]);
        assert_eq!(
            appeared.iter().map(|w| w.hwnd.as_str()).collect::<Vec<_>>(),
            vec!["30"]
        );
    }

    #[test]
    fn diff_live_set_of_identical_sets_is_empty() {
        let before = HashMap::from([(10, fake_info(10)), (20, fake_info(20))]);
        let after = vec![fake_info(10), fake_info(20)];
        let (gone, appeared) = diff_live_set(&before, &after);
        assert!(gone.is_empty());
        assert!(appeared.is_empty());
    }

    #[test]
    fn diff_live_set_gone_hwnds_are_sorted_ascending() {
        let before = HashMap::from([
            (30, fake_info(30)),
            (10, fake_info(10)),
            (20, fake_info(20)),
        ]);
        let (gone, appeared) = diff_live_set(&before, &[]);
        assert_eq!(gone, vec!["10".to_string(), "20".into(), "30".into()]);
        assert!(appeared.is_empty());
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
            min_width: 0,
            min_height: 0,
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
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, WINDOW_EX_STYLE, WINDOW_STYLE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    /// Create a real top-level window with the given styles.
    fn create_test_window(style: WINDOW_STYLE, exstyle: WINDOW_EX_STYLE) -> HWND {
        crate::test_windows::create_styled_test_window(
            "Griddle tracker test window",
            style,
            exstyle,
            400,
            300,
        )
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
        assert!(is_eligible_probe(&probe, probe.pid + 1, &[], false));

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

    /// Critique fix (untracked window-state changes): a maximized window is
    /// reported `minimized` at the contract boundary, so the brain never
    /// sweeps it into a grid or repositions it while maximized.
    #[test]
    fn maximized_window_reports_as_minimized_at_the_contract_boundary() {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MAXIMIZE, SW_RESTORE};
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, Default::default());
        unsafe {
            let _ = ShowWindow(hwnd, SW_MAXIMIZE);
        }
        let probe = probe_window(hwnd).expect("probe maximized");
        assert_ne!(probe.style & style_bits::WS_MAXIMIZE, 0, "WS_MAXIMIZE set");
        let info = window_info(hwnd, &probe).expect("info maximized");
        assert!(info.minimized, "maximized window must stay out of grids");

        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let probe = probe_window(hwnd).expect("probe restored");
        let info = window_info(hwnd, &probe).expect("info restored");
        assert!(!info.minimized, "restored window is manageable again");

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
        assert!(!is_eligible_probe(&probe, probe.pid + 1, &[], false));
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

    /// Security review ("handle reuse"): the actuation-time re-check accepts
    /// a live handle whose identity matches the tracked info and rejects
    /// untracked or dead handles.
    #[test]
    fn verify_for_actuation_full_lifecycle() {
        let _guard = live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window(WS_OVERLAPPEDWINDOW | WS_VISIBLE, Default::default());
        let key = hwnd.0 as isize;

        assert!(!verify_for_actuation(key), "untracked handle never verifies");

        crate::test_windows::track_test_window(hwnd, "Griddle tracker test window");
        assert!(verify_for_actuation(key), "live handle with matching exe verifies");

        // Excluding the owning exe revokes actuation too (re-checked live).
        let own_exe = process_exe(std::process::id()).unwrap();
        assert!(set_exclusions(vec![own_exe]));
        assert!(!verify_for_actuation(key), "excluded exe fails the re-check");
        assert!(set_exclusions(Vec::new()));

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
        assert!(!verify_for_actuation(key), "dead handle never verifies");
        let _ = untrack(key);
    }

    /// Critique round 2 (least privilege): the settings window's enumeration
    /// path must not touch the live eligible set — the set is the authority
    /// behind the actuation security rule, and only brain-host calls plus
    /// the tracker's own resync may reseed it.
    #[test]
    fn own_process_settings_window_is_eligible_only_via_the_carve_out() {
        // Spec 2026-08-20: the one own-process window users see (Settings)
        // tiles like any other window; every other own window stays out.
        let p = WindowProbe {
            style: style_bits::WS_VISIBLE | style_bits::WS_CAPTION,
            exstyle: 0,
            cloaked: false,
            pid: 4242,
            exe: Some("griddle-wm.exe".into()),
            elevated: false,
        };
        assert!(
            !is_eligible_probe(&p, 4242, &[], false),
            "own-process without the carve-out: excluded (brain, dialogs)"
        );
        assert!(
            is_eligible_probe(&p, 4242, &[], true),
            "the registered settings hwnd is a normal managed window"
        );
        assert!(
            is_eligible_probe(&p, 9999, &[], false),
            "foreign windows never needed the carve-out"
        );
        // The user's exclusion list still outranks the carve-out.
        assert!(!is_eligible_probe(&p, 4242, &["griddle-wm.exe".into()], true));
    }

    #[test]
    fn snapshot_readonly_never_mutates_the_live_set() {
        let _guard = live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // A fake entry no real enumeration would return: a reseed would
        // purge it, a read-only sweep must leave it alone.
        let key = -301isize;
        insert_tracked(
            key,
            WindowInfo {
                hwnd: key.to_string(),
                title: "T".into(),
                exe: "t.exe".into(),
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                monitor_id: "m".into(),
                minimized: false,
                min_width: 0,
            min_height: 0,
            resizable: true,
            },
        );

        let before: std::collections::HashSet<String> = tracked_windows()
            .into_iter()
            .map(|w| w.hwnd)
            .collect();
        let _ = snapshot_readonly();
        let after: std::collections::HashSet<String> = tracked_windows()
            .into_iter()
            .map(|w| w.hwnd)
            .collect();
        assert!(is_tracked(key), "read-only sweep must not purge the live set");
        assert_eq!(before, after, "read-only sweep must not seed or purge anything");

        // The real snapshot purges the fake entry (reseed semantics intact).
        let _ = snapshot();
        assert!(!is_tracked(key), "real snapshot reseeds the live set");
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
