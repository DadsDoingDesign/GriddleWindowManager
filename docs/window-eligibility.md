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
| Elevated beyond query | Exe unreadable | Windows will not even let Griddle ask; it certainly will not let it move them |

## Managed, but with honest limits

| Situation | Behaviour |
| --- | --- |
| **Elevated but queryable** (e.g. an installer run as admin) | Tracked and tiled, but Windows refuses the actual move (UIPI access-denied). Griddle now says so on the overlay — "Windows will not let Griddle move this window — it runs as administrator" — instead of failing only into the log |
| **Maximized** | Left alone by design (`minimized` in the tracker means `IsIconic \|\| WS_MAXIMIZE`). Dragging one makes Windows restore it, at which point it is placed or floats — and floating windows can be dragged onto a grid (drag intake, spec 2026-08-20) |
| **Full grids** | Placement is refused and the overlay says "No room — this grid is full" |
