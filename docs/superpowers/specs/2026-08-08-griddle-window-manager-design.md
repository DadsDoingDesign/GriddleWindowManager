# Griddle Window Manager — Design Spec

**Date:** 2026-08-08
**Status:** Approved architecture (Approach 1); autonomous build authorized
**Product name (working):** Griddle WM

## 1. Vision

A Windows 11 desktop window manager that snaps real application windows (Figma, Slack, browsers — anything) onto a user-configurable grid. The user manipulates how windows fit the grid and how the grid itself is structured: drag a window and a faint grid overlay fades in with a live preview of where it lands and how neighbors reflow; open a live grid editor to restructure the grid (2 columns → 3 columns), capture layouts as reusable templates, and apply grids per-monitor or spanning all monitors.

Dogfoods the user's own `@griddle/*` library: `@griddle/core` (headless layout engine) + `@griddle/svelte` (editor UI).

## 2. Product decisions (locked)

1. **Two layout modes per grid:**
   - **Freeform** — tiles at any cell position/footprint; moves and resizes reflow neighbors; nothing may leave viewport bounds (Griddle's layout invariant enforces this).
   - **Structured templates** — named layouts (columns, rows, splits, custom); creatable by capturing any current freeform arrangement.
2. **Per-grid behavior toggle:**
   - **Collision mode** — tiles never overlap; edits push neighbors (Griddle movement rules 1–6 + `addTileWithDisplacement`).
   - **Overlay mode** — tiles may overlap; most recent edit sits on top; no pushing.
3. **Scope of management:** applying a grid to a monitor makes **every eligible window on that monitor** a managed tile. Minimize removes the tile from the grid; restore re-adds it (placement rules §5.4). Monitors without a grid behave stock-Windows.
4. **Interaction model:**
   - Dragging/resizing a real window on a gridded monitor fades in a faint grid overlay with a **preview** footprint + live neighbor-reflow ghosts; **commit on mouse release** (real windows are repositioned once, in a single batched pass).
   - **Settings** open via global hotkey (default `Ctrl+Win+G`) or tray-icon right-click. Settings contains the **live Griddle editor** per screen, template manager, and toggles.
5. **Multi-monitor:** a grid targets one monitor, or a **spanning grid** covers the combined work area of selected monitors.
6. **Stack:** Tauri 2 (Rust) + Svelte 5 + `@griddle/core` + `@griddle/svelte`. TypeScript brain is the single source of truth; Rust is a thin native adapter.

## 3. Architecture (Approach 1: "TS brain, Rust hands")

```
┌─ Tauri app ────────────────────────────────────────────────────┐
│  Rust core ("hands & eyes")          Brain webview (hidden)     │
│  ├─ window_tracker  (EnumWindows,     ├─ @griddle/core Grid per │
│  │   SetWinEventHook: create/destroy/ │   monitor-grid          │
│  │   minimize/restore/movesize/       ├─ window↔tile map (HWND) │
│  │   foreground/cloak)                ├─ mode + template state  │
│  ├─ window_actuator (SetWindowPos     └─ persistence (JSON)     │
│  │   batched via DeferWindowPos)                                │
│  ├─ monitor_watcher (topology, work   Overlay webviews (per     │
│  │   areas, per-monitor DPI)          gridded monitor):         │
│  ├─ drag_pump (30–60 Hz cursor/rect   transparent, click-       │
│  │   sampling during movesize loop)   through, always-on-top;   │
│  ├─ tray + global hotkey              faint grid + preview +    │
│  └─ webview window factory            reflow ghosts             │
│                                                                 │
│                                       Settings webview:         │
│                                       live Griddle editor,      │
│                                       templates, toggles        │
└────────────────────────────────────────────────────────────────┘
                    Tauri IPC commands + events
```

**Core loop:** native event → IPC → brain computes layout via Griddle → overlay renders preview → on commit, brain emits final layout → Rust applies in one `DeferWindowPos` batch.

**Key invariant:** managed windows are puppets of Griddle state. Only the actuator moves managed windows, and only per the brain's output. A user's native drag is *input to* the brain, not a bypass. The actuator records every rect it sets ("expected rects") so the tracker can distinguish self-caused `EVENT_OBJECT_LOCATIONCHANGE` noise from user actions.

**Windows:** one hidden persistent "brain" window (route `/brain`), one settings window created on demand (route `/settings`), one overlay window per gridded monitor (route `/overlay?monitor=<id>`). All share a single Vite/Svelte build.

## 4. Components

### 4.1 `packages/brain` (pure TypeScript, no Tauri imports)
The testable heart. Exports a `WindowManagerBrain` class:
- Owns `Map<gridId, Grid>` (Griddle instances) + `Map<hwnd, TileRef>`.
- Pure inputs: `windowAppeared/Destroyed/Minimized/Restored`, `dragStarted/dragMoved/dragEnded`, `resizeEnded`, `monitorChanged`, `gridEnabled/Disabled`, `applyTemplate`, `captureTemplate`, `setMode`, `reflowGrid`.
- Pure outputs (returned or emitted): `ApplyLayout { moves: [{hwnd, x, y, w, h}] }`, `PreviewState { gridId, footprint, ghostTiles }`, `StateSnapshot` for UI.
- Coordinate mapping: monitor work-area pixels ⇄ grid cells. `unitWidth = workArea.width / cols`, `unitHeight = workArea.height / rows`. Cell footprints are rounded to nearest cell; min footprint respects a window's `MINMAXINFO` where known.
- **Collision mode** → `addTileWithDisplacement` + movement rules; **overlay mode** → tiles added as Griddle `absolute` tiles (out-of-flow, overlap-exempt), z-order = recency.
- Non-resizable/dialog windows → `absolute` tiles always (they can't fit arbitrary cells).

### 4.2 `src-tauri` (Rust)
- `window_tracker.rs` — `EnumWindows` initial sweep + `SetWinEventHook` (out-of-context) for `EVENT_OBJECT_CREATE/DESTROY`, `EVENT_SYSTEM_MINIMIZESTART/END`, `EVENT_SYSTEM_MOVESIZESTART/END`, `EVENT_OBJECT_CLOAKED/UNCLOAKED`, `EVENT_SYSTEM_FOREGROUND`. Eligibility filter (§5.1). Emits typed IPC events.
- `window_actuator.rs` — applies `ApplyLayout` via `BeginDeferWindowPos`/`DeferWindowPos`/`EndDeferWindowPos`; restores borders correctly (`SetWindowPos` with `SWP_NOACTIVATE | SWP_NOZORDER` unless z-change requested); DPI-aware physical pixels; records expected rects.
- `monitor_watcher.rs` — `EnumDisplayMonitors`, work areas (`SHAppBarMessage`-aware via `MONITORINFO.rcWork`), `WM_DISPLAYCHANGE`/`WM_DPICHANGED` handling; stable monitor IDs (device name + position hash).
- `drag_pump.rs` — during a movesize loop on a managed window, samples cursor + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` at ~60 Hz, emits `drag_pos` events.
- `overlay.rs` — creates per-monitor overlay webview windows: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, topmost, full monitor bounds, excluded from tracker eligibility.
- `shell.rs` — tray icon (menu: per-monitor grid toggles, settings, pause, quit), global hotkey via `tauri-plugin-global-shortcut`, single-instance guard, optional autostart via `tauri-plugin-autostart`.

### 4.3 Frontend (`apps/desktop`, Svelte 5)
- `/brain` — headless page hosting `WindowManagerBrain`; subscribes to Rust events, invokes Rust commands. No visible UI (debug panel behind a flag).
- `/overlay` — canvas-light Svelte page: faint grid lines, preview footprint rect, animated ghost outlines for reflowing neighbors (reads Griddle animation config). Fully pointer-transparent.
- `/settings` — the product UI: monitor picker, **live editor** (`<GriddleGrid>` bound to the real grid state — edits apply to real windows on commit), template manager (capture/name/apply/delete), per-grid toggles (mode, collision/overlay, cols/rows with `reflow({cols, strategy:'griddle-v1'})`), exclusion list, general settings (hotkey, autostart, pause).

### 4.4 Persistence
`%APPDATA%/griddle-wm/config.json` (schema-versioned): grids (per-monitor config + mode + last layout via Griddle `toJSON()`), templates, exclusions, settings. Atomic write (temp + rename). Corrupt file → rename to `.bak`, start fresh, notify via tray balloon.

## 5. Behavior rules

### 5.1 Window eligibility
Managed iff: top-level, visible, not cloaked (DWM cloak check filters UWP ghosts), not `WS_EX_TOOLWINDOW`, not our own windows, has a caption or is app-window styled (`WS_EX_APPWINDOW`), not in user exclusion list (match by exe name), not elevated-beyond-us (see §7). Splash screens/popups without captions float free. Non-resizable eligible windows become `absolute` tiles (§4.1).

### 5.2 Grid application
Enabling a grid on a monitor: sweep eligible windows → brain places them (§5.4 auto-placement) → one batched apply. Disabling: windows stay where they are; tracking stops; layout snapshotted for re-enable.

### 5.3 Drag/resize interaction
1. `MOVESIZESTART` on managed window → overlay fades in (~120 ms), drag pump starts.
2. `drag_pos` → brain computes hovered cell footprint (drag: window's footprint follows cursor; resize: footprint = dragged rect rounded to cells) + neighbor reflow preview (collision mode) → overlay renders.
3. Dragging onto a *different* gridded monitor hands the preview to that grid; onto an ungridded monitor → window unmanages on release.
4. `MOVESIZEEND` → brain commits (`moveTile`/resize + repack), actuator applies batch, overlay fades out. In overlay mode, commit just places the tile on top; no reflow.
5. `Esc` during native drag = Windows' own cancel; tracker sees unchanged rect → no commit.

### 5.4 Placement of new/restored windows
- Restored window: return to its previous tile if those cells are free (collision) or always (overlay); else auto-place.
- New window / auto-place: default footprint = template slot if a template is active and has an empty slot, else nearest-cell rounding of the window's spawn size (min 1×1, capped to grid); position via Griddle first-fit; collision mode uses `addTileWithDisplacement` if no free slot; if the grid genuinely cannot fit it (bounds invariant), the window floats and the tray shows a subtle "grid full" hint.

### 5.5 Templates
Template = `{ name, cols, rows, slots: TileFootprint[] }` (no app bindings in v1). **Capture** from any live grid (`toJSON()` minus window identities). **Apply**: map current windows to slots in recency (z-order) order, extras auto-placed, mode unchanged. Ships with built-ins: 2-col, 3-col, 2×2, main+side, rows.

### 5.6 Grid restructuring
Editor changes to cols/rows call Griddle `reflow({cols, strategy:'griddle-v1'})` so existing tiles adapt; then one batched re-apply to real windows.

### 5.7 Spanning grids
A spanning grid's work area = bounding rect of selected monitors' work areas (v1 requires equal-height row or accepts letterboxed cells; cells falling in dead space between unequal monitors are marked unusable and excluded from placement). Mixed-DPI: all math in physical virtual-desktop pixels; actuator uses per-monitor DPI when sizing.

## 6. Error handling

- **IPC/webview death:** Rust supervises the brain window; if it dies, respawn and rehydrate from last persisted snapshot; managed windows are re-swept (self-healing, never left stranded).
- **`SetWindowPos` failures** (window destroyed mid-apply, access denied): skip that move, emit `window_unmanageable`, brain drops the tile.
- **Event storms:** tracker debounces `LOCATIONCHANGE`; expected-rect matching suppresses feedback loops.
- **Monitor unplugged:** its grid persists in config; windows that lived there follow Windows' own migration, then the destination monitor's grid (if any) adopts them via the normal appeared-flow.
- **Elevated windows:** cannot be moved by a non-elevated process — treated as ineligible with a one-time explanatory notification; optional "restart as admin" setting.
- **Pause switch** (tray): suspends all tracking/actuation instantly (panic button).

## 7. Security posture

- **Zero network access:** no HTTP client, no telemetry, no auto-update in v1; Tauri capability set is minimal (no `shell`, no `fs` beyond app-config dir, no remote content). Strict CSP; overlay/settings load only bundled assets.
- IPC surface: typed commands validated in Rust (hwnd values re-checked against tracker's live set before actuation — the webview can never move arbitrary handles it hasn't been told about).
- Config file is plain local JSON; no secrets stored.
- Runs unelevated by default; elevation is opt-in and explained.
- Installer: Tauri NSIS bundle, per-user install (no admin needed). Unsigned in v1 → README documents the SmartScreen "More info → Run anyway" flow honestly; winget manifest as a fast-follow.

## 8. Testing & quality bar

- **Brain unit tests (vitest):** placement rules, mode behaviors, restore rules, template capture/apply, reflow, coordinate mapping incl. DPI, grid-full behavior. Property/fuzz test: 1,000 random op sequences must preserve Griddle invariants (in-bounds, no overlap in collision mode) and never emit a move outside the work area.
- **Rust unit tests:** eligibility filter truth table, expected-rect matcher, monitor ID stability.
- **Integration smoke:** `cargo tauri build` succeeds; app launches; brain handshake completes; spawn dummy Win32 windows (Rust test helper creates real `CreateWindowExW` windows) → enable grid → assert real rects match brain layout.
- **Stress:** 60 simulated windows, rapid create/destroy/minimize churn, monitor topology flaps, drag-event floods at 120 Hz — no deadlocks, no layout invariant violations, apply latency < 50 ms for 20-window repack.
- **Critique gates (agent panels):** UX critic (Jobs-level bar: the overlay must feel inevitable, settings learnable in one session), CTO review (arch/perf/failure modes), CPO review (scope coherence, install-to-value time), security review (checklist §7).

## 9. Milestones

- **M1 Scaffold + Brain** — repo, Tauri 2 + Svelte 5 + Griddle deps, `packages/brain` complete with full unit suite.
- **M2 Editor→Real windows** — tracker/actuator/monitors in Rust; settings editor drives real windows (no overlay yet).
- **M3 Drag overlay** — movesize pipeline, per-monitor overlays, preview/commit.
- **M4 Modes, templates, spanning** — collision/overlay toggle, template capture/apply, spanning grids.
- **M5 Shell polish** — tray, hotkey, persistence, pause, autostart, exclusions UI.
- **M6 Hardening + ship** — stress/security/UX-CTO-CPO gates, installer, README/install docs.

## 10. Out of scope (v1)

Keyboard-driven tiling commands, per-app template bindings, layout animations of real windows (only overlay ghosts animate), macOS/Linux, auto-update, signed binaries, virtual desktops integration, saving/restoring app sessions.
