# Which windows Griddle manages — and why some never snap

Written 2026-08-20, after a QA session in which "this window doesn't snap"
turned out to have seven different causes. This is the single reference for
all of them. The authority in code is `is_eligible_probe`
(`apps/desktop/src-tauri/src/tracker.rs`), a pure function with tests.

## Managed

A window is managed when it is **visible**, **top-level**, **not
DWM-cloaked**, **not a tool window**, and belongs to a **queryable foreign
process** — plus, as the one own-process exception, **Griddle's own Settings
window**, identified by exact hwnd.

**The Settings window is no longer managed** (spec 2026-08-20). It briefly
was, earlier the same day, because a window manager exempting its own UI felt
like a bug — and it was. It then became a small floating always-on-top minimap
of the displays, at which point tiling it became the wrong answer: a map that
occupies one of the cells it is describing is worse than no map. The
registration point (`shell::note_settings_hwnd`) is kept as a deliberate
no-op so the carve-out is one line away if the window ever becomes an
ordinary page again.

There is deliberately **no caption requirement** (user decision 2026-08-20:
"do not exclude any windows from the grid"). Custom-chrome apps — Electron
frameless windows, game launchers, borderless windows in general — are real
windows to the user, and the old caption gate rejected them silently. If a
borderless window turns out to be something you never want tiled (a game,
say), the exclusion list is the tool for that, per app, by your choice.

## Never managed, and why

| Window | Cause | Rationale |
| --- | --- | --- |
| Griddle's overlays / hidden brain | Own process + tool-window / invisible | Infrastructure must not tile itself; the Settings carve-out is keyed to one exact hwnd so these can never ride along |
| Tool windows (palettes, flyouts) | `WS_EX_TOOLWINDOW` | The Windows convention for "not a real window"; they skip the taskbar for the same reason |
| Other virtual desktops / UWP ghosts | DWM-cloaked | Touching windows on another desktop would rearrange a workspace you cannot see |
| Invisible or child windows | `WS_VISIBLE` / `WS_CHILD` | Not user-facing windows |
| Excluded apps | The user's exclusion list | Explicit user intent — it also outranks the Settings carve-out |
| Elevated ("run as administrator") | `OpenProcessToken` refused | Windows refuses the move (UIPI), and trying took *other* windows down with it — a failed `DeferWindowPos` batch loses every window in it. Detected by the process **token**, not the handle: `PROCESS_QUERY_LIMITED_INFORMATION` is granted across integrity levels by design, so the exe name is readable and cannot stand in for elevation. Conservative on failure — if we cannot tell, the window stays managed |

## Managed, but with honest limits

| Situation | Behaviour |
| --- | --- |
| **Elevated, dragged by the user** | Not tracked at all (see above), so nothing tiles. Dragging one puts the reason on that monitor's overlay — "&lt;exe&gt; runs as administrator — Griddle cannot place its windows" — and clears it after a few seconds. The notice fires only when elevation is the *sole* reason the window was skipped, so cloaked and tool windows stay quiet |
| **Access-denied on a tracked window** | A window that turns unmovable while managed (rare) still reports `window-unmovable`, and the overlay says so on the grid that owns its tile |
| **Maximized** | Left alone by design (`minimized` in the tracker means `IsIconic \|\| WS_MAXIMIZE`). Dragging one makes Windows restore it, at which point it is placed or floats — and floating windows can be dragged onto a grid (drag intake, spec 2026-08-20) |
| **Full grids** | Placement is refused and the overlay says "No room — this grid is full" |
