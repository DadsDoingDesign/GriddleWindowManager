# Griddle WM

A grid-based window manager for **Windows 11**. Griddle WM snaps real
application windows onto user-configurable per-monitor (or monitor-spanning)
grids, shows a live overlay preview while you drag, and gives you a settings
window with a drag-and-drop grid editor that rearranges your actual desktop.

Under the hood it is a Tauri 2 app with a "TS brain, Rust hands" split: a
hidden webview runs the layout engine ([`@griddle/core`](https://www.npmjs.com/package/@griddle/core))
as the single source of truth, while Rust tracks native windows with
`SetWinEventHook` and applies layouts in batched `DeferWindowPos` calls.
No network access, no telemetry, no cloud — your window titles never leave
your machine. MIT licensed.

## Install

1. Download `Griddle WM_0.1.0_x64-setup.exe` from this repository's
   [releases page](../../releases) (or build it from source, below).
2. Run the installer. It installs **per-user** — no administrator rights needed.
3. Launch **Griddle WM** from the Start menu. A first-run page opens where you
   pick a monitor and enable your first grid (default 12×6).

### About the SmartScreen warning

The v0.1.0 binaries are **not code-signed** (certificates cost money and this
is an early release), so Windows SmartScreen will show *"Windows protected
your PC"* the first time you run the installer. If you choose to proceed:
click **More info → Run anyway**. That warning is Windows telling you the
publisher is unknown — it is not a malware verdict, but you should only
proceed if you trust where you got the file (build it from source if in
doubt; the build is fully reproducible from this repo).

## Usage

### Grids

- Open **Settings** (tray icon → Settings, or press the hotkey) and enable a
  grid on any monitor. Pick the number of **columns and rows**; the monitor's
  work area is divided into that many cells.
- When a grid is enabled, every eligible window on that monitor is swept into
  the grid in one batch. Disabling a grid leaves windows where they are.
- Drag any managed window: a translucent overlay shows the grid, the cell
  footprint where the window will land, and (in Tile mode) ghost
  outlines of neighbors that will be pushed. Release to snap. Resizing works
  the same way — the window snaps to whole cells.
- Dropping a window on a monitor with no grid un-manages it (it stays where
  you dropped it). Dropping it on another gridded monitor transfers it to
  that grid.

### Modes

Each grid runs in one of two modes (segmented control in Settings):

- **Tile** (default): windows are tiles that cannot overlap. Dropping a
  window on an occupied cell pushes neighbors out of the way; equal-size
  tiles swap.
- **Stack**: windows snap to cells but may overlap freely, like a
  loosely-aligned stack. Most recently touched stays on top.

Non-resizable windows (fixed-size dialogs and the like) are always treated as
stack-style tiles and never push neighbors.

### Templates

The settings window has a template gallery per grid:

- **Built-ins**: two columns, three columns, 2×2 quarters, main + side
  column, and two rows.
- **Capture** the current arrangement as a named template (slots only — no
  window identities are stored).
- **Apply** a template: current windows are mapped to its slots by recency
  (most recent window gets the first slot), extras are auto-placed. Applying
  a template with different dimensions re-dimensions the grid.
- User templates can be deleted; built-ins cannot.

### Spanning grids

"Span monitors" in Settings creates one grid across the combined work area of
two or more monitors. If the union is L-shaped, the dead space is excluded:
windows cannot be placed or dropped there and snap to the nearest usable
cells. Enabling a spanning grid replaces the per-monitor grids it covers, and
re-enabling a per-monitor grid tears down a covering span.

Spanning grids are the newest feature in 0.1.0 and have had the least
real-world testing — please report anything odd.

### Hotkey, tray, pause

- **Ctrl+Win+G** opens the settings window (rebindable in Settings →
  General; the rebind field accepts "Win" or "Super" for the Windows key).
- The **tray icon** menu has per-monitor grid toggles (checked = grid
  enabled), **Pause**, **Settings**, and **Quit**.
- **Pause** is the panic button: all tracking and window actuation stop
  instantly, and every window is yours again until you unpause. The pause
  state survives restarts.
- **Start with Windows** (autostart) is a toggle in Settings → General.

### Exclusions

Settings → Excluded apps keeps a list of executable names (e.g. `slack.exe`)
that Griddle WM never manages. Add one by typing the exe name or by picking
from a list of currently open windows. Excluding a running app releases its
windows in place; removing an exclusion manages them again without a restart.

Configuration lives in `%APPDATA%\griddle-wm\config.json` — plain local JSON,
written atomically, safe to back up.

## Limitations (v0.1.0)

- **Elevated (admin) windows cannot be managed.** Windows does not allow a
  non-elevated process to move elevated windows, and Griddle WM deliberately
  runs unelevated. Elevated windows are simply left alone.
- Windows without a normal caption (splash screens, some tool popups) float
  free by design.
- Some apps draw their own window frames or override move/size behavior and
  may not land pixel-perfectly on cells.
- No keyboard-driven tiling commands yet — arrangement is via mouse drags,
  the grid editor, and templates.
- No virtual-desktop integration; grids apply to whatever desktop is visible.
- Binaries are unsigned (see SmartScreen note above); no auto-update — check
  the [releases page](../../releases) for new versions.

See [`docs/deferred.md`](docs/deferred.md) for the full list of known
deferrals and planned follow-ups.

## Build from source

Prerequisites:

- Windows 11
- [Node.js](https://nodejs.org/) ≥ 22 (npm workspaces; no pnpm needed)
- [Rust](https://rustup.rs/) stable ≥ 1.81 with the MSVC toolchain
- WebView2 runtime (preinstalled on Windows 11)

Clone this repository (the clone URL is on this page under **Code**), then
from the checkout root:

```powershell
npm install

# run the test suites
npm run test -w packages/brain          # layout brain (vitest)
cd apps/desktop/src-tauri; cargo test; cd ../../..   # Rust shell

# dev build with devtools
npx tauri dev    # run from apps/desktop

# release build + NSIS installer
cd apps/desktop
npx tauri build
# → src-tauri/target/release/bundle/nsis/Griddle WM_0.1.0_x64-setup.exe
```

The app icon set is generated from the original artwork in
`apps/desktop/app-icon.svg` via `npx tauri icon app-icon.svg`.

## Repository layout

```
packages/brain/          pure-TS layout brain (no Tauri/DOM imports; vitest)
apps/desktop/            Svelte 5 + Vite webviews (brain host, overlay, settings)
apps/desktop/src-tauri/  Rust shell: tracker, actuator, monitors, overlays, tray
docs/                    design spec, plan, security review, deferred items
```

## License & privacy

MIT licensed — see [`LICENSE`](LICENSE). No network access anywhere in the
app: no HTTP client, no telemetry, no remote assets, strict CSP. A security
review of the v0.1.0 IPC surface is in
[`docs/security-review.md`](docs/security-review.md).
