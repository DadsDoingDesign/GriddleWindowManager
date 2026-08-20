# Griddle Window Manager

**Snap your real Windows 11 windows onto a grid you design yourself.**

[![License: MIT](https://img.shields.io/github/license/DadsDoingDesign/GriddleWindowManager?color=blue)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/DadsDoingDesign/GriddleWindowManager/ci.yml?branch=master&label=CI)](https://github.com/DadsDoingDesign/GriddleWindowManager/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/DadsDoingDesign/GriddleWindowManager?label=release)](https://github.com/DadsDoingDesign/GriddleWindowManager/releases)
[![Platform: Windows 11](https://img.shields.io/badge/platform-Windows%2011-0078d4)](#install)

Windows' built-in snapping gives you halves and quarters. Griddle Window
Manager gives you a grid — say 12 columns by 6 rows — and lets every window
claim whatever rectangle of cells you want, per monitor or spanning several.
Drag a window and a translucent overlay shows exactly where it will land and
which neighbors it will push; release to snap. Save arrangements as templates,
pin apps to their usual spot, and restore your whole desktop at startup.

The grid engine underneath is [Griddle](https://github.com/Trustybits/griddle)
([`@griddle/core`](https://www.npmjs.com/package/@griddle/core) and
[`@griddle/svelte`](https://www.npmjs.com/package/@griddle/svelte)) — a
third-party MIT-licensed layout library by **Trustybits**. Griddle solves the
hard part, deciding where tiles go and which neighbors move; this app teaches
real Windows windows to obey it.

Everything runs locally. There is no telemetry, no analytics, and no account —
your window titles never leave your machine. The one network feature is an
[update check](#license-notices-privacy-and-updates), which is opt-in and off
by default.

<!-- Demo GIF goes here once one is recorded. Drop the file at
     docs/media/demo.gif and replace this comment with:
     ![Dragging a window onto a 12x6 grid](docs/media/demo.gif)
     Suggested capture: 1280x720, under 15 seconds, under 8 MB. -->

*There is no demo recording yet.* Until there is, the [quick start](#quick-start)
below is the fastest way to see what the app actually does — it takes about a
minute.

## Install

**Requirements:** Windows 11, x64. Windows 10 is untested and there is no macOS
or Linux build — the window-tracking half of the app is Win32-specific.

1. Download `Griddle Window Manager_0.2.0_x64-setup.exe` from the
   [releases page](https://github.com/DadsDoingDesign/GriddleWindowManager/releases)
   (or [build it from source](#building-from-source)).
2. Run the installer. It installs **per-user** — no administrator rights needed.
3. Launch **Griddle Window Manager** from the Start menu.

### The SmartScreen warning

The binaries are **not code-signed** — a certificate costs money this project
does not have yet. Windows SmartScreen will show *"Windows protected your PC"*
the first time you run the installer. To proceed: click **More info → Run
anyway**.

That warning means Windows does not recognize the publisher. It is not a
malware verdict, but it is also not nothing: only proceed if you trust where
you got the file. If you would rather not extend that trust to a stranger's
binary, build from source — the whole app is in this repository and the build
is three commands.

## Quick start

The 60-second path from installed to useful:

1. **Pick a monitor.** The first-run page opens automatically. Choose a
   monitor and enable a grid on it. The default is 12 columns × 6 rows, which
   divides cleanly into halves, thirds, quarters and sixths.
2. **Watch everything snap.** Every eligible window on that monitor is swept
   into the grid in one batch. This is the moment where you find out whether
   you like this — nothing is destroyed, and disabling the grid leaves windows
   exactly where they are.
3. **Drag a window.** A translucent overlay fades in showing the grid, the
   cells your window will occupy, and ghost outlines of the neighbors that
   will move out of the way. What the ghosts show is what you get on release.
   Resizing works the same way — edges land on cell boundaries.
4. **Give it some air.** In Settings, nudge **Gap** to 8 px. Every tiled
   window now has a gutter around it, and nothing changes cells.
5. **Save the arrangement.** Once the screen looks right, hit **Capture view**
   in Settings → Views, and set it as your startup view. Your desktop comes
   back this way after a reboot.

Press **Ctrl+Win+G** any time to reopen Settings. If it all goes wrong, hit
**Pause** in the tray menu — every window is instantly yours again.

## Features

**Grids per monitor, or spanning several.** Enable a grid on any monitor and
choose its columns and rows. Or turn on **Span monitors** for one grid across
the combined work area of two or more displays; if that union is L-shaped, the
dead space is excluded and windows snap to the nearest usable cells.

**Three placement modes per grid.** Each grid decides what happens when you
drop a window on cells someone else is using:

- **Reflow** — the dropped window lands *exactly* where you aimed, and the
  other windows reorganise around it, as few of them moving as possible. If no
  arrangement exists (or the search would take too long), the drop quietly
  falls back to Push, so Reflow is never worse than Push.
- **Push** — the dropped window shoves its neighbors aside one shove at a
  time, and equal-size tiles swap. When a neighbor has nowhere to go the drop
  is refused and the window snaps back. This is what earlier versions called
  Tile.
- **Stack** — windows snap to cells but may overlap freely, with the most
  recently touched on top.

Reflow and Push never let windows overlap; Stack does. Non-resizable windows
(fixed-size dialogs) sit outside the arrangement in every mode: they snap to a
cell, and they neither push nor get pushed.

**Reflow is the default for new grids only.** A grid you already had keeps
whatever mode it was on — upgrading changes nothing about how your desktop
behaves. In `config.json` the modes are stored as `reflow`, `push` and
`stack`; a config written by an earlier version stores the first two as
`collision` and `overlay`, which are read as Push and Stack and rewritten
under the new names the next time settings are saved.

**Templates.** A gallery per grid, with built-ins for two columns, three
columns, 2×2 quarters, main + side column, and two rows. Capture the current
arrangement as a named template — slots only, no window identities are stored.
Applying one maps your current windows to its slots by recency and auto-places
the extras. If a template's dimensions differ from the grid's, the button says
so up front: *"Apply (re-grids to 8×6)"*.

**Gap and padding.** **Gap** is the gutter between adjacent windows — two
windows side by side end up exactly that far apart, however many cells each
covers. **Padding** insets the whole grid from the monitor's edges. Both are
0–64 px and default to 0. Changing either re-spaces real windows in one batch
without ever reassigning cells, so nothing jumps somewhere new. On a narrow
grid where a gap would squeeze cells below 16 px it is capped, and the stepper
tells you: `64px → 41px`.

**Per-app defaults.** Right-click any tile in the grid editor to save where new
windows of that program should land — **Save for this grid** or **Save for all
grids** (grid-specific wins). Defaults fire when a *new* window of that program
appears; saving or removing one never disturbs the windows already on screen.
They are listed and deletable in Settings → App defaults.

**Views.** Where a template saves one grid's slots, a view saves your whole
desktop: every enabled grid with its dimensions and spacing, plus which program
sits where. Views store executable names rather than window handles, so they
survive reboots. **Apply now** rebuilds the grids and puts running programs back
on their cells — it never launches anything, but programs that start within the
next two minutes claim their saved spots as they appear. Set one as **Load at
startup** and, with autostart enabled, your desktop reassembles itself after a
reboot even though every window handle is new.

**Tray, hotkey, and pause.** **Ctrl+Win+G** opens Settings (rebindable). The
tray menu carries per-monitor grid toggles, Settings, Quit, and **Pause** — the
panic button, which stops all tracking and window actuation instantly and
survives restarts. **Start with Windows** is offered on the first-run page and
lives in Settings → General.

**Exclusions.** Settings → Excluded apps holds executable names (`slack.exe`)
that the app never manages. Excluding a running app releases its windows in
place; removing the exclusion picks them up again, no restart needed.

Configuration lives in `%APPDATA%\griddle-wm\config.json` — plain local JSON,
written atomically, safe to back up. A v0.1.0 config is upgraded in place on
first run.

### Known limitations

Worth knowing before you install:

- **Spanning grids are the newest and least field-tested feature here.** They
  work in our testing, but they have had the least real-world mileage of
  anything in the app. Please report anything odd.
- **Elevated (admin) windows cannot be managed.** Windows does not let an
  unelevated process move elevated windows, and this app deliberately runs
  unelevated. Those windows are left alone.
- Windows without a normal caption — splash screens, some tool popups — float
  free by design.
- Some apps draw their own frames or override move/size behavior and may not
  land pixel-perfectly on cells.
- No keyboard-driven tiling commands yet. Arrangement is by mouse drag, the
  grid editor, templates and views.
- No virtual-desktop integration; grids apply to whatever desktop is visible.
- The binaries are unsigned (see [above](#the-smartscreen-warning)).

[`docs/deferred.md`](docs/deferred.md) has the full list of known deferrals and
planned follow-ups.

## How it works

The app is a Tauri 2 program split along an unusual line: **TypeScript brain,
Rust hands.**

- **The brain** (`packages/brain`) is pure TypeScript, running in a hidden
  webview. It owns every layout decision and is the single source of truth for
  where windows belong. It imports no Tauri APIs and touches no DOM, which is
  why it can be tested exhaustively — 330 tests, no GUI, no Win32.
- **The hands** (`apps/desktop/src-tauri`) are Rust. They track native windows
  with `SetWinEventHook`, and apply layouts in batched `DeferWindowPos` calls
  so a whole grid moves in one flicker-free pass. Exactly one module,
  `actuator.rs`, is allowed to move a window.
- **The layout math** comes from [`@griddle/core`](https://www.npmjs.com/package/@griddle/core)
  and [`@griddle/svelte`](https://www.npmjs.com/package/@griddle/svelte) — a
  third-party MIT-licensed grid library by Trustybits
  ([Trustybits/griddle](https://github.com/Trustybits/griddle)). This app is a
  consumer of that library, not its author; bugs in grid semantics themselves
  usually belong upstream.

The payoff of that split is that the hard part — reflow rules, collision,
displacement, spacing, view restoration — is ordinary testable TypeScript
rather than logic tangled up in Win32 callbacks. The cost is an IPC contract
that has to be kept honest on both sides.

The full reasoning is in the design spec:
[`docs/superpowers/specs/2026-08-08-griddle-window-manager-design.md`](docs/superpowers/specs/2026-08-08-griddle-window-manager-design.md),
with the v0.2.0 additions in
[`2026-08-09-spacing-rules-views-design.md`](docs/superpowers/specs/2026-08-09-spacing-rules-views-design.md).
A security review of the IPC surface is in
[`docs/security-review.md`](docs/security-review.md).

### How this was built

Griddle Window Manager was built with substantial AI assistance — the design
specs were written collaboratively and most of the implementation was
AI-authored under human direction and review.

This is stated plainly because it is checkable rather than embarrassing: the
design documents that drove the build are in `docs/`, the complete commit
history is in this repository, and the test suites are the real safety net.
Judge the code on the code.

## Building from source

Prerequisites:

- Windows 11
- [Node.js](https://nodejs.org/) ≥ 22 (npm workspaces; no pnpm or yarn)
- [Rust](https://rustup.rs/) stable ≥ 1.81 with the MSVC toolchain
- Visual Studio 2022 Build Tools with the **Desktop development with C++**
  workload
- WebView2 runtime (preinstalled on Windows 11)

```powershell
git clone https://github.com/DadsDoingDesign/GriddleWindowManager.git
cd GriddleWindowManager
npm install

# the three commands CI runs
npm run test -w packages/brain                        # layout brain (vitest)
cd apps/desktop/src-tauri; cargo test; cd ../../..    # Rust shell
npm run build -w apps/desktop                         # webview bundles

# dev build with devtools
npm run tauri:dev

# release build + NSIS installer, without the maintainer's signing key
npm run tauri:build:local
# → apps/desktop/src-tauri/target/release/bundle/nsis/Griddle Window Manager_0.2.0_x64-setup.exe
```

Use the npm scripts rather than calling `tauri` directly:

- `npm run tauri:dev` applies `tauri.dev.conf.json`, which gives the dev build
  its own app identifier and its own `%APPDATA%\griddle-wm-dev\` folder. Without
  it a local build shares the single-instance lock, config file and WebView2
  profile with any copy you have installed, and the two overwrite each other.
- `npm run tauri:build:local` turns off updater artifacts, which otherwise
  require `TAURI_SIGNING_PRIVATE_KEY` — a key only the maintainer holds. Plain
  `npm run tauri:build` is the release path and will fail at the last step
  without it, *after* writing a perfectly good exe and installer.
- Never build the app with a bare `cargo build --release`. Tauri sets
  `dev = !custom_protocol`, and only the Tauri CLI passes that feature, so the
  result silently points at `http://localhost:5173` and shows "can't reach this
  page" in every window.

Repository layout:

```
packages/brain/          pure-TS layout brain (no Tauri/DOM imports; vitest)
apps/desktop/            Svelte 5 + Vite webviews (brain host, overlay, settings)
apps/desktop/src-tauri/  Rust shell: tracker, actuator, monitors, overlays, tray
docs/                    design specs, security review, deferred items
```

The app icon set is generated from `apps/desktop/app-icon.svg` via
`npx tauri icon app-icon.svg`.

## Contributing

Bug reports and pull requests are welcome.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the prerequisites, the three
commands CI runs, and the architecture rules a change has to respect: the brain
stays pure TypeScript, only `actuator.rs` moves windows, and IPC changes land
on both sides of the contract at once.

GUI-affecting changes need a pass through
[`docs/smoke-test-v0.2.0.md`](docs/smoke-test-v0.2.0.md) — the automated suites
cover logic, not pixels.

Participation is under the [Code of Conduct](CODE_OF_CONDUCT.md). Security
issues go through the private channel described in
[`SECURITY.md`](SECURITY.md), never a public issue. Release mechanics are in
[`docs/RELEASING.md`](docs/RELEASING.md).

## License, notices, privacy and updates

**License.** MIT — see [`LICENSE`](LICENSE). Third-party components
redistributed in the installer are listed with their full license texts in
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md). Both files are installed
alongside the app.

**Privacy.** There is no telemetry, no analytics, and no account. The app loads
no remote content — no remote scripts, styles, fonts or images; every asset it
renders ships inside the installer. The only outbound request it can make is the
opt-in update check described below, and its content-security policy restricts
connections to GitHub accordingly. Your configuration — grids, templates,
views, app defaults — stays in `%APPDATA%\griddle-wm\config.json` on your
machine. Nothing about your windows, your applications, or your settings is
ever transmitted anywhere.

**What Griddle records on disk.** Alongside the config, Griddle keeps a plain-text
diagnostic log in `%APPDATA%\griddle-wm\logs\`. It exists so a failure in a
shipped build can be diagnosed at all — earlier releases registered no logger,
which is why a bug that made the app unusable went unexplained for two
versions. The log deliberately never contains a window title, an executable
name, or a path to any of your documents: it records only Griddle's own state —
window handles, monitor device names, its own config path, and error text. It
is capped at three files of 2 MiB, it is never uploaded, and you can delete the
folder at any time. Set `GRIDDLE_DEBUG=1` before launching to raise the log
level and un-hide the internal brain window.

**What Griddle can change on Windows.** One opt-in setting — "Turn off Windows
edge-snap while Griddle runs" (first-run wizard or Settings → General) — makes
Griddle disable Windows' own drag-to-edge snapping and the Snap Layouts flyout,
because they fight the grid over the same drag gesture. It is off by default.
Before changing anything, Griddle records your original values in its config;
it restores them when it quits, and if it crashes first, the next launch (or
turning the toggle off) restores them from that record. `Win+Arrow` snapping is
never touched. Griddle changes nothing else about your system.

**Updates are opt-in and off by default.** With the toggle off, the app makes
no network requests at all; that guarantee is a pure function in the layout
brain with tests pinning it down, not a condition buried in an async driver.
Turn on **Check for updates automatically** in Settings → Updates and it checks
once a day while running. The **Check now** button works regardless of the
toggle — clicking it is the consent.

A check is a single HTTPS GET for this project's public `latest.json` on the
releases page. The URL is fixed: it carries no version, no machine identifier,
and nothing about your configuration. What GitHub can see is what it sees for
anyone fetching a public file — your **IP address**, the time of the request,
and a generic `tauri-plugin-updater/2.10.1` user agent that identifies the
software but not you. Your installed version is compared against the feed
**locally**, on your machine. If you then choose to install an update, the
download request necessarily reveals the platform build you asked for.

Nothing installs on its own: the app tells you a release exists, shows you what
changed, and waits for you. Every download is verified against the project's
signing key before it is allowed to run.
