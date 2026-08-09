//! Shared Windows integration-test support (plan Task 12): real
//! `CreateWindowExW` windows for exercising the actuator/tracker code paths
//! against live HWNDs, plus the end-to-end test that drives three spawned
//! windows through the same code path `apply_layout` uses.
//!
//! Compiled only for `#[cfg(all(test, windows))]`; used by this module's own
//! tests and by `actuator::win_tests` / `tracker::win_tests`.

use crate::actuator::Rect;
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::OnceLock;
use std::time::Duration;
use windows::core::{w, HSTRING};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetWindowRect, RegisterClassExW, WINDOW_EX_STYLE,
    WINDOW_STYLE, WNDCLASSEXW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

unsafe extern "system" fn test_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Register the shared test window class exactly once (tests run on parallel
/// threads within one process).
fn ensure_class() {
    static REGISTERED: OnceLock<()> = OnceLock::new();
    REGISTERED.get_or_init(|| unsafe {
        let hinstance = GetModuleHandleW(None).expect("GetModuleHandleW");
        let wc = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(test_wndproc),
            hInstance: hinstance.into(),
            lpszClassName: w!("GriddleWmTestWindow"),
            ..Default::default()
        };
        assert_ne!(RegisterClassExW(&wc), 0, "RegisterClassExW failed");
    });
}

/// Spawn a real, visible, resizable top-level window (`WS_OVERLAPPEDWINDOW |
/// WS_VISIBLE`) with the given title and outer size. The caller owns the
/// handle and must `DestroyWindow` it.
pub(crate) fn create_test_window(title: &str, w: i32, h: i32) -> HWND {
    create_styled_test_window(
        title,
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        WINDOW_EX_STYLE::default(),
        w,
        h,
    )
}

/// [`create_test_window`] with explicit style bits, for tracker eligibility
/// tests (tool windows, invisible windows, ...).
pub(crate) fn create_styled_test_window(
    title: &str,
    style: WINDOW_STYLE,
    exstyle: WINDOW_EX_STYLE,
    w: i32,
    h: i32,
) -> HWND {
    ensure_class();
    unsafe {
        let hinstance = GetModuleHandleW(None).expect("GetModuleHandleW");
        CreateWindowExW(
            exstyle,
            w!("GriddleWmTestWindow"),
            &HSTRING::from(title),
            style,
            60,
            60,
            w,
            h,
            None,
            None,
            Some(hinstance.into()),
            None,
        )
        .expect("CreateWindowExW")
    }
}

/// Seed the tracker's live eligible set for a test window so the contract C2
/// security rule admits it. Returns the hwnd key.
pub(crate) fn track_test_window(hwnd: HWND, title: &str) -> isize {
    let key = hwnd.0 as isize;
    let raw = raw_rect(hwnd);
    crate::tracker::track_for_test(
        key,
        crate::ipc::WindowInfo {
            hwnd: key.to_string(),
            title: title.into(),
            exe: "griddle-test.exe".into(),
            x: raw.x,
            y: raw.y,
            width: raw.width,
            height: raw.height,
            monitor_id: "m".into(),
            minimized: false,
            resizable: true,
        },
    );
    key
}

/// Raw window rect (`GetWindowRect`), physical pixels.
pub(crate) fn raw_rect(hwnd: HWND) -> Rect {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r).expect("GetWindowRect") };
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// Visible frame rect (`DWMWA_EXTENDED_FRAME_BOUNDS`), physical pixels.
pub(crate) fn frame_bounds(hwnd: HWND) -> Rect {
    let mut r = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
        .expect("DWMWA_EXTENDED_FRAME_BOUNDS");
    }
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// DWM may publish new frame bounds a moment after `SetWindowPos`; poll
/// briefly before asserting, returning the last observed frame.
pub(crate) fn wait_for_frame(hwnd: HWND, target: &Rect) -> Rect {
    for _ in 0..50 {
        let frame = frame_bounds(hwnd);
        if crate::actuator::rects_match(target, &frame, Duration::ZERO) {
            return frame;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    frame_bounds(hwnd)
}

// ---------------------------------------------------------------------------
// End-to-end: 3 real windows through the apply_layout code path
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actuator::{
        apply_validated, compensate_target, rects_match, MATCH_TOLERANCE_PX,
    };
    use crate::ipc::{ApplyLayout, Move};
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    /// Plan Task 12 integration test: spawn 3 test windows, run them through
    /// `apply_validated` (the exact code path the `apply_layout` command uses
    /// after unwrapping the AppHandle), and assert `GetWindowRect` /
    /// the visible frame land on a 3-column layout within tolerance.
    #[test]
    fn three_spawned_windows_snap_to_three_column_layout() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());

        let windows: Vec<HWND> = (1..=3)
            .map(|i| create_test_window(&format!("Griddle e2e window {i}"), 400, 300))
            .collect();
        let keys: Vec<isize> = windows
            .iter()
            .enumerate()
            .map(|(i, &hwnd)| track_test_window(hwnd, &format!("Griddle e2e window {i}")))
            .collect();

        // Three side-by-side cells of a 3×1 grid over a 1260×600 work area —
        // exactly what the brain's cellRect would emit for 3 tiled windows.
        let targets: Vec<Rect> = (0..3)
            .map(|col| Rect {
                x: col * 420,
                y: 0,
                width: 420,
                height: 600,
            })
            .collect();

        // Rects before the move, to compute the expected compensated raw rect.
        let before: Vec<(Rect, Rect)> = windows
            .iter()
            .map(|&hwnd| (raw_rect(hwnd), frame_bounds(hwnd)))
            .collect();

        let layout = ApplyLayout {
            moves: keys
                .iter()
                .zip(&targets)
                .map(|(key, t)| Move {
                    hwnd: key.to_string(),
                    x: t.x,
                    y: t.y,
                    width: t.width,
                    height: t.height,
                })
                .collect(),
        };

        let mut destroyed = Vec::new();
        let applied = apply_validated(&layout, &mut |k| destroyed.push(k));
        assert_eq!(applied, 3, "all three windows moved in one batch");
        assert!(destroyed.is_empty());

        for ((&hwnd, target), (raw_before, frame_before)) in
            windows.iter().zip(&targets).zip(&before)
        {
            // GetWindowRect matches the frame-compensated target within
            // tolerance (it is set exactly, so this is belt and braces).
            let expected_raw = compensate_target(target, raw_before, frame_before);
            let raw_after = raw_rect(hwnd);
            assert!(
                rects_match(&expected_raw, &raw_after, Duration::ZERO),
                "GetWindowRect {raw_after:?} not within ±{MATCH_TOLERANCE_PX}px of {expected_raw:?}"
            );
            // ...which means the visible frame sits on the brain's cell rect.
            let frame_after = wait_for_frame(hwnd, target);
            assert!(
                rects_match(target, &frame_after, Duration::ZERO),
                "frame {frame_after:?} not within ±{MATCH_TOLERANCE_PX}px of target {target:?}"
            );
        }

        // No two windows overlap: successive columns abut exactly.
        for pair in windows.windows(2).zip(targets.windows(2)) {
            let (w, t) = pair;
            let left = wait_for_frame(w[0], &t[0]);
            let right = wait_for_frame(w[1], &t[1]);
            assert!(
                left.x + left.width <= right.x + MATCH_TOLERANCE_PX,
                "columns overlap: {left:?} vs {right:?}"
            );
        }

        for (&hwnd, key) in windows.iter().zip(&keys) {
            let _ = crate::tracker::untrack(*key);
            unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
        }
    }
}
