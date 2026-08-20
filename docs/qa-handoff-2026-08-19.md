# QA handoff — v0.2.0 installed build appears dead on DadsDoingDesign's machine

> **RESOLVED 2026-08-19, on the reporter's Windows 11 machine.** Root cause: a
> **WebView2 browser-argument mismatch**. The brain window declares custom
> `additionalBrowserArgs` in `tauri.conf.json` and boots first, pinning the
> shared WebView2 browser process to those arguments; every window built at
> runtime — settings, drag overlays, the brain's own respawn — omitted them,
> so WebView2 refused the environment and `build()` failed *after* the native
> window already existed. Fixed by giving all three runtime builders the
> brain's args, read back out of the parsed config so they cannot drift.
> See "What it actually was" below. The leading hypothesis in this document
> ("two builds fighting") was **wrong** and is marked as ruled out.


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

## ~~Start here — the leading hypothesis: two builds fighting~~ (RULED OUT)

Checked on the reporter's machine and disproved on every point: **zero**
Griddle processes were running before testing began, there is **no** Griddle
entry in `HKCU\...\Run`, and the only other build on disk is a stale
**v0.1.0** debug binary from Aug 9 that was not running. The installed exe is
a genuine v0.2.0 release build and WebView2 151.0.4129.93 is healthy. (Note
also: it installs to `C:\Users\<user>\Griddle Window Manager`, not
`%LOCALAPPDATA%` as assumed below.) The original text is kept for the record.


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


## What it actually was

### The chain, every link observed or read from source

1. The brain window declares custom args in `tauri.conf.json`:
   `--disable-features=…,IntensiveWakeUpThrottling --disable-background-timer-throttling`.
2. Tauri creates config-declared windows **before** running `setup()`
   (`tauri-2.11.5/src/app.rs:2524` vs `:2531`) — code order, not a race — and
   wry's `create_environment` blocks on `wait_with_pump`, so the WebView2
   browser process is definitively up by the time `setup` runs.
3. Confirmed live on the running process, the browser process holds exactly
   the brain's arguments (`--user-data-dir` pointing at
   `dev.griddle.wm\EBWebView`, plus `--disable-background-timer-throttling`
   and the four-item `--disable-features` list).
4. Every runtime-built window omitted those args, so wry fell back to its
   default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
   (hardcoded literal, `wry-0.55.1/src/webview2/mod.rs:294`).
5. WebView2 refuses a second environment on the same user-data folder whose
   arguments differ — `CreateCoreWebView2EnvironmentWithOptions` fails with
   `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)`. `build()` returns `Err` after the
   native window exists, so the frame appears and is destroyed on unwind.

### The observation that caught it

A 50 ms poll of the process's `Tauri Window` class, from t=0 on a cold start:

```
t+  666ms  PID appeared
t+  727ms  'Griddle Window Manager Brain'      vis=False
t+ 1124ms  'Griddle Window Manager Settings'   vis=False   <- created
t+ 1184ms  'Griddle Window Manager Brain'      (settings GONE)
```

Sixty milliseconds of life. On the reporter's first hotkey press this was the
"window frame outline for about a second". Every press afterwards did nothing
because the failed build left the `settings` label registered, so
`open_settings`'s early return no-opped forever — defect #1 below, with a cause.

### Not machine-specific

Every link is build-invariant: the declared args ship in the binary, the window
ordering is Tauri's code order, the wry default is a literal in a version
pinned by `Cargo.lock`, and the WebView2 refusal is documented platform
behaviour. The args were introduced before **v0.1.0**, and no runtime builder
passed them at either tag — so **Settings has been unopenable in every release
this project has published**, for every user, which is exactly why
`docs/smoke-test-v0.2.0.md` still had every P0 box open.

The one genuinely machine-specific symptom was defect #3 (a grid enabled on
DISPLAY2, where the reporter has no windows).

### The fix, and how it was verified

All three `WebviewWindowBuilder::new` call sites — the only three in the
codebase — now apply `shell::brain_browser_args()`, which reads the value back
out of the parsed config so the two can never drift:

| Site | File |
| --- | --- |
| Settings window | `shell.rs` `open_settings` |
| Brain respawn | `shell.rs` `respawn_brain_host` |
| Drag overlays | `overlay.rs` |

`open_settings` additionally now probes the existing window with `is_visible()`
— which round-trips to the real HWND, so a corpse errors instead of returning
`Ok` — and destroys/rebuilds it when it cannot be shown (defect #1).

Verified end to end on a production `tauri build` binary, cold start, no
config: the settings window appears at t+1609 ms, **visible**, persists, and
renders the real first-run monitor picker with both displays listed. Three unit
tests cover the args lookup, including one asserting the shipped
`tauri.conf.json` still declares them so the helper cannot silently become a
no-op.

### Side-finding for contributors

`cargo build --release` on its own produces a binary that loads
`http://localhost:5173` and shows "can't reach this page": tauri's build script
sets `dev = !custom_protocol`, and only the Tauri CLI passes the
`custom-protocol` feature. Use `npm run tauri:build`. Note that command
currently exits non-zero at the very last step without
`TAURI_SIGNING_PRIVATE_KEY`, after the exe and installer are already built.

## Defects worth fixing regardless of the root cause

**1. `open_settings` bricks itself permanently.** *(FIXED — this is what turned a one-off webview failure into a permanent one.)* `shell.rs:314-320` returns
early if a `settings` window already exists, calling only
`unminimize/show/set_focus`. If that window was created in a broken state,
*every* later route in — tray item, hotkey, second launch — silently no-ops
forever, with no error anywhere. It should verify the window is genuinely
visible and destroy/rebuild it if not.

**2. Release builds produce no logs at all.** *(FIXED — `tauri-plugin-log` now registers in every build, writing to `%APPDATA%\griddle-wm\logs\`, capped at 3 files of 2 MiB, plus `GRIDDLE_DEBUG=1` for debug level and a visible brain window. It earned its keep immediately: the first real tiling run surfaced a `DeferWindowPos` failure that had been falling back to per-window `SetWindowPos` silently, and it is what identified the maximized-window case in defect 3 below.)* `lib.rs:51` registers
`tauri-plugin-log` only under `if cfg!(debug_assertions)`, `devtools` is not
in `Cargo.toml` features, and the brain window that renders "Brain failed to
start: {error}" (`Brain.svelte`) is permanently hidden. A shipped build is
undiagnosable by design — this is the single reason the investigation above
had to be conducted by inference from tray checkmarks. Suggest: file logging
to `%APPDATA%\griddle-wm\logs\` in release, plus a `GRIDDLE_DEBUG=1` env var
that un-hides the brain window.

**3. Enabling a grid on a monitor with no windows is a silent no-op.** *(FIXED, and it turned out to have two causes, not one. `enableGrid` skips windows whose `minimized` flag is set — and in the tracker `minimized` is `IsIconic(hwnd) || WS_MAXIMIZE`, so a **maximized** window is equally invisible to it. Enabling a grid on a monitor whose windows are all maximized is therefore just as silent as enabling one on an empty monitor, and on a large primary display that is the far likelier case. The first-run picker now labels each monitor "no windows here yet" / "N windows, all maximized" / "N windows ready to tile", the button hint says which of the two no-ops you are about to hit, and the tray tooltip names enabled grids that hold nothing.)* The
user's enabled grid is on DISPLAY2 with `"tiles": []` while all their
windows live on the 4K primary. `enableGrid` (`brain.ts:855`) sweeps only
windows whose `monitorId` matches, so nothing happens and nothing is said.
This alone may account for "applying to a monitor does nothing".

**4. Nothing namespaces state per build.** *(FIXED — `npm run tauri:dev` applies `tauri.dev.conf.json`, giving a dev build its own identifier (so its own single-instance lock and WebView2 profile) and `%APPDATA%\griddle-wm-dev\`; a dev build also refuses to register autostart rather than pointing the logon entry at `target\debug`. The hotkey still collides by nature — only one process can own a chord — but the loser now says so in the log instead of failing invisibly.)* See the five collision points
above. At minimum the dev build should use a distinct identifier and config
folder so a contributor's local build cannot fight their installed copy.

**5. v0.2.0 shipped with zero human GUI verification.** *(Partly addressed — `smoke-test-v0.2.0.md` gained P0 sections for the dead-on-arrival regression, diagnosability and build isolation. The checks still need a human; one in particular remains genuinely unverified: that the drag overlay becomes **visible** during a real drag. Overlay *creation* is confirmed from the log, and creation is what the browser-args bug broke, but two synthetic-drag approaches failed to move a window at all, so the show path has never been observed.)*
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
