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

    /// Pixel offset of grid line `i` out of `count` over `extent` px —
    /// the brain's floor-accumulate cell-edge rule (packages/brain
    /// src/coords.ts `edge`), mirrored here so the expected rects are
    /// literally what `enableGrid` → `placeWindow` → `flush` would emit.
    fn cell_edge(extent: i32, count: i32, i: i32) -> i32 {
        if i >= count {
            extent
        } else {
            ((i as i64 * extent as i64) / count as i64) as i32
        }
    }

    /// The brain's `cellRect` for a 1×1 slot at (col, row) of a cols×rows
    /// grid over the given work area.
    fn cell_rect(
        work: &Rect,
        cols: i32,
        rows: i32,
        col: i32,
        row: i32,
    ) -> Rect {
        let x0 = cell_edge(work.width, cols, col);
        let x1 = cell_edge(work.width, cols, col + 1);
        let y0 = cell_edge(work.height, rows, row);
        let y1 = cell_edge(work.height, rows, row + 1);
        Rect {
            x: work.x + x0,
            y: work.y + y0,
            width: x1 - x0,
            height: y1 - y0,
        }
    }

    /// Plan Task 20 stress/integration test: 10 real windows through the
    /// grid-enable pipeline. The brain's `enableGrid` sweep places ten 1×1
    /// windows first-fit into reading order — cells (0,0)..(4,1) of a 5×2
    /// grid — and flushes one batched ApplyLayout; this test feeds exactly
    /// that batch through `apply_validated` (the `apply_layout` command's
    /// core) and asserts every real window's visible frame lands on its
    /// brain cell rect within ±2 px (MATCH_TOLERANCE_PX), with no overlap.
    /// The work area is deliberately not divisible by the grid dims so the
    /// remainder-absorbing last column/row is exercised on real HWNDs.
    #[test]
    fn ten_spawned_windows_snap_to_grid_enable_layout() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());

        const COLS: i32 = 5;
        const ROWS: i32 = 2;
        // 1237 % 5 != 0 and 763 % 2 != 0: last column/row absorb remainder.
        let work = Rect {
            x: 40,
            y: 40,
            width: 1237,
            height: 763,
        };

        let windows: Vec<HWND> = (1..=10)
            .map(|i| create_test_window(&format!("Griddle stress window {i}"), 400, 300))
            .collect();
        let keys: Vec<isize> = windows
            .iter()
            .enumerate()
            .map(|(i, &hwnd)| track_test_window(hwnd, &format!("Griddle stress window {i}")))
            .collect();

        let targets: Vec<Rect> = (0..10)
            .map(|i| cell_rect(&work, COLS, ROWS, i % COLS, i / COLS))
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
        assert_eq!(applied, 10, "all ten windows moved in one batch");
        assert!(destroyed.is_empty());

        let frames: Vec<Rect> = windows
            .iter()
            .zip(&targets)
            .map(|(&hwnd, target)| {
                let frame = wait_for_frame(hwnd, target);
                assert!(
                    rects_match(target, &frame, Duration::ZERO),
                    "frame {frame:?} not within ±{MATCH_TOLERANCE_PX}px of target {target:?}"
                );
                frame
            })
            .collect();

        // No two frames overlap beyond the shared tolerance: for every pair,
        // the visible frames are separated on at least one axis.
        for i in 0..frames.len() {
            for j in (i + 1)..frames.len() {
                let a = &frames[i];
                let b = &frames[j];
                let separated_x = a.x + a.width <= b.x + MATCH_TOLERANCE_PX
                    || b.x + b.width <= a.x + MATCH_TOLERANCE_PX;
                let separated_y = a.y + a.height <= b.y + MATCH_TOLERANCE_PX
                    || b.y + b.height <= a.y + MATCH_TOLERANCE_PX;
                assert!(
                    separated_x || separated_y,
                    "windows {i} and {j} overlap: {a:?} vs {b:?}"
                );
            }
        }

        // The grid tiles the full work area: cells of each row/column abut
        // exactly at the brain's floor-accumulate edges.
        for row in 0..ROWS {
            for col in 0..COLS - 1 {
                let left = &targets[(row * COLS + col) as usize];
                let right = &targets[(row * COLS + col + 1) as usize];
                assert_eq!(left.x + left.width, right.x, "column seam must abut");
            }
        }
        assert_eq!(targets[0].y + targets[0].height, targets[COLS as usize].y);
        assert_eq!(
            targets[(COLS * ROWS - 1) as usize].x + targets[(COLS * ROWS - 1) as usize].width,
            work.x + work.width,
            "last column absorbs the remainder"
        );

        for (&hwnd, key) in windows.iter().zip(&keys) {
            let _ = crate::tracker::untrack(*key);
            unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
        }
    }
}
