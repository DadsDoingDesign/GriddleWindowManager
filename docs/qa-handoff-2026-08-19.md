# QA handoff — v0.2.0 installed build appears dead on DadsDoingDesign's machine

Written 2026-08-19 by a remote Claude Code session that could only read the
repo (Linux container, no Windows box). Everything below is either *proved
from the code* or *proved by an observation on the user's machine* — the two
are labelled separately. Pick up from "Start here".

## The report

Installed `Griddle Window Manager_0.2.0_x64-setup.exe` from the GitHub
release on Windows 11. The app runs, but:

- the customisation / first-run screen never appears;
- enabling a grid from the tray does nothing visible;
- `Ctrl+Win+G` produced a window *frame outline for about a second* on the
  first press only, then nothing on any later press;
- nothing named "Griddle Window Manager Settings" appears in Alt+Tab.

Machine: two monitors — `\\.\DISPLAY1@0,0` 3840x2160 primary, and
`\\.\DISPLAY2@3840,1071` 1920x1080. Both at 100% scale (derived below), so
this is *not* a mixed-DPI problem.

## Architecture, in one paragraph

The Rust shell (`apps/desktop/src-tauri/`) owns the tray, the global hotkey
and all Win32 window tracking/actuation. All product logic lives in a
**hidden webview** labelled `main` that loads `/brain`
(`tauri.conf.json` `app.windows[0]`, `visible: false`). The tray menu is
built entirely in Rust from `EnumDisplayMonitors`, so **a healthy-looking
tray proves nothing about the brain**. Clicking a monitor item only emits a
`tray-toggle-grid` event to the brain (`shell.rs:557`).

## Established facts — do not re-litigate these

**The Rust shell is healthy.** Tray renders, monitors enumerate with correct
sizes and the primary flag, and *tray Quit actually quits* — which proves
menu events fire and route correctly.

**The brain webview is alive and in sync with disk.** On a fresh launch with
no clicks, `Grid: DISPLAY2` is already ticked. `init_tray` builds every item
*unchecked* (`shell.rs:514` passes an empty enabled-list); the only thing
that can tick one without a click is the `update_tray` command, which is
brain-host-only (`guard.rs:53`). So the webview layer, the production JS
bundle, IPC and config loading all work.

**The engine has worked on this machine before.** The config's remembered
`DISPLAY1` grid is `4x2` — not the 12x6 default and not any built-in
template (all five are 12x6), so a human set it in a Settings UI at some
point. Its stored layout still holds a real tile:
`{"id":"2427576","col":0,"row":0,"w":3,"h":1}`. Tracker, brain and actuator
have all worked end to end at least once.

**Geometry math is correct.** DISPLAY1 grid `unitWidth 960 x 4 cols = 3840`;
`unitHeight 1056 x 2 rows = 2112` (+48px taskbar = 2160). DISPLAY2
`160 x 12 = 1920`; `172 x 6 = 1032` (+48 = 1080). Both consistent with 100%
scaling. No DPI bug here.

**The config is clean.** `version: 3`, no `.bak` quarantine, `paused: false`,
`exclusions: []`, `hotkey: "Ctrl+Super+G"` (matches `shell.rs:43`),
`autostart: false`. `mode: "collision"` is just the pre-v4 on-disk spelling
of Push and is read correctly (`brain.ts setMode`).

## Ruled out

- **WebView2 missing/broken** — config-defined windows are created during
  `Builder::build()`, whose error is `.expect()`ed. A missing runtime would
  panic before the tray ever appeared.
- **Asset route resolution** (`/settings` -> `settings.html`) — the brain
  window resolves `/brain` by the identical mechanism and works.
- **The app tiling its own Settings window** — own-process windows are
  ineligible (`tracker.rs:79` `is_eligible_probe(probe, own_pid, ..)`, test
  at `tracker.rs:1028`).
- **Frontend hiding the window** — nothing in `src/routes/settings/` calls
  `hide()`, `close()` or `minimize()`.
- **Overlay windows covering it** — they are `WS_EX_LAYERED | TRANSPARENT |
  NOACTIVATE | TOOLWINDOW` (`overlay.rs:57`), so they cannot swallow it.
- **Mixed-DPI `.center()` landing off-screen** — both displays are at 100%.

## Start here — the leading hypothesis: two builds fighting

The user keeps a **local build in another folder**. Every build produced
from this repo shares five pieces of global state, none of which is
namespaced by build, version or install location:

1. **Single-instance lock** (`lib.rs:22`) keyed on the app identifier
   `dev.griddle.wm` (`tauri.conf.json:5`), which is identical in every
   build. Only one Griddle process can exist per session. A second launch
   does not start — it calls `open_settings` **on the already-running
   instance** and exits. So the tray you are looking at may belong to the
   *other* build entirely.
2. **`%APPDATA%\griddle-wm\config.json`** (`config.rs:41`) — a hardcoded
   folder name, not per-build or per-version. Both builds read and write the
   same file and stomp each other, with a 500 ms debounced writer on each
   side.
3. **The global hotkey.** Only one process can own `Ctrl+Win+G`. Whoever
   registers first wins; the loser's `register()` failure is *log-only*
   (`shell::apply_hotkey`) and invisible in a release build. Pressing it may
   be opening Settings in the other instance.
4. **Autostart** — `tauri-plugin-autostart` writes an `HKCU\...\Run` entry
   pointing at whichever exe called it (`shell.rs:869 sync_autostart`).
5. **The tray icon** — each running instance adds its own, and one may be
   hidden in the overflow.

A **debug** binary is the worst case: `devUrl` is baked to
`http://localhost:5173` (`tauri.conf.json build.devUrl`), so without Vite
running, every webview it opens fails to load — which is a very good match
for "a window frame appeared for a second and then nothing".

### First commands to run locally

```powershell
# WHICH exe is actually running? Installed path, or your target\ folder?
Get-CimInstance Win32_Process -Filter "Name LIKE '%riddle%'" |
  Select-Object ProcessId, ExecutablePath, CommandLine | Format-List

# Is something auto-launching a dev build at sign-in?
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' | Format-List

# Any leftover local builds?
Get-ChildItem -Recurse -Filter griddle-wm.exe -Path $HOME -EA SilentlyContinue |
  Select-Object FullName, LastWriteTime
```

If `ExecutablePath` is anything under `target\debug` or `target\release`
rather than the per-user install
(`%LOCALAPPDATA%\Griddle Window Manager\`), the theory is confirmed and the
clean-room repro is: kill every Griddle process, clear the Run key, move
`%APPDATA%\griddle-wm\config.json` aside, then launch exactly one build.

## Defects worth fixing regardless of the root cause

**1. `open_settings` bricks itself permanently.** `shell.rs:314-320` returns
early if a `settings` window already exists, calling only
`unminimize/show/set_focus`. If that window was created in a broken state,
*every* later route in — tray item, hotkey, second launch — silently no-ops
forever, with no error anywhere. It should verify the window is genuinely
visible and destroy/rebuild it if not.

**2. Release builds produce no logs at all.** `lib.rs:51` registers
`tauri-plugin-log` only under `if cfg!(debug_assertions)`, `devtools` is not
in `Cargo.toml` features, and the brain window that renders "Brain failed to
start: {error}" (`Brain.svelte`) is permanently hidden. A shipped build is
undiagnosable by design — this is the single reason the investigation above
had to be conducted by inference from tray checkmarks. Suggest: file logging
to `%APPDATA%\griddle-wm\logs\` in release, plus a `GRIDDLE_DEBUG=1` env var
that un-hides the brain window.

**3. Enabling a grid on a monitor with no windows is a silent no-op.** The
user's enabled grid is on DISPLAY2 with `"tiles": []` while all their
windows live on the 4K primary. `enableGrid` (`brain.ts:855`) sweeps only
windows whose `monitorId` matches, so nothing happens and nothing is said.
This alone may account for "applying to a monitor does nothing".

**4. Nothing namespaces state per build.** See the five collision points
above. At minimum the dev build should use a distinct identifier and config
folder so a contributor's local build cannot fight their installed copy.

**5. v0.2.0 shipped with zero human GUI verification.**
`docs/smoke-test-v0.2.0.md` states every P0 box was still open at tag time.
This report is the first real run.

## Pending tests the user had not yet reported

- Config was renamed to `config.old`, so the next launch takes the
  `first_run` path (`lib.rs:75`) and should auto-open the welcome/monitor
  picker. Does a window appear?
- Toggle `Grid: DISPLAY1` (the monitor the windows are actually on) and see
  whether windows snap into 4x2, then re-read the config after ~2s (500 ms
  save debounce) to see whether `layouts[DISPLAY1].tiles` gained entries.
  Enabled-but-no-tiles isolates the tracker; tiles-but-no-movement isolates
  the actuator.

## Key references

| What | Where |
| --- | --- |
| Single-instance plugin | `apps/desktop/src-tauri/src/lib.rs:22` |
| Log plugin, debug-only | `apps/desktop/src-tauri/src/lib.rs:51` |
| First-run detection | `apps/desktop/src-tauri/src/lib.rs:75` |
| `open_settings` early return | `apps/desktop/src-tauri/src/shell.rs:314` |
| Tray menu event routing | `apps/desktop/src-tauri/src/shell.rs:537` |
| Tray built unchecked | `apps/desktop/src-tauri/src/shell.rs:514` |
| Per-window command ACL | `apps/desktop/src-tauri/src/guard.rs:38` |
| Config path | `apps/desktop/src-tauri/src/config.rs:37` |
| Window eligibility | `apps/desktop/src-tauri/src/tracker.rs:79` |
| Tray toggle handler | `apps/desktop/src/routes/brain/host.ts:365` |
| `enableGrid` sweep | `packages/brain/src/brain.ts:855` |
