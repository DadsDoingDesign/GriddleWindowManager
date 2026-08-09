//! Drag-time sampling pump (plan Task 14, spec §5.3).
//!
//! While the user drags/resizes a managed window, Windows runs a modal
//! move-size loop; the tracker translates its start/end WinEvents. This
//! module fills the gap in between: on `MOVESIZESTART` of a tracked hwnd it
//! spawns a sampler thread that reads `GetCursorPos` plus the window's
//! `DWMWA_EXTENDED_FRAME_BOUNDS` rect every [`SAMPLE_INTERVAL`] and emits the
//! contract C2 `drag-pos` event; on `MOVESIZEEND` the thread stops (the final
//! rect travels with the tracker's own `movesize-end` event).
//!
//! Layers:
//!
//! 1. **Pure state machine** — [`PumpState`] + [`sample_decision`]. One drag
//!    is active at a time; each start mints a fresh generation number and the
//!    sampler thread keeps running only while its `(hwnd, generation)` pair
//!    is still the active one. Ending a drag, a `window-destroyed` for the
//!    dragged hwnd, or a newer drag starting all invalidate the pair, so the
//!    thread always observes a stop signal on its next tick — no leaked
//!    threads, including when the window is destroyed mid-drag (the sampler
//!    additionally self-stops the moment `IsWindow` fails). All transitions
//!    are Win32-free and unit-tested.
//! 2. **Suppression** — spec §6 feedback-loop rule: a sampled rect that
//!    matches a rect the actuator just set ([`crate::actuator::matches_expected`])
//!    is self-caused, not user input, and is never emitted as `drag-pos`.
//!    This covers the `movesize-end` → brain commit → actuator snap chain
//!    racing a sampler tick that has not observed the stop signal yet.
//! 3. **Windows wiring** — the tracker's WinEvent handlers call
//!    [`on_move_size_start`] / [`on_move_size_end`] / [`on_window_gone`];
//!    [`init`] hands over the `AppHandle` used to emit.

use crate::actuator::Rect;
use std::time::Duration;

/// Sampling period (~60 Hz per spec §5.3).
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(16);

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

/// The currently active drag, if any. `generation` is unique per drag so a
/// sampler thread from a superseded drag can never mistake a newer drag on
/// the same hwnd for its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveDrag {
    pub hwnd: isize,
    pub generation: u64,
}

/// Pure drag-pump state: which drag is active, and a monotonically increasing
/// generation counter. All methods are side-effect free; the platform layer
/// owns the threading around it.
#[derive(Debug, Default)]
pub struct PumpState {
    active: Option<ActiveDrag>,
    next_generation: u64,
}

impl PumpState {
    /// A drag started on `hwnd`. Any previous drag is implicitly superseded
    /// (its sampler sees `is_current == false` and exits). Returns the
    /// generation the new sampler thread must carry.
    pub fn begin(&mut self, hwnd: isize) -> u64 {
        self.next_generation += 1;
        let generation = self.next_generation;
        self.active = Some(ActiveDrag { hwnd, generation });
        generation
    }

    /// A drag ended on `hwnd`. Returns `true` if this stopped the active
    /// drag; an end for a different hwnd (stale/foreign event) is a no-op.
    pub fn end(&mut self, hwnd: isize) -> bool {
        if self.active.is_some_and(|d| d.hwnd == hwnd) {
            self.active = None;
            true
        } else {
            false
        }
    }

    /// `hwnd` left the managed universe (destroyed/hidden/cloaked). Same
    /// effect as [`end`](Self::end): the sampler must stop, cleanly.
    pub fn window_gone(&mut self, hwnd: isize) -> bool {
        self.end(hwnd)
    }

    /// Is the `(hwnd, generation)` pair a sampler thread carries still the
    /// active drag? Checked every tick; `false` means "exit now".
    pub fn is_current(&self, hwnd: isize, generation: u64) -> bool {
        self.active == Some(ActiveDrag { hwnd, generation })
    }

    /// The active drag, if any.
    pub fn active(&self) -> Option<ActiveDrag> {
        self.active
    }
}

/// What a sampler thread should do with one tick's observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleDecision {
    /// Window is gone: clear the drag state and exit the thread.
    Stop,
    /// Nothing to report this tick (transient rect-query failure, or the
    /// rect is self-caused by the actuator); keep sampling.
    Skip,
    /// Genuine user drag movement: emit `drag-pos`.
    Emit,
}

/// Pure per-tick decision. `alive` is `IsWindow`, `frame` the extended-frame
/// rect (`None` when the query failed), `self_caused` the actuator's
/// [`matches_expected`](crate::actuator::matches_expected) verdict for that
/// rect (`false` when there is no rect to judge).
pub fn sample_decision(alive: bool, frame: Option<Rect>, self_caused: bool) -> SampleDecision {
    if !alive {
        return SampleDecision::Stop;
    }
    match frame {
        None => SampleDecision::Skip,
        Some(_) if self_caused => SampleDecision::Skip,
        Some(_) => SampleDecision::Emit,
    }
}

// ---------------------------------------------------------------------------
// Platform wiring
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub use win::{init, is_dragging, on_move_size_end, on_move_size_start, on_window_gone};

#[cfg(not(windows))]
pub fn init(_app: tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn is_dragging(_hwnd: isize) -> bool {
    false
}

#[cfg(not(windows))]
pub fn on_move_size_start(_hwnd: isize) {}

#[cfg(not(windows))]
pub fn on_move_size_end(_hwnd: isize) {}

#[cfg(not(windows))]
pub fn on_window_gone(_hwnd: isize) {}

#[cfg(windows)]
mod win {
    use super::{sample_decision, PumpState, SampleDecision, SAMPLE_INTERVAL};
    use crate::actuator::{matches_expected, Rect};
    use crate::ipc::{events, DragPos};
    use std::ffi::c_void;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, IsWindow};

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    fn state() -> MutexGuard<'static, PumpState> {
        static STATE: OnceLock<Mutex<PumpState>> = OnceLock::new();
        STATE
            .get_or_init(|| Mutex::new(PumpState::default()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Store the handle the sampler threads emit through. Idempotent.
    pub fn init(app: AppHandle) {
        let _ = APP_HANDLE.set(app);
    }

    /// Tracker hook: `MOVESIZESTART` observed. Only tracked (managed) windows
    /// get a pump; the tracker gates on `is_tracked` before calling, but the
    /// check is repeated here so no other caller can start a rogue pump.
    pub fn on_move_size_start(hwnd: isize) {
        if !crate::tracker::is_tracked(hwnd) {
            return;
        }
        let generation = state().begin(hwnd);
        if let Err(e) = std::thread::Builder::new()
            .name(format!("drag-pump-{hwnd}"))
            .spawn(move || sampler(hwnd, generation))
        {
            log::error!("failed to spawn drag-pump thread for hwnd {hwnd}: {e}");
            state().end(hwnd);
        }
    }

    /// Tracker hook: `MOVESIZEEND` observed. Stops the sampler; the final
    /// rect is carried by the tracker's `movesize-end` event, not by us.
    pub fn on_move_size_end(hwnd: isize) {
        state().end(hwnd);
    }

    /// Is a drag currently active for `hwnd`? The tracker defers
    /// zoom-state transitions while the modal move-size loop runs so the
    /// brain never fights the user's drag.
    pub fn is_dragging(hwnd: isize) -> bool {
        state().active().is_some_and(|d| d.hwnd == hwnd)
    }

    /// Tracker hook: the window left the managed universe mid-drag
    /// (destroyed/hidden/cloaked). Stops the sampler cleanly.
    pub fn on_window_gone(hwnd: isize) {
        if state().window_gone(hwnd) {
            log::info!("drag-pump: hwnd {hwnd} gone mid-drag, sampler stopping");
        }
    }

    /// Sampler thread body: every [`SAMPLE_INTERVAL`], while still the active
    /// drag, observe cursor + frame and emit `drag-pos` for genuine user
    /// movement. Exits when superseded, ended, or the window dies.
    fn sampler(hwnd_key: isize, generation: u64) {
        let hwnd = HWND(hwnd_key as *mut c_void);
        loop {
            std::thread::sleep(SAMPLE_INTERVAL);
            if !state().is_current(hwnd_key, generation) {
                return; // drag ended / superseded / window reported gone
            }
            let alive = unsafe { IsWindow(Some(hwnd)) }.as_bool();
            let frame = frame_rect(hwnd);
            let self_caused = frame
                .as_ref()
                .is_some_and(|r| matches_expected(hwnd_key, r));
            match sample_decision(alive, frame, self_caused) {
                SampleDecision::Stop => {
                    // Destroyed mid-drag before the tracker told us: clear
                    // our own state so nothing dangles, then exit.
                    state().window_gone(hwnd_key);
                    return;
                }
                SampleDecision::Skip => continue,
                SampleDecision::Emit => {
                    let Some(cursor) = cursor_pos() else {
                        continue;
                    };
                    // frame is Some by the Emit contract of sample_decision.
                    let rect = frame.expect("Emit implies a frame rect");
                    emit_drag_pos(hwnd_key, cursor, rect);
                }
            }
        }
    }

    /// Extended frame bounds as an actuator [`Rect`], `None` when DWM and
    /// `GetWindowRect` both decline (e.g. handle just died).
    fn frame_rect(hwnd: HWND) -> Option<Rect> {
        crate::tracker::extended_frame_bounds(hwnd).map(|r| Rect {
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        })
    }

    fn cursor_pos() -> Option<POINT> {
        let mut pt = POINT::default();
        unsafe { GetCursorPos(&mut pt) }.ok().map(|()| pt)
    }

    fn emit_drag_pos(hwnd: isize, cursor: POINT, rect: Rect) {
        // Plan Task 18: pause mid-drag silences the sampler immediately (the
        // thread keeps ticking until movesize-end, but emits nothing).
        if crate::shell::is_paused() {
            return;
        }
        let Some(app) = APP_HANDLE.get() else {
            return;
        };
        let payload = DragPos {
            hwnd: hwnd.to_string(),
            cursor_x: cursor.x,
            cursor_y: cursor.y,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
        if let Err(e) = app.emit(events::DRAG_POS, payload) {
            log::error!("failed to emit {}: {e}", events::DRAG_POS);
        }
    }

    /// Test-only view of the active drag (the win integration tests assert
    /// the sampler cleans up after itself).
    #[cfg(test)]
    pub(crate) fn active_for_test() -> Option<super::ActiveDrag> {
        state().active()
    }

    /// Test-only: serializes tests that touch the process-global pump state.
    #[cfg(test)]
    pub(crate) fn pump_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}

// ---------------------------------------------------------------------------
// Pure state-machine tests (platform independent)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const A: isize = 0x1111;
    const B: isize = 0x2222;

    fn rect() -> Rect {
        Rect {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
        }
    }

    // -- begin / end lifecycle ------------------------------------------------

    #[test]
    fn begin_activates_the_drag_with_a_fresh_generation() {
        let mut s = PumpState::default();
        let g = s.begin(A);
        assert!(s.is_current(A, g));
        assert_eq!(s.active(), Some(ActiveDrag { hwnd: A, generation: g }));
    }

    #[test]
    fn generations_are_unique_per_drag() {
        let mut s = PumpState::default();
        let g1 = s.begin(A);
        assert!(s.end(A));
        let g2 = s.begin(A);
        assert_ne!(g1, g2, "a new drag on the same hwnd is a new generation");
        assert!(!s.is_current(A, g1), "old sampler must stop");
        assert!(s.is_current(A, g2));
    }

    #[test]
    fn end_stops_only_the_matching_hwnd() {
        let mut s = PumpState::default();
        let g = s.begin(A);
        assert!(!s.end(B), "stale end for another hwnd is a no-op");
        assert!(s.is_current(A, g), "drag on A keeps running");
        assert!(s.end(A));
        assert!(!s.is_current(A, g));
        assert_eq!(s.active(), None);
    }

    #[test]
    fn end_without_active_drag_is_a_no_op() {
        let mut s = PumpState::default();
        assert!(!s.end(A));
        assert_eq!(s.active(), None);
    }

    #[test]
    fn new_drag_supersedes_a_still_active_one() {
        // MOVESIZEEND can be lost (e.g. hook installed mid-drag); a fresh
        // MOVESIZESTART must not leak the previous sampler thread.
        let mut s = PumpState::default();
        let g1 = s.begin(A);
        let g2 = s.begin(B);
        assert!(!s.is_current(A, g1), "superseded sampler observes stop");
        assert!(s.is_current(B, g2));
        // The old drag's end arriving late must not kill the new drag.
        assert!(!s.end(A));
        assert!(s.is_current(B, g2));
    }

    #[test]
    fn window_destroyed_mid_drag_stops_the_sampler() {
        let mut s = PumpState::default();
        let g = s.begin(A);
        assert!(s.window_gone(A));
        assert!(!s.is_current(A, g), "sampler exits on next tick");
        assert_eq!(s.active(), None, "no dangling drag state");
    }

    #[test]
    fn foreign_window_destroyed_does_not_stop_the_drag() {
        let mut s = PumpState::default();
        let g = s.begin(A);
        assert!(!s.window_gone(B));
        assert!(s.is_current(A, g));
    }

    // -- sample_decision truth table ------------------------------------------

    #[test]
    fn dead_window_stops_sampling() {
        assert_eq!(sample_decision(false, None, false), SampleDecision::Stop);
        // Even a stale rect + suppression verdict cannot outrank death.
        assert_eq!(
            sample_decision(false, Some(rect()), true),
            SampleDecision::Stop
        );
    }

    #[test]
    fn transient_rect_failure_skips_the_tick() {
        assert_eq!(sample_decision(true, None, false), SampleDecision::Skip);
    }

    #[test]
    fn actuator_caused_rect_is_suppressed() {
        // Spec §6: self-caused location changes never re-enter as user input.
        assert_eq!(
            sample_decision(true, Some(rect()), true),
            SampleDecision::Skip
        );
    }

    #[test]
    fn genuine_user_movement_emits() {
        assert_eq!(
            sample_decision(true, Some(rect()), false),
            SampleDecision::Emit
        );
    }

    // -- suppression end-to-end with the actuator ledger ----------------------

    #[test]
    fn rect_recorded_by_actuator_is_suppressed_and_a_user_rect_is_not() {
        // Negative key: no real HWND is negative, so this never collides with
        // the Windows integration tests sharing the process-global ledger.
        let key = -301;
        let snapped = Rect {
            x: 0,
            y: 0,
            width: 960,
            height: 540,
        };
        crate::actuator::record_expected(key, snapped);

        // The actuator's snap observed by a late sampler tick: suppressed.
        let self_caused = crate::actuator::matches_expected(key, &snapped);
        assert_eq!(
            sample_decision(true, Some(snapped), self_caused),
            SampleDecision::Skip
        );

        // A rect the user dragged to (beyond tolerance): emitted.
        let user = Rect {
            x: 400,
            y: 300,
            width: 960,
            height: 540,
        };
        let self_caused = crate::actuator::matches_expected(key, &user);
        assert_eq!(
            sample_decision(true, Some(user), self_caused),
            SampleDecision::Emit
        );
    }
}

// ---------------------------------------------------------------------------
// Windows integration tests: real windows, real sampler threads
// ---------------------------------------------------------------------------

#[cfg(all(test, windows))]
mod win_tests {
    use super::win::{active_for_test, on_move_size_end, on_move_size_start, pump_test_lock};
    use std::time::{Duration, Instant};
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    /// Poll until the pump has no active drag (the sampler observed its stop
    /// condition), or fail after a generous deadline.
    fn wait_for_idle() {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if active_for_test().is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("drag pump still active: {:?}", active_for_test());
    }

    #[test]
    fn untracked_hwnd_never_starts_a_pump() {
        let _guard = pump_test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _set_guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        on_move_size_start(-777); // negative: cannot be tracked
        assert_eq!(active_for_test(), None);
    }

    #[test]
    fn move_size_end_stops_the_sampler() {
        let _guard = pump_test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _set_guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = crate::test_windows::create_test_window("Griddle drag pump test", 400, 300);
        let key = crate::test_windows::track_test_window(hwnd, "Griddle drag pump test");

        on_move_size_start(key);
        let active = active_for_test().expect("pump active during drag");
        assert_eq!(active.hwnd, key);

        // Let the sampler take at least one tick against the live window.
        std::thread::sleep(Duration::from_millis(50));
        assert!(active_for_test().is_some(), "sampler keeps running mid-drag");

        on_move_size_end(key);
        wait_for_idle();

        let _ = crate::tracker::untrack(key);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
    }

    #[test]
    fn window_destroyed_mid_drag_self_stops_the_sampler() {
        let _guard = pump_test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _set_guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let hwnd = crate::test_windows::create_test_window("Griddle drag pump doomed", 400, 300);
        let key = crate::test_windows::track_test_window(hwnd, "Griddle drag pump doomed");

        on_move_size_start(key);
        assert!(active_for_test().is_some());

        // Destroy the window without any MOVESIZEEND / window-gone call: the
        // sampler must notice IsWindow failing and clean up after itself.
        let _ = crate::tracker::untrack(key);
        unsafe { DestroyWindow(hwnd).expect("DestroyWindow") };
        wait_for_idle();
    }
}
