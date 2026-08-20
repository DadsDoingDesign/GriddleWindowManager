# Which windows Griddle manages — and why some never snap

Written 2026-08-20, after a QA session in which "this window doesn't snap"
turned out to have seven different causes. This is the single reference for
all of them. The authority in code is `is_eligible_probe`
(`apps/desktop/src-tauri/src/tracker.rs`), a pure function with tests.

## Managed

A window is managed when it is **visible**, **top-level**, **not
DWM-cloaked**, **not a tool window**, has a **caption** (or declares
`WS_EX_APPWINDOW`), belongs to a **queryable foreign process** — and, as the
one own-process exception, **Griddle's own Settings window**, identified by
exact hwnd. From the user's side of the screen Settings is a normal window,
so it tiles like one; hiding from your own window manager felt like a bug and
was reported as one.

## Never managed, and why

| Window | Cause | Rationale |
| --- | --- | --- |
| Griddle's overlays / hidden brain | Own process + tool-window / invisible | Infrastructure must not tile itself; the Settings carve-out is keyed to one exact hwnd so these can never ride along |
| Tool windows (palettes, flyouts) | `WS_EX_TOOLWINDOW` | The Windows convention for "not a real window"; they skip the taskbar for the same reason |
| Other virtual desktops / UWP ghosts | DWM-cloaked | Touching windows on another desktop would rearrange a workspace you cannot see |
| Invisible or child windows | `WS_VISIBLE` / `WS_CHILD` | Not user-facing windows |
| Borderless captionless surfaces (games, splashes) | No caption, no `WS_EX_APPWINDOW` | A fullscreen game that gets "tiled" is a destroyed session; opt-in via `WS_EX_APPWINDOW` remains available to apps |
| Excluded apps | The user's exclusion list | Explicit user intent — it also outranks the Settings carve-out |
| Elevated beyond query | Exe unreadable | Windows will not even let Griddle ask; it certainly will not let it move them |

## Managed, but with honest limits

| Situation | Behaviour |
| --- | --- |
| **Elevated but queryable** (e.g. an installer run as admin) | Tracked and tiled, but Windows refuses the actual move (UIPI access-denied). Griddle now says so on the overlay — "Windows will not let Griddle move this window — it runs as administrator" — instead of failing only into the log |
| **Maximized** | Left alone by design (`minimized` in the tracker means `IsIconic \|\| WS_MAXIMIZE`). Dragging one makes Windows restore it, at which point it is placed or floats — and floating windows can be dragged onto a grid (drag intake, spec 2026-08-20) |
| **Full grids** | Placement is refused and the overlay says "No room — this grid is full" |
