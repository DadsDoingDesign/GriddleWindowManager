//! Window actuation (plan Task 11, spec §6).
//!
//! The only module allowed to call `SetWindowPos`/`DeferWindowPos` on managed
//! windows (global constraint). Three layers:
//!
//! 1. **Pure math** — [`compensate_target`] (DWM frame-bounds compensation:
//!    the brain targets *visible frame* rects, `SetWindowPos` positions the
//!    raw window rect which includes the invisible resize borders) and
//!    [`rects_match`] (±[`MATCH_TOLERANCE_PX`] px within [`MATCH_WINDOW`]).
//!    Both are Win32-free and unit-tested with synthetic rects.
//! 2. **Expected-rect ledger** — every rect the actuator sets is recorded in
//!    a `Mutex<HashMap<hwnd, (Rect, Instant)>>` so the tracker/drag pump can
//!    call [`matches_expected`] to tell self-caused location changes from
//!    user actions (spec "expected rects" invariant).
//! 3. **Batched apply** — `apply_layout` validates every hwnd against the
//!    tracker's live eligible set (contract §C2 security rule: unknown hwnds
//!    are skipped and logged), then moves the survivors in one
//!    `BeginDeferWindowPos`/`DeferWindowPos`/`EndDeferWindowPos` batch with
//!    `SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS` (a hung app can
//!    never stall the whole transaction), falling back to per-window
//!    `SetWindowPos` if the batch is rejected mid-build. Dead handles are
//!    untracked and reported via `window-destroyed`.

use crate::ipc::{events, ApplyLayout, Hwnd, HwndPayload};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/// A window rectangle in physical virtual-desktop pixels. Same shape as the
/// contract C1 rect fields; kept Win32-free so the pure functions and their
/// tests need no bindings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Per-edge tolerance for [`rects_match`]: Win32 rounds window sizes to
/// physical pixels and some frameworks nudge themselves by a pixel.
pub const MATCH_TOLERANCE_PX: i32 = 2;

/// How long an expected rect stays valid. Long enough to cover the WinEvent
/// latency after `EndDeferWindowPos`, short enough that a user re-drag a
/// moment later is seen as user input again.
pub const MATCH_WINDOW: Duration = Duration::from_millis(500);

/// Does `actual` match `expected` within ±[`MATCH_TOLERANCE_PX`] on every
/// edge, observed no later than [`MATCH_WINDOW`] after the rect was recorded?
/// Pure: the caller supplies the elapsed time.
pub fn rects_match(expected: &Rect, actual: &Rect, elapsed: Duration) -> bool {
    elapsed <= MATCH_WINDOW
        && (expected.x - actual.x).abs() <= MATCH_TOLERANCE_PX
        && (expected.y - actual.y).abs() <= MATCH_TOLERANCE_PX
        && (expected.width - actual.width).abs() <= MATCH_TOLERANCE_PX
        && (expected.height - actual.height).abs() <= MATCH_TOLERANCE_PX
}

/// DWM frame-bounds compensation.
///
/// `target` is where the *visible* frame (`DWMWA_EXTENDED_FRAME_BOUNDS`)
/// must land. `SetWindowPos` positions the raw window rect (`GetWindowRect`),
/// which on Win10/11 extends past the visible frame by the invisible resize
/// borders (~7 px left/right/bottom for `WS_THICKFRAME` windows, 0 on top).
/// Given the window's current raw rect and frame rect, returns the raw rect
/// to pass to `SetWindowPos` so the frame ends up exactly on `target`.
///
/// The insets are measured, not hardcoded, so any border geometry (borderless
/// apps, DPI variations) compensates correctly; when raw == frame the result
/// is `target` unchanged.
pub fn compensate_target(target: &Rect, window_rect: &Rect, frame_rect: &Rect) -> Rect {
    Rect {
        x: target.x - (frame_rect.x - window_rect.x),
        y: target.y - (frame_rect.y - window_rect.y),
        width: target.width + (window_rect.width - frame_rect.width),
        height: target.height + (window_rect.height - frame_rect.height),
    }
}

// ---------------------------------------------------------------------------
// Expected-rect ledger
// ---------------------------------------------------------------------------

fn expected_map() -> &'static Mutex<HashMap<isize, (Rect, Instant)>> {
    static MAP: OnceLock<Mutex<HashMap<isize, (Rect, Instant)>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record the frame rect the actuator is about to set for `hwnd`. Expired
/// entries are pruned on the way in so the map stays bounded by the number
/// of windows moved in the last [`MATCH_WINDOW`].
pub fn record_expected(hwnd: isize, rect: Rect) {
    let now = Instant::now();
    let mut map = expected_map().lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, (_, at)| now.duration_since(*at) <= MATCH_WINDOW);
    map.insert(hwnd, (rect, now));
}

/// Spec §6 feedback-loop suppression: is `rect` (an observed extended-frame
/// rect) explained by a rect the actuator set for `hwnd` within the last
/// [`MATCH_WINDOW`], ±[`MATCH_TOLERANCE_PX`] px per edge?
pub fn matches_expected(hwnd: isize, rect: &Rect) -> bool {
    expected_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&hwnd)
        .is_some_and(|(expected, at)| rects_match(expected, rect, at.elapsed()))
}

// ---------------------------------------------------------------------------
// Validation + commands
// ---------------------------------------------------------------------------

/// Contract §C2 security rule: keep only moves whose hwnd parses and is in
/// the tracker's live eligible set; skipped entries are logged.
fn validated_targets(layout: &ApplyLayout) -> Vec<(isize, Rect)> {
    layout
        .moves
        .iter()
        .filter_map(|m| {
            let Ok(key) = m.hwnd.parse::<isize>() else {
                log::warn!("apply_layout: malformed hwnd {:?}, skipping", m.hwnd);
                return None;
            };
            if !crate::tracker::is_tracked(key) {
                log::warn!("apply_layout: hwnd {key} not in live eligible set, skipping");
                return None;
            }
            Some((
                key,
                Rect {
                    x: m.x,
                    y: m.y,
                    width: m.width,
                    height: m.height,
                },
            ))
        })
        .collect()
}

/// Validate + apply. `on_destroyed` is invoked (after untracking) for each
/// hwnd that turned out to be a dead handle. Returns the number of windows
/// actually repositioned. Factored out of the command so tests can drive it
/// without an `AppHandle`.
pub(crate) fn apply_validated(layout: &ApplyLayout, on_destroyed: &mut dyn FnMut(isize)) -> usize {
    // Plan Task 18: pause short-circuits the actuator — no window moves at
    // all while paused (spec §6 panic button).
    if crate::shell::is_paused() {
        log::debug!(
            "apply_layout: paused, dropping {} move(s)",
            layout.moves.len()
        );
        return 0;
    }
    let targets = validated_targets(layout);
    if targets.is_empty() {
        return 0;
    }
    apply_moves(&targets, on_destroyed)
}

/// Contract §C2: `apply_layout(layout: ApplyLayout)`. Only the brain host
/// (window label `main`) may actuate (security review: least privilege).
#[tauri::command]
pub fn apply_layout(app: tauri::AppHandle, window: tauri::Window, layout: ApplyLayout) {
    if crate::guard::authorize("apply_layout", window.label()).is_err() {
        return;
    }
    let requested = layout.moves.len();
    let mut gone: Vec<isize> = Vec::new();
    let applied = apply_validated(&layout, &mut |key| gone.push(key));
    for key in gone {
        let payload = HwndPayload {
            hwnd: key.to_string(),
        };
        if let Err(e) = app.emit(events::WINDOW_DESTROYED, payload) {
            log::error!("failed to emit {}: {e}", events::WINDOW_DESTROYED);
        }
    }
    log::debug!("apply_layout: applied {applied}/{requested} move(s)");
}

/// Contract §C2: `focus_window(hwnd)`. Same security rules as `apply_layout`
/// (caller label + live-set + actuation-time identity re-verification).
#[tauri::command]
pub fn focus_window(window: tauri::Window, hwnd: Hwnd) {
    if crate::guard::authorize("focus_window", window.label()).is_err() {
        return;
    }
    focus_validated(&hwnd);
}

/// Validation + focus, factored out of the command so tests can drive it
/// without a live `tauri::Window`.
pub(crate) fn focus_validated(hwnd: &str) {
    let Ok(key) = hwnd.parse::<isize>() else {
        log::warn!("focus_window: malformed hwnd {hwnd:?}, skipping");
        return;
    };
    if !crate::tracker::is_tracked(key) {
        log::warn!("focus_window: hwnd {key} not in live eligible set, skipping");
        return;
    }
    #[cfg(windows)]
    {
        // Security review (handle reuse): re-verify right before acting so a
        // recycled HWND can never focus a window we did not vet.
        if !crate::tracker::verify_for_actuation(key) {
            log::info!("focus_window: hwnd {key} is gone or no longer the tracked window, untracking");
            let _ = crate::tracker::untrack(key);
            return;
        }
        win::focus(key);
    }
}

#[cfg(windows)]
use win::apply_moves;

#[cfg(not(windows))]
fn apply_moves(_targets: &[(isize, Rect)], _on_destroyed: &mut dyn FnMut(isize)) -> usize {
    0
}

#[cfg(windows)]
mod win {
    use super::{compensate_target, record_expected, Rect};
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        BeginDeferWindowPos, DeferWindowPos, EndDeferWindowPos, GetWindowRect, IsIconic, IsWindow,
        IsZoomed, SetForegroundWindow, SetWindowPos, ShowWindow, HDWP, SET_WINDOW_POS_FLAGS,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE,
    };

    /// Flags for every managed-window move. `SWP_ASYNCWINDOWPOS` posts the
    /// reposition to the target's own thread instead of synchronously sending
    /// `WM_WINDOWPOSCHANGING` into it — one hung (not-responding) app can
    /// therefore never stall the whole layout transaction or the IPC thread
    /// (critique fix, actuator robustness). Same-thread windows (our tests'
    /// `CreateWindowExW` windows) are still applied synchronously by Win32.
    const MOVE_FLAGS: SET_WINDOW_POS_FLAGS =
        SET_WINDOW_POS_FLAGS(SWP_NOACTIVATE.0 | SWP_NOZORDER.0 | SWP_ASYNCWINDOWPOS.0);

    fn to_rect(r: RECT) -> Rect {
        Rect {
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        }
    }

    /// Current raw window rect + visible frame rect, or `None` when the
    /// handle is gone. When DWM declines the frame query the raw rect is
    /// used for both (zero compensation).
    fn window_and_frame_rects(hwnd: HWND) -> Option<(Rect, Rect)> {
        unsafe {
            let mut raw = RECT::default();
            GetWindowRect(hwnd, &mut raw).ok()?;
            let mut frame = RECT::default();
            let frame = if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut frame as *mut RECT as *mut c_void,
                size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                frame
            } else {
                raw
            };
            Some((to_rect(raw), to_rect(frame)))
        }
    }

    struct PreparedMove {
        key: isize,
        hwnd: HWND,
        /// Raw window rect for `SetWindowPos` (frame compensation applied).
        raw: Rect,
    }

    /// Move every (already validated) target in one `DeferWindowPos` batch;
    /// dead handles are untracked and reported through `on_destroyed`.
    ///
    /// Security review (handle reuse): being in the live set is necessary but
    /// not sufficient — Windows recycles HWND values quickly, and the
    /// `EVENT_OBJECT_DESTROY` hook is asynchronous, so a stale entry can
    /// briefly denote a *different* window. Each target is therefore
    /// re-probed here ([`crate::tracker::verify_for_actuation`]: same owning
    /// exe as the tracked `WindowInfo`, still structurally eligible) and
    /// mismatches take the dead-handle path instead of being moved.
    pub(super) fn apply_moves(
        targets: &[(isize, Rect)],
        on_destroyed: &mut dyn FnMut(isize),
    ) -> usize {
        let mut prepared: Vec<PreparedMove> = Vec::with_capacity(targets.len());
        for &(key, target) in targets {
            let hwnd = HWND(key as *mut c_void);
            let verified = crate::tracker::verify_for_actuation(key);
            // A maximized window must never be repositioned in place — it
            // would stay "maximized" by state while arbitrarily sized. The
            // brain releases maximized windows' tiles, so this only fires on
            // races (maximize between layout computation and apply).
            if verified && unsafe { IsZoomed(hwnd) }.as_bool() {
                log::info!("apply_layout: hwnd {key} is maximized, restoring before move");
                unsafe {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }
            let rects = if verified { window_and_frame_rects(hwnd) } else { None };
            let Some((raw_now, frame_now)) = rects else {
                log::info!(
                    "apply_layout: hwnd {key} is gone or no longer the tracked window, untracking"
                );
                let _ = crate::tracker::untrack(key);
                on_destroyed(key);
                continue;
            };
            // Record the *frame* target: that is what the tracker/drag pump
            // observe via DWMWA_EXTENDED_FRAME_BOUNDS. Recorded before the
            // move so even synchronously-delivered WinEvents are suppressed.
            record_expected(key, target);
            prepared.push(PreparedMove {
                key,
                hwnd,
                raw: compensate_target(&target, &raw_now, &frame_now),
            });
        }
        if prepared.is_empty() {
            return 0;
        }

        if apply_batched(&prepared) {
            return prepared.len();
        }
        log::warn!(
            "apply_layout: DeferWindowPos batch failed, falling back to per-window SetWindowPos"
        );
        apply_individually(&prepared, on_destroyed)
    }

    /// One `BeginDeferWindowPos`/`EndDeferWindowPos` transaction. `false` if
    /// the batch could not be built or committed (nothing moved in that
    /// case: deferred positions only take effect at `EndDeferWindowPos`).
    fn apply_batched(prepared: &[PreparedMove]) -> bool {
        unsafe {
            let mut hdwp: HDWP = match BeginDeferWindowPos(prepared.len() as i32) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("BeginDeferWindowPos failed: {e}");
                    return false;
                }
            };
            for p in prepared {
                match DeferWindowPos(
                    hdwp,
                    p.hwnd,
                    None,
                    p.raw.x,
                    p.raw.y,
                    p.raw.width,
                    p.raw.height,
                    MOVE_FLAGS,
                ) {
                    Ok(next) => hdwp = next,
                    Err(e) => {
                        // Per Win32 docs the HDWP is invalid after a failure;
                        // abandon the whole batch.
                        log::error!("DeferWindowPos failed for hwnd {}: {e}", p.key);
                        return false;
                    }
                }
            }
            match EndDeferWindowPos(hdwp) {
                Ok(()) => true,
                Err(e) => {
                    log::error!("EndDeferWindowPos failed: {e}");
                    false
                }
            }
        }
    }

    /// Fallback path: apply each move on its own so one bad window cannot
    /// starve the rest (spec §6 `SetWindowPos` failure handling).
    fn apply_individually(
        prepared: &[PreparedMove],
        on_destroyed: &mut dyn FnMut(isize),
    ) -> usize {
        let mut applied = 0usize;
        for p in prepared {
            let result = unsafe {
                SetWindowPos(
                    p.hwnd,
                    None,
                    p.raw.x,
                    p.raw.y,
                    p.raw.width,
                    p.raw.height,
                    MOVE_FLAGS,
                )
            };
            match result {
                Ok(()) => applied += 1,
                Err(e) => {
                    if unsafe { IsWindow(Some(p.hwnd)) }.as_bool() {
                        // Alive but unmovable (e.g. became elevated): skip;
                        // the brain keeps the tile and a later sweep resyncs.
                        log::error!("SetWindowPos failed for live hwnd {}: {e}", p.key);
                    } else {
                        log::info!("apply_layout: hwnd {} died mid-apply, untracking", p.key);
                        let _ = crate::tracker::untrack(p.key);
                        on_destroyed(p.key);
                    }
                }
            }
        }
        applied
    }

    /// Bring an (already validated) window to the foreground, restoring it
    /// first if minimized.
    pub(super) fn focus(key: isize) {
        let hwnd = HWND(key as *mut c_void);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                log::info!("focus_window: hwnd {key} is gone");
                return;
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if !SetForegroundWindow(hwnd).as_bool() {
                // Windows denies foreground steals in some focus states;
                // harmless, the window was still restored/raised.
                log::debug!("focus_window: SetForegroundWindow({key}) declined");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pure-fn tests (platform independent)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    // -- rects_match ---------------------------------------------------------

    #[test]
    fn exact_match_within_window_matches() {
        let r = rect(10, 20, 300, 400);
        assert!(rects_match(&r, &r, Duration::ZERO));
        assert!(rects_match(&r, &r, Duration::from_millis(499)));
        assert!(rects_match(&r, &r, Duration::from_millis(500)));
    }

    #[test]
    fn match_expires_after_500ms() {
        let r = rect(10, 20, 300, 400);
        assert!(!rects_match(&r, &r, Duration::from_millis(501)));
        assert!(!rects_match(&r, &r, Duration::from_secs(60)));
    }

    #[test]
    fn two_px_tolerance_on_every_edge() {
        let expected = rect(100, 200, 640, 480);
        // Every field off by the full tolerance in both directions.
        for (dx, dy, dw, dh) in [(2, -2, 2, -2), (-2, 2, -2, 2), (1, 1, 1, 1), (0, 0, 0, 2)] {
            let actual = rect(
                expected.x + dx,
                expected.y + dy,
                expected.width + dw,
                expected.height + dh,
            );
            assert!(
                rects_match(&expected, &actual, Duration::from_millis(100)),
                "should match: {actual:?}"
            );
        }
    }

    #[test]
    fn three_px_off_any_edge_is_a_mismatch() {
        let expected = rect(100, 200, 640, 480);
        for (dx, dy, dw, dh) in [(3, 0, 0, 0), (0, -3, 0, 0), (0, 0, 3, 0), (0, 0, 0, -3)] {
            let actual = rect(
                expected.x + dx,
                expected.y + dy,
                expected.width + dw,
                expected.height + dh,
            );
            assert!(
                !rects_match(&expected, &actual, Duration::from_millis(100)),
                "should not match: {actual:?}"
            );
        }
    }

    // -- compensate_target ----------------------------------------------------

    #[test]
    fn win11_thickframe_insets_are_compensated() {
        // Typical Win11: raw rect extends 7 px past the visible frame on
        // left/right/bottom, 0 on top.
        let raw = rect(93, 100, 814, 614);
        let frame = rect(100, 100, 800, 607);
        let target = rect(0, 0, 960, 516);
        let out = compensate_target(&target, &raw, &frame);
        assert_eq!(out, rect(-7, 0, 974, 523));
    }

    #[test]
    fn zero_insets_pass_target_through() {
        // Borderless window (or DWM query fell back to the raw rect).
        let raw = rect(50, 60, 700, 500);
        let target = rect(160, 220, 480, 344);
        assert_eq!(compensate_target(&target, &raw, &raw), target);
    }

    #[test]
    fn compensation_invariant_frame_lands_on_target() {
        // For any inset geometry: moving the raw rect to the compensated
        // position puts the frame exactly on target (insets are constant
        // across a move).
        let cases = [
            (rect(93, 100, 814, 614), rect(100, 100, 800, 607)),
            (rect(0, 0, 400, 300), rect(0, 0, 400, 300)),
            (rect(-11, -4, 1942, 1057), rect(0, 0, 1920, 1049)),
            (rect(10, 10, 100, 100), rect(8, 6, 105, 110)), // pathological
        ];
        let target = rect(320, 220, 480, 344);
        for (raw, frame) in cases {
            let out = compensate_target(&target, &raw, &frame);
            // Insets: frame = raw + (frame - raw) offsets, sizes likewise.
            let landed_frame = rect(
                out.x + (frame.x - raw.x),
                out.y + (frame.y - raw.y),
                out.width - (raw.width - frame.width),
                out.height - (raw.height - frame.height),
            );
            assert_eq!(landed_frame, target, "raw={raw:?} frame={frame:?}");
        }
    }

    // -- expected-rect ledger ---------------------------------------------------

    // Negative keys: no real HWND is negative, so these never collide with
    // the Windows integration tests that share the process-global map.

    #[test]
    fn recorded_rect_matches_within_tolerance() {
        let key = -201;
        record_expected(key, rect(100, 200, 640, 480));
        assert!(matches_expected(key, &rect(100, 200, 640, 480)));
        assert!(matches_expected(key, &rect(102, 198, 641, 479)));
        assert!(!matches_expected(key, &rect(103, 200, 640, 480)));
    }

    #[test]
    fn unknown_hwnd_never_matches() {
        assert!(!matches_expected(-999, &rect(0, 0, 100, 100)));
    }

    #[test]
    fn re_recording_replaces_the_expected_rect() {
        let key = -202;
        record_expected(key, rect(0, 0, 100, 100));
        record_expected(key, rect(500, 500, 200, 200));
        assert!(!matches_expected(key, &rect(0, 0, 100, 100)));
        assert!(matches_expected(key, &rect(500, 500, 200, 200)));
    }

    // -- validation (no live windows involved) -----------------------------------

    #[test]
    fn apply_skips_malformed_and_untracked_hwnds() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let layout = ApplyLayout {
            moves: vec![
                crate::ipc::Move {
                    hwnd: "not-a-number".into(),
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
                crate::ipc::Move {
                    hwnd: "-31337".into(), // never tracked
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
            ],
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&layout, &mut |k| destroyed.push(k));
        assert_eq!(applied, 0);
        assert!(destroyed.is_empty(), "skipped hwnds are not 'destroyed'");
    }
}

// ---------------------------------------------------------------------------
// Windows integration tests: real CreateWindowExW windows
// ---------------------------------------------------------------------------

#[cfg(all(test, windows))]
mod win_tests {
    use super::*;
    use crate::ipc::Move;
    use crate::test_windows::{frame_bounds, raw_rect, wait_for_frame};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    fn create_test_window() -> HWND {
        crate::test_windows::create_test_window("Griddle actuator test window", 400, 300)
    }

    /// Seed the tracker's live set so the security rule admits the window.
    fn track(hwnd: HWND) -> isize {
        crate::test_windows::track_test_window(hwnd, "Griddle actuator test window")
    }

    fn one_move(key: isize, target: Rect) -> ApplyLayout {
        ApplyLayout {
            moves: vec![Move {
                hwnd: key.to_string(),
                x: target.x,
                y: target.y,
                width: target.width,
                height: target.height,
            }],
        }
    }

    #[test]
    fn apply_layout_moves_tracked_window_frame_onto_target() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = track(hwnd);

        let raw_before = raw_rect(hwnd);
        let frame_before = frame_bounds(hwnd);
        let target = Rect {
            x: 120,
            y: 96,
            width: 512,
            height: 384,
        };

        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));
        assert_eq!(applied, 1);
        assert!(destroyed.is_empty());

        // Raw rect landed exactly on the compensated position...
        let expected_raw = compensate_target(&target, &raw_before, &frame_before);
        assert_eq!(raw_rect(hwnd), expected_raw);
        // ...which puts the visible frame on the target within tolerance.
        let frame_after = wait_for_frame(hwnd, &target);
        assert!(
            rects_match(&target, &frame_after, Duration::ZERO),
            "frame {frame_after:?} != target {target:?}"
        );
        // The move was recorded, so the tracker would suppress it.
        assert!(matches_expected(key, &frame_after));
        assert!(matches_expected(key, &target));

        let _ = crate::tracker::untrack(key);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    /// Plan Task 18: pause short-circuits the actuator entirely.
    #[test]
    fn paused_actuator_moves_nothing_even_for_tracked_windows() {
        // The live-set lock also serializes every test touching the
        // process-global pause flag (see shell.rs tests).
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = track(hwnd);
        let before = raw_rect(hwnd);
        let target = Rect {
            x: 300,
            y: 200,
            width: 480,
            height: 360,
        };

        crate::shell::set_paused_flag(true);
        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));
        crate::shell::set_paused_flag(false);

        assert_eq!(applied, 0, "paused: nothing moves");
        assert!(destroyed.is_empty());
        assert_eq!(raw_rect(hwnd), before, "window must not have moved");
        assert!(
            !matches_expected(key, &target),
            "no expected rect recorded while paused"
        );

        // Resume: the same layout applies normally again.
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));
        assert_eq!(applied, 1, "resume restores actuation");

        let _ = crate::tracker::untrack(key);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn untracked_real_window_is_never_moved() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = hwnd.0 as isize; // deliberately NOT tracked

        let before = raw_rect(hwnd);
        let target = Rect {
            x: 700,
            y: 500,
            width: 320,
            height: 240,
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));
        assert_eq!(applied, 0, "contract C2: unknown hwnds are skipped");
        assert!(destroyed.is_empty());
        assert_eq!(raw_rect(hwnd), before, "window must not have moved");

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn dead_handle_is_untracked_and_reported_destroyed() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = track(hwnd);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };

        let target = Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));
        assert_eq!(applied, 0);
        assert_eq!(destroyed, vec![key], "dead handle reported for emit");
        assert!(
            !crate::tracker::is_tracked(key),
            "dead handle removed from the live set"
        );
    }

    #[test]
    fn batch_moves_multiple_windows_at_once() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let a = create_test_window();
        let b = create_test_window();
        let key_a = track(a);
        let key_b = track(b);

        let target_a = Rect {
            x: 40,
            y: 40,
            width: 480,
            height: 360,
        };
        let target_b = Rect {
            x: 560,
            y: 40,
            width: 480,
            height: 360,
        };
        let layout = ApplyLayout {
            moves: vec![
                Move {
                    hwnd: key_a.to_string(),
                    x: target_a.x,
                    y: target_a.y,
                    width: target_a.width,
                    height: target_a.height,
                },
                Move {
                    hwnd: key_b.to_string(),
                    x: target_b.x,
                    y: target_b.y,
                    width: target_b.width,
                    height: target_b.height,
                },
            ],
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&layout, &mut |k| destroyed.push(k));
        assert_eq!(applied, 2);
        assert!(destroyed.is_empty());

        let frame_a = wait_for_frame(a, &target_a);
        let frame_b = wait_for_frame(b, &target_b);
        assert!(rects_match(&target_a, &frame_a, Duration::ZERO), "{frame_a:?}");
        assert!(rects_match(&target_b, &frame_b, Duration::ZERO), "{frame_b:?}");

        let _ = crate::tracker::untrack(key_a);
        let _ = crate::tracker::untrack(key_b);
        unsafe {
            DestroyWindow(a).expect("DestroyWindow");
            DestroyWindow(b).expect("DestroyWindow");
        }
    }

    #[test]
    fn mixed_batch_moves_live_windows_and_reports_dead_one() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let live = create_test_window();
        let dead = create_test_window();
        let key_live = track(live);
        let key_dead = track(dead);
        unsafe { DestroyWindow(dead).expect("DestroyWindow") };

        let target = Rect {
            x: 200,
            y: 150,
            width: 400,
            height: 300,
        };
        let layout = ApplyLayout {
            moves: vec![
                Move {
                    hwnd: key_dead.to_string(),
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
                Move {
                    hwnd: key_live.to_string(),
                    x: target.x,
                    y: target.y,
                    width: target.width,
                    height: target.height,
                },
            ],
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&layout, &mut |k| destroyed.push(k));
        assert_eq!(applied, 1, "the live window still moves");
        assert_eq!(destroyed, vec![key_dead]);
        let frame = wait_for_frame(live, &target);
        assert!(rects_match(&target, &frame, Duration::ZERO), "{frame:?}");

        let _ = crate::tracker::untrack(key_live);
        unsafe { DestroyWindow(live).expect("DestroyWindow") };
    }

    #[test]
    fn focus_window_rejects_untracked_and_accepts_tracked() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = hwnd.0 as isize;

        // Untracked: the command core is a validated no-op (must not panic).
        focus_validated(&key.to_string());
        focus_validated("garbage");

        // Tracked: exercises the Win32 path; SetForegroundWindow may be
        // declined by the OS in a test session, which the actuator tolerates.
        track(hwnd);
        focus_validated(&key.to_string());
        assert!(
            crate::tracker::is_tracked(key),
            "focusing a genuine tracked window must not untrack it"
        );

        let _ = crate::tracker::untrack(key);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    /// Security review regression ("handle reuse"): a live-set entry whose
    /// tracked identity no longer matches the window behind the handle —
    /// exactly what an HWND recycled to another process looks like — must
    /// not be moved; it takes the dead-handle path (untrack + destroyed).
    #[test]
    fn recycled_handle_with_foreign_identity_is_not_moved() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = hwnd.0 as isize;
        // Track under a *different* exe than the one owning the handle now,
        // simulating: original window died, entry is stale, handle recycled.
        crate::tracker::track_for_test(
            key,
            crate::ipc::WindowInfo {
                hwnd: key.to_string(),
                title: "long-gone window".into(),
                exe: "someoneelse.exe".into(),
                x: 0,
                y: 0,
                width: 400,
                height: 300,
                monitor_id: "m".into(),
                minimized: false,
                resizable: true,
            },
        );

        let before = raw_rect(hwnd);
        let target = Rect {
            x: 500,
            y: 400,
            width: 320,
            height: 240,
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));

        assert_eq!(applied, 0, "identity mismatch: nothing may move");
        assert_eq!(destroyed, vec![key], "reported destroyed like a dead handle");
        assert!(!crate::tracker::is_tracked(key), "stale entry removed");
        assert_eq!(raw_rect(hwnd), before, "the recycled window must not move");

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    /// Security review regression ("handle reuse"): the structural
    /// eligibility bits are re-checked at actuation time too — a handle
    /// recycled to a window the filter would reject (here: a tool window)
    /// is refused even when the owning exe matches.
    #[test]
    fn recycled_handle_now_a_tool_window_is_not_moved() {
        use windows::Win32::UI::WindowsAndMessaging::{
            WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = crate::test_windows::create_styled_test_window(
            "Griddle actuator tool window",
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            WS_EX_TOOLWINDOW,
            400,
            300,
        );
        // track() seeds the real exe, so only the style check can reject.
        let key = track(hwnd);

        let before = raw_rect(hwnd);
        let target = Rect {
            x: 500,
            y: 400,
            width: 320,
            height: 240,
        };
        let mut destroyed = Vec::new();
        let applied = apply_validated(&one_move(key, target), &mut |k| destroyed.push(k));

        assert_eq!(applied, 0, "ineligible style: nothing may move");
        assert_eq!(destroyed, vec![key]);
        assert!(!crate::tracker::is_tracked(key));
        assert_eq!(raw_rect(hwnd), before, "the tool window must not move");

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    /// Same defense on the focus path: a stale identity is never focused.
    #[test]
    fn focus_refuses_a_recycled_handle_and_untracks_it() {
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = create_test_window();
        let key = hwnd.0 as isize;
        crate::tracker::track_for_test(
            key,
            crate::ipc::WindowInfo {
                hwnd: key.to_string(),
                title: "long-gone window".into(),
                exe: "someoneelse.exe".into(),
                x: 0,
                y: 0,
                width: 400,
                height: 300,
                monitor_id: "m".into(),
                minimized: false,
                resizable: true,
            },
        );

        focus_validated(&key.to_string());
        assert!(
            !crate::tracker::is_tracked(key),
            "identity mismatch must untrack the stale entry"
        );

        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }
}
