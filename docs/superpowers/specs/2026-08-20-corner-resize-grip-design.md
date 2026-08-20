# Corner resize grip — Design Spec

**Date:** 2026-08-20
**Status:** NOT SHIPPED — reverted 2026-08-20. The geometry in this spec is
sound and verified; the *delivery mechanism* (a WebView2 grip window) is not,
and a rebuild should use a native Win32 window. See "Why the first attempt was
reverted" at the end.

## 1. The problem, measured

On the reporter's desktop:

```
DISPLAY1 (primary)  work = (0,0)-(3840,2112)
DISPLAY2            full = (3840,1071)-(5760,2151)
```

A window filling DISPLAY1's grid has its bottom-right corner at `(3840, 2112)`.
Windows' resize border is ~8 px wide, so the grab zone spans x 3832–3840 — and
`y = 2112` falls inside DISPLAY2's vertical span (1071–2151). The pointer
therefore crosses the seam onto DISPLAY2 instead of stopping at the border, and
the corner is effectively unreachable. DISPLAY2's own bottom-right (`x = 5760`)
has nothing beyond it, so the pointer pins and resizing works normally — which
is why the fault looked "main-monitor only".

Generally: **a window corner that lies on a shared monitor edge cannot be
grabbed**, because the pointer keeps travelling into the neighbour.

## 2. Decisions (locked)

1. **Trigger:** any *seam-blocked* bottom-right window corner, not only
   full-grid windows. A corner is seam-blocked when the point just outside it
   lands inside another monitor.
2. **Zone:** the bottom-right 10 % × 10 % of the monitor's work area, anchored
   at the window's corner — on DISPLAY1 that is a 384 × 211 px target.
3. **Grip:** 40 × 40 px.

## 3. Where the logic lives

Entirely in Rust. The tracker already publishes window rects plus a
`resizable` flag, and `MonitorInfo` already carries work areas — so the brain
needs no new state, the config schema does not move, and no new webview→Rust
command is required for detection. This is a deliberate simplification of the
first sketch, which would have had the brain compute corners and push them
over IPC.

New module `apps/desktop/src-tauri/src/grip.rs`, layered like `actuator.rs` and
`snap.rs`: pure, unit-tested geometry + a thin Win32/Tauri edge.

### Pure core (unit-tested, no Win32)

```rust
/// Does another monitor occupy the space just outside this corner?
fn corner_is_seam_blocked(corner: (i32, i32), monitors: &[MonitorInfo], own: &str) -> bool;

/// Is the cursor inside the pull-forward zone for this corner?
/// Zone = `frac` of the monitor work area, anchored at the corner.
fn zone_contains(corner: (i32, i32), mon: &MonitorInfo, cursor: (i32, i32), frac: f64) -> bool;

/// The window (if any) whose seam-blocked corner the cursor is hovering.
fn grip_target(windows: &[WindowInfo], monitors: &[MonitorInfo], cursor: (i32, i32))
    -> Option<GripTarget>;
```

`grip_target` skips windows that are minimized/maximized (`WindowInfo::minimized`
is `IsIconic || WS_MAXIMIZE`) or not `resizable` — a maximized window has no
draggable border to reach anyway.

### Edge

- A watcher thread polls `GetCursorPos` every 80 ms, and **returns immediately
  when fewer than two monitors are present** — a single-monitor session can
  have no seam, so the feature costs nothing there.
- The grip is one Tauri webview window (route `/grip`), created hidden at
  startup and thereafter only moved/shown/hidden. It **must** pass
  `shell::brain_browser_args()` like every other runtime webview, or WebView2
  refuses it (docs/qa-handoff-2026-08-19.md).
- Show/hide/move are issued **only on state change**, never per poll — the same
  cheap-idempotence rule that the snap sync had to learn the hard way.
- The grip is `always_on_top`, `skip_taskbar`, `focusable(false)`
  (`WS_EX_NOACTIVATE`, so clicking it never steals focus) and, unlike the drag
  overlays, **not** click-through: it exists to be clicked.

### Handing off to the native resize

Mouse-down on the grip invokes `begin_corner_resize(hwnd)` (guarded to the grip
window's label only). Rust posts `WM_NCLBUTTONDOWN` with `HTBOTTOMRIGHT` to the
target, which makes the window behave exactly as if the user had grabbed its
bottom-right border: because the physical button is already down, the window's
own modal sizing loop tracks the real mouse and ends on the real mouse-up.

Everything after that is the existing pipeline — `MOVESIZESTART` → drag pump →
overlay preview → grid snap on release. The grip adds an entry point, not a
second resize implementation.

## 4. Failure modes

| Case | Behaviour |
| --- | --- |
| Single monitor | Watcher never starts |
| Paused | Grip hidden (pause means hands off) |
| Elevated target window | `WM_NCLBUTTONDOWN` is refused by UIPI; logged, like the existing `Access is denied` actuator path |
| Window vanishes mid-hover | Next poll finds no target; grip hides |
| Grip's own window | Own-process, so never tracked or managed |

## 5. Testing

- **Unit (Rust):** `corner_is_seam_blocked` against the reporter's real
  two-monitor topology (DISPLAY1 blocked, DISPLAY2 not) plus stacked and
  left-of layouts; `zone_contains` boundaries; `grip_target` skipping
  non-resizable / maximized / minimized windows.
- **Smoke (human):** hover the bottom-right of a full-grid window on the
  primary — grip appears; drag it — window resizes and snaps to the grid;
  same corner on the secondary (unblocked) — no grip.


## Why the first attempt was reverted (2026-08-20)

The detection half worked and was verified on the reporter's machine: the grip
appeared only at seam-blocked corners, and after a fix, sat flush on the live
DWM corner (measured `dx=0 dy=0`). The unit tests covering the geometry all
pass and are worth keeping.

The **hand-off** half never worked, across three attempts:

1. `PostMessage(WM_NCLBUTTONDOWN)` with `lParam = 0` — wrong grab anchor, and
   a queued message arrives after the button is already up, so the window fell
   into click-to-commit sizing instead of a held drag.
2. Added `ReleaseCapture()` + a real cursor `lParam`, switched to
   `SendMessage` on a worker thread. The log reported
   `release_capture=true foreground=true` and the behaviour did not change.
3. That reported success was misleading. `ReleaseCapture` only affects the
   **calling thread's** capture, and the grip is a WebView2 webview: Chromium
   takes the capture inside the *WebView2 process*. Every fix so far was
   operating on the wrong side of a process boundary.

Attempt 3 tried `WM_CANCELMODE` across that boundary, which is the documented
way to make another window drop the mouse — but sending it from the main
thread to another process's windows risks a cross-process `SendMessage`
deadlock, and the build that shipped it left the app in a state where the grip
stopped appearing after one use and the tracker stopped reacting normally. It
was reverted rather than patched a fourth time.

**If this is rebuilt:** make the grip a native Win32 window (`RegisterClassExW`
plus GDI painting; `monitors.rs`'s hidden watcher window is precedent in this
repo). Then Griddle's own thread owns the capture, the canonical
`ReleaseCapture(); SendMessage(target, WM_NCLBUTTONDOWN, HTBOTTOMRIGHT, pos)`
idiom applies as documented, and no cross-process message is needed. Keep §2's
decisions, §3's pure geometry and its tests — only the window implementation
and the hand-off need to change.
