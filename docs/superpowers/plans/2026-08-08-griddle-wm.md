# Griddle Window Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical record.** This plan was written for v0.1.0, when the working product name was "Griddle WM". The product is now **Griddle Window Manager**; task text below that names v0.1.0 build artifacts is left as-shipped rather than retconned. Internal identifiers named here (`dev.griddle.wm`, `%APPDATA%/griddle-wm`, the `griddle-wm` crate and `@griddle-wm/*` packages) are unchanged and still current.

**Goal:** A Windows 11 window manager that snaps real app windows onto user-configurable per-monitor (or spanning) grids, with a drag-time overlay preview and a live Griddle-powered editor.

**Architecture:** "TS brain, Rust hands" — one hidden webview hosts `@griddle/core` grids as the single source of truth; Rust (Tauri 2) tracks native windows via `SetWinEventHook`, applies layouts via batched `DeferWindowPos`, and hosts per-monitor transparent overlay webviews plus a settings window. Real windows are puppets of Griddle state; user drags are inputs to the brain, committed on mouse release.

**Tech Stack:** Tauri 2 (Rust, `windows` crate), Svelte 5 + Vite, `@griddle/core` + `@griddle/svelte`, vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-08-griddle-window-manager-design.md` — read it before any task.

## Global Constraints

- Windows 11, per-monitor DPI v2 awareness; all Rust-side coordinates are physical virtual-desktop pixels.
- `packages/brain` must have **zero** Tauri/DOM imports — pure TS, fully unit-testable.
- Only `window_actuator.rs` may call `SetWindowPos`/`DeferWindowPos` on managed windows.
- No network access anywhere: no fetch, no telemetry, no remote assets; strict CSP in `tauri.conf.json`.
- Node 22 / npm workspaces (no pnpm). Rust stable ≥1.97. Commit after every green task.
- All IPC payloads defined in §Contracts; never invent new event/command names — extend the contract file first.
- Tile id == decimal string of HWND. Grid id == `grid:<monitorId>` or `grid:span:<sorted-monitor-ids-joined-by-+>`.

## Repository Layout

```
package.json                 # npm workspaces: ["packages/*", "apps/desktop"]
packages/brain/              # pure TS layout brain (vitest)
  src/types.ts               # ALL shared TS types (contract §C1)
  src/coords.ts              # px⇄cell mapping
  src/eligibility.ts         # (TS mirror only for tests of brain logic; real filter is Rust)
  src/brain.ts               # WindowManagerBrain
  src/templates.ts           # capture/apply + builtins
  src/persist.ts             # config schema (de)serialization
  test/*.test.ts
apps/desktop/                # Svelte 5 + Vite, three routes
  src/routes: brain/, overlay/, settings/
  src/lib/ipc.ts             # typed wrappers over @tauri-apps/api (contract §C2)
  src-tauri/
    src/main.rs, tracker.rs, actuator.rs, monitors.rs, drag_pump.rs,
    overlay.rs, shell.rs, ipc.rs (serde structs mirroring §C1), config.rs
docs/griddle-api/            # vendored README/movement notes for offline agent reference
```

## Contracts

### C1 — Shared types (`packages/brain/src/types.ts`, mirrored in `src-tauri/src/ipc.rs`)

```ts
export type Hwnd = string;                     // decimal string of HWND
export interface MonitorInfo {
  id: string;                                  // stable: device name + "@" + x + "," + y
  x: number; y: number; width: number; height: number;          // full bounds, physical px
  workX: number; workY: number; workWidth: number; workHeight: number;
  dpi: number; primary: boolean;
}
export interface WindowInfo {
  hwnd: Hwnd; title: string; exe: string;      // exe = lowercase basename, e.g. "slack.exe"
  x: number; y: number; width: number; height: number;          // DWM extended frame bounds
  monitorId: string; minimized: boolean; resizable: boolean;
}
export interface Slot { col: number; row: number; w: number; h: number; }
export interface GridSettings {
  id: string; monitorIds: string[]; cols: number; rows: number;
  mode: 'collision' | 'overlay'; enabled: boolean; activeTemplateId: string | null;
}
export interface Template { id: string; name: string; cols: number; rows: number; slots: Slot[]; builtin: boolean; }
export interface Move { hwnd: Hwnd; x: number; y: number; width: number; height: number; }
export interface ApplyLayout { moves: Move[]; }
export interface GhostMove { hwnd: Hwnd; from: Slot; to: Slot; }
export interface PreviewState {
  gridId: string; visible: boolean;
  footprint: Slot | null;                      // where the dragged window would land
  ghosts: GhostMove[];                         // neighbor reflow preview (collision mode)
}
export interface DragPos { hwnd: Hwnd; cursorX: number; cursorY: number;
  x: number; y: number; width: number; height: number; }        // live rect
export interface AppConfig {                   // schema for %APPDATA%/griddle-wm/config.json
  version: 1;
  grids: GridSettings[]; templates: Template[];
  exclusions: string[];                        // lowercase exe names
  layouts: Record<string, unknown>;            // gridId -> Grid.toJSON() snapshot
  hotkey: string;                              // default "Ctrl+Super+G"
  autostart: boolean; paused: boolean;
}
```

### C2 — IPC contract (`apps/desktop/src/lib/ipc.ts` + `src-tauri/src/ipc.rs`)

Events Rust → webviews (payloads from C1):
`window-appeared {WindowInfo}` · `window-destroyed {hwnd}` · `window-minimized {hwnd}` · `window-restored {WindowInfo}` · `movesize-start {hwnd}` · `drag-pos {DragPos}` · `movesize-end {hwnd, x, y, width, height}` · `monitors-changed {MonitorInfo[]}` · `hotkey-settings {}` · `tray-toggle-grid {monitorId}` · `paused-changed {boolean}`

Events brain → overlays: `preview-state {PreviewState}` (overlays filter by their gridId).
Events brain → settings: `state-snapshot {grids, templates, tiles: Record<gridId, Array<{hwnd, title, exe, slot: Slot}>>, paused}` (emitted on every state change).
Events settings → brain (contract extension, Task 13): `settings-ready {}` (settings window loaded; brain re-emits its last `state-snapshot`) · `settings-move {gridId, hwnd, slot: Slot}` (editor tile drop → `moveTileFromEditor`) · `settings-enable-grid {monitorId, cols, rows}` (→ `enableGrid` with a fresh window sweep) · `settings-disable-grid {gridId}` (→ `disableGrid`) · `settings-set-dims {gridId, cols, rows}` (→ `reflowGrid`).
Events overlay → brain (contract extension, Task 15): `overlay-ready {}` (overlay webview loaded; brain re-emits its last `state-snapshot` — overlays learn their grid's cols/rows/monitorIds from the broadcast `state-snapshot` and their geometry from `list_monitors`).
Events settings → brain (contract extension, Task 16): `settings-set-mode {gridId, mode: 'collision'|'overlay'}` (→ `setMode`) · `settings-capture-template {gridId, name}` (→ `captureTemplate`) · `settings-apply-template {gridId, templateId}` (→ `applyTemplate`) · `settings-delete-template {templateId}` (→ `deleteTemplate`, C3 extension below). All are webview↔webview like the Task 13 events; Rust never handles them, so `ipc.rs` is unchanged.
Events settings → brain (contract extension, Task 17): `settings-enable-span {monitorIds: string[], cols, rows}` (→ `enableGrid` with id `grid:span:<sorted-monitor-ids-joined-by-+>` against a fresh window sweep; the brain tears down any live grid sharing one of those monitors, so a spanning grid replaces the per-monitor grids it covers — and enabling a per-monitor grid likewise tears down a covering span). Disable/dims/mode/templates reuse the existing `settings-*` events with the span grid id. Webview↔webview; Rust never handles it, so `ipc.rs` is unchanged.
Events settings → brain (contract extension, Task 19): `settings-set-exclusions {exclusions: string[]}` (the full exclusion list as edited → `setExclusions`; the brain unmanages windows of newly excluded exes on the spot — tiles removed, **no** moves emitted, the windows stay where they are — and persists the list. The resulting `write_config` keeps the tracker honest: `tracker::set_exclusions` now returns whether the stored list changed, and a change triggers `tracker::resync()` — a fresh desktop sweep whose diff against the old live set is emitted as `window-destroyed` / `window-appeared`, so *removing* an exclusion re-manages its windows without a restart too). Webview↔webview; `ipc.rs` handles no new event. The `state-snapshot` payload gains `exclusions: string[]` (alongside Task 3's `floating`) so the settings exclusions editor always shows the live list. First-run: `lib.rs` setup opens the settings window when no readable config exists; the settings route shows a welcome page (one-paragraph explanation + monitor picker, default 12×6, no external links) while `read_config` is null and no grid is enabled, reusing the existing `settings-enable-grid` event.
Events settings → brain (contract extension, v0.2.0 spacing — spec 2026-08-09 §1): `settings-set-spacing {gridId, gap: number, padding: number}` (the Gap/Padding steppers on a monitor or span card → `setSpacing(gridId, gap, padding)`, a C3 extension: values are clamped to integers in 0..64, cell assignments never change, and the live grid re-applies every tile's pixel rect in one batch — flush diffs desired rects, so one `apply_layout` lands). Webview↔webview; Rust never handles it, so `ipc.rs` gains no event name. The **C1 contract** does change in both mirrors: `GridSettings` gains `gap` and `padding` (physical px, 0..64, default 0 — `gap` separates adjacent cells, `padding` insets the usable area on all four sides). Both fields are optional on the TS side and `#[serde(default)]` on the Rust side, so every v1 config written by v0.1.0 keeps deserializing unchanged (spec §4 migration groundwork; the full v2 schema bump ships with startup views).
Contract extension (v0.2.0 app rules — spec 2026-08-09 §2): the **C1 contract** gains `AppRule {exe: string, gridId: string | null, slot: Slot}` in both mirrors (lowercase exe basename; `gridId: null` = matches any grid; one rule per (exe, gridId), saving again overwrites; the slot is stored unbounded and clamps into the target grid's *current* dims when it fires). `AppConfig` gains `appRules` — optional on the TS side (absent in every v1 config, reads as `[]`) and `#[serde(default)]` on the Rust side, the same migration pattern as `gap`/`padding` (spec §4: the full v2 schema bump ships with startup views) — and the `state-snapshot` payload gains `appRules: AppRule[]` (alongside Task 19's `exclusions`) so the settings rules card always shows the live list. **No new event names in this task:** the tile context-menu / rules-card events ship with the settings-UI task (next paragraph) and are webview↔webview like every `settings-*` event. The **C3 brain API** gains `setAppRule(rule)` (normalize + upsert; never moves already-managed windows — rules are not retroactive) and `removeAppRule(exe, gridId)` (returns whether a rule existed). Placement precedence on `windowAppeared` — and only there (not restores, not enable-grid sweeps): restore-previous tile → grid-specific rule → any-grid rule → active-template first empty slot → auto-place; an occupied rule slot in collision mode displaces (`addTileWithDisplacement` at the rule slot), overlay grids and non-resizable windows take the rule slot as an absolute tile, and a rule/template slot that cannot take the tile falls through to the next precedence level.
Events settings → brain (contract extension, v0.2.0 app-rules UI — the settings-UI events the §2 paragraph above deferred): `settings-set-app-rule {rule: AppRule}` (the editor-tile context menu's two save entries — "on this grid" sends the tile's grid id, "on all grids" sends `gridId: null`, both with the tile's current snapshot slot → `setAppRule`, upsert by (exe, gridId), never moves windows) · `settings-remove-app-rule {exe: string, gridId: string | null}` (the context menu's per-scope remove entries — shown only when a rule exists for that scope — and the App-defaults settings card's delete button → `removeAppRule` for exactly that scope). Webview↔webview like every `settings-*` event; Rust never handles them, so `ipc.rs` is unchanged. The App-defaults card renders straight from the `state-snapshot`'s `appRules` (exe, scope, slot summary), so it always shows the live list.
Events settings → brain (contract extension, v0.2.0 startup views — spec 2026-08-09 §3/§4): `settings-capture-view {name: string}` (the Views card's "Save current as view" → `captureView(name)`, a C3 extension: snapshots every *live* grid's settings — incl. gap/padding — plus each tiled window's exe+slot as `View {id, name, grids: ViewGrid[]}` with `ViewGrid {settings: GridSettings, assignments: Array<{exe, slot}>}`; id `view:<n>`, smallest free n; throws when no grid is live, like `captureTemplate`) · `settings-apply-view {viewId}` (the card's "Apply now" — the **brain host** sweeps `list_windows` and calls `applyView(viewId, windows)`: reconfigures the view's grids via the enableGrid path, registers every assignment as a **pending claim** for `CLAIM_WINDOW_MS` (120 s, exported constant), then re-places the sweep first-come-first-claimed by exe with everything unmatched auto-placed; during the claim window each `windowAppeared` matching an unclaimed exe assignment takes that slot, **beating app rules** — and can pull the window in from an ungridded monitor; after the timeout or all-claimed, normal rules resume; expiry is lazy against the brain's injected clock (`opts.now`, third constructor argument) — no timers) · `settings-rename-view {viewId, name}` (→ `renameView`, trimmed, false/no-snapshot on empty/unknown/no-op) · `settings-delete-view {viewId}` (→ `deleteView`; deleting the startup view resets `startupViewId` to null) · `settings-set-startup-view {viewId: string | null}` (the card's load-at-startup radio → `setStartupView`; unknown ids ignored). All webview↔webview; Rust handles no new event, so `ipc.rs` gains no event name. The **C1 contract** changes in both mirrors: `View`/`ViewGrid`/`ViewAssignment` are added, `StateSnapshot` gains `views: View[]` + `startupViewId: string | null` (the Views card renders straight from the snapshot), and **`AppConfig` bumps to `version: 2`** — `appRules`, `views` and `startupViewId` become first-class fields (spec §4). Loaders migrate v1 → v2 in place (TS `sanitizeConfig` accepts versions 1–2 and emits 2; Rust `config.rs` accepts `MIN_CONFIG_VERSION..=CONFIG_VERSION` via the `#[serde(default)]`s and re-stamps the version); unknown *future* versions still quarantine as `.bak` + fresh start. **Startup path:** the brain host applies `cfg.startupViewId` right after the boot `setMonitors` sweep (works with autostart — the grid settings land immediately and the assignments stay claimable for 120 s, catching apps that launch after us).
Contract clarification (v0.2.0 critique round — **no new event or command names**; `ipc.rs` and the capability files are untouched). Four **C3 semantics** were tightened so the documented behavior matches what ships:
1. `enableGrid`'s placement sweep consults the pending view claims before auto-placing, exactly like `windowAppeared`. That sweep is also the `setMonitors` hotplug-revive path, so a startup view whose grid lives on a late-enumerating monitor (docking station / DP link training — the autostart case spec v0.2 §3 promises) still honours its assignments. Windows the stored layout already restored keep their slot: restore-previous outranks every rule.
2. `setSpacing` and `setMonitors` re-place tiles their recomputed spanning dead-space set stranded (the set is derived from cell *pixel* rects, so gap/padding — and a member monitor's work area — move it). Fallback chain is `reflowGrid`'s: nearest usable slot → first-fit/displacement → floating, most recent first. Single-monitor grids are unaffected: their cell assignments genuinely never change.
3. The constructor normalizes its `AppConfig` the way `setAppRule`/`persist.ts` do — exes trimmed+lowercased, `gridId: ""` rejected (it collides with the any-grid sentinel), `gap`/`padding` clamped when present. The shipped read path is Rust serde straight into the constructor; `sanitizeConfig` only runs in tests, so the brain must hold its own invariants regardless of loader.
4. `setShellPrefs({paused})` freezes the `CLAIM_WINDOW_MS` deadline: pause suppresses the very `window-appeared` events that consume claims, so a pause spanning the window used to eat it whole (persisted pause + startup view at boot). Resuming extends the deadline by the paused span; claims already lapsed when the pause began stay lapsed.

Events settings → brain (contract extension, Task 18): `settings-set-prefs {hotkey?: string, autostart?: boolean}` (settings General card → `setShellPrefs`; the persisted config then drives Rust's hotkey re-registration and autostart registration via `read_config`/`write_config`). Webview↔webview; Rust never handles it. Pause is deliberately *not* in this event: its authority is the `set_paused` command — Rust flips its global flag, emits the existing `paused-changed {boolean}` event, and the brain host mirrors it into the brain via `setShellPrefs({paused})` so it persists and the settings UI updates through `state-snapshot`. The existing `tray-toggle-grid {monitorId}` event is emitted by the tray's per-monitor check items; the brain host owns the toggle (disable the covering grid, else enable `grid:<monitorId>` with remembered dims) and answers with `update_tray`.

Commands (webview → Rust), all `#[tauri::command]`:
`list_windows() -> WindowInfo[]` · `list_monitors() -> MonitorInfo[]` · `apply_layout(layout: ApplyLayout)` · `show_overlay(monitor_id) / hide_overlay(monitor_id)` (contract extension, Task 15: both create the overlay window on demand and re-position it to the monitor's current bounds — `hide_overlay` creates it *hidden*, which the brain host uses to pre-warm overlay webviews at startup/grid-enable so the first drag never waits on WebView2 spin-up) · `read_config() -> AppConfig | null` · `write_config(config: AppConfig)` · `set_paused(paused: bool)` · `focus_window(hwnd)` · `show_settings()` (contract extension, Task 13: create-or-focus the settings window; Task 18's tray/hotkey reuse it) · `update_tray(enabledMonitorIds: string[])` (contract extension, Task 18: the brain host calls it on every `state-snapshot` with the monitors covered by an enabled grid; the tray syncs its per-monitor check items and rebuilds them when the monitor topology changed).

**Pause semantics (Task 18):** `set_paused` flips Rust's authoritative flag; while paused the tracker updates its live eligible set but emits **no** window events (including `drag-pos`), and the actuator drops every `apply_layout` — spec §6 panic button. Config reads seed the flag once at startup; later `read_config` calls never touch it (a stale disk value must not clobber a live pause).

**Security rule (spec §7):** `apply_layout` and `focus_window` must verify every hwnd against the tracker's live eligible set; unknown hwnds are skipped and logged.

### C3 — Brain public API (`packages/brain/src/brain.ts`)

```ts
export interface BrainCallbacks {
  onApply(layout: ApplyLayout): void;
  onPreview(p: PreviewState): void;
  onSnapshot(s: StateSnapshot): void;
}
export class WindowManagerBrain {
  constructor(cb: BrainCallbacks, cfg?: AppConfig);
  // native inputs
  setMonitors(mons: MonitorInfo[]): void;
  windowAppeared(w: WindowInfo): void;
  windowDestroyed(hwnd: Hwnd): void;
  windowMinimized(hwnd: Hwnd): void;
  windowRestored(w: WindowInfo): void;
  moveSizeStart(hwnd: Hwnd): void;
  dragMoved(p: DragPos): void;
  moveSizeEnd(hwnd: Hwnd, rect: {x:number;y:number;width:number;height:number}): void;
  // user/settings inputs
  enableGrid(g: GridSettings, windows: WindowInfo[]): void;
  disableGrid(gridId: string): void;
  setMode(gridId: string, mode: 'collision'|'overlay'): void;
  reflowGrid(gridId: string, cols: number, rows: number): void;
  captureTemplate(gridId: string, name: string): Template;
  applyTemplate(gridId: string, templateId: string): void;
  moveTileFromEditor(gridId: string, hwnd: Hwnd, slot: Slot): void;
  deleteTemplate(templateId: string): boolean;  // contract extension, Task 16: false for builtin/unknown ids; never emits moves
  slotUsable(gridId: string, slot: Slot): boolean; // contract extension, Task 17: dead-space check for spanning grids (false for unknown/disabled grids); placement, snap, and preview all route through the same test
  setShellPrefs(prefs: { paused?: boolean; autostart?: boolean; hotkey?: string }): void; // contract extension, Task 18: mirrors Rust's paused-changed + the settings General card into the config; re-emits the snapshot only on actual change; empty hotkey ignored
  setExclusions(exes: string[]): void; // contract extension, Task 19: normalized (trim/lowercase/dedupe) replace of the exclusion list; newly excluded windows unmanage in place (tiles removed, no moves emitted); removals re-manage via the tracker resync's window-appeared; unchanged list = no-op
  setAppRule(rule: AppRule): void; // contract extension, spec v0.2 §2: upsert by (exe, gridId); exe trim+lowercased; invalid input or an identical rule = silent no-op; never moves windows
  removeAppRule(exe: string, gridId: string | null): boolean; // contract extension, spec v0.2 §2: remove exactly that scope; false (and no snapshot) on a miss
  exportConfig(): AppConfig;
}
```

Internals: one `Grid` from `@griddle/core` per enabled grid (unitWidth = workWidth/cols, unitHeight = workHeight/rows). Collision mode → in-flow tiles + `addTileWithDisplacement`; overlay mode → `absolute` tiles, z = recency. Non-resizable windows are always `absolute`.

---

## Milestone 1 — Scaffold + Brain

### Task 1: Repo scaffold
**Files:** Create `package.json` (workspaces), `packages/brain/{package.json,tsconfig.json,vitest.config.ts}`, `apps/desktop` via `npm create vite@latest` (svelte-ts), `.gitignore` (node_modules, dist, target, *.local), vendor the two READMEs + movement notes into `docs/griddle-api/`.
**Steps:** scaffold → `npm install` → `npm i @griddle/core` in brain, `npm i @griddle/core @griddle/svelte` in desktop → `npm run build -w apps/desktop` passes → `npx vitest run -w packages/brain` passes (empty suite ok) → commit `chore: scaffold workspaces`.

### Task 2: types.ts + coords.ts (TDD)
**Files:** `packages/brain/src/{types.ts,coords.ts}`, `test/coords.test.ts`.
**Interfaces produced:** C1 types verbatim; `cellRect(mon: MonitorInfo, grid: {cols,rows}, slot: Slot) -> {x,y,width,height}` (physical px, work-area-relative→virtual-desktop absolute); `snapRectToSlot(mon, grid, rect) -> Slot` (nearest-cell rounding, clamped in bounds, min 1×1); `slotFromCursor(mon, grid, cursorX, cursorY, footprint: {w,h}) -> Slot` (footprint centered on cursor, clamped).
**Test cases (write first, must fail, then implement):** 1920×1032 work area at (0,48), 12×6 grid → unit 160×172; `cellRect` of {col:2,row:1,w:3,h:2} = {x:320,y:220,width:480,height:344}; `snapRectToSlot` of {x:250,y:100,width:500,height:400} = {col:2,row:0,w:3,h:2}; rect hanging past right edge clamps to `col+w<=cols`; cursor at monitor corner keeps footprint fully in bounds. Non-integer division: 2560/12 → cellRect widths must sum to ≤ workWidth (use floor-accumulate, give the last column the remainder). Commit `feat(brain): coordinate mapping`.

### Task 3: WindowManagerBrain core lifecycle (TDD)
**Files:** `packages/brain/src/brain.ts`, `test/brain-lifecycle.test.ts`.
**Behavior under test (collision mode, one 12×6 grid, fake monitor from Task 2):**
- `enableGrid` with 3 windows → `onApply` called once with 3 moves, all inside work area, non-overlapping cells.
- `windowAppeared` after enable → placed first-fit into free cells; if none free, `addTileWithDisplacement` result applied; if grid full (bounds error thrown by Griddle) → **no** apply for that hwnd, snapshot marks it floating.
- `windowMinimized` → tile removed, no moves emitted for others (no auto-compact); `windowRestored` → previous slot if free else auto-place.
- `windowDestroyed` → tile removed. `disableGrid` → grid dropped, no moves.
- Every `onApply` ever emitted: assert all rects within the monitor work area (spec bounds invariant).
Commit `feat(brain): lifecycle + placement`.

### Task 4: Drag pipeline in brain (TDD)
**Files:** `packages/brain/src/brain.ts` (extend), `test/brain-drag.test.ts`.
**Behavior:** `moveSizeStart` on managed hwnd → `onPreview({visible:true, footprint: current slot, ghosts: []})`. `dragMoved` → footprint follows `slotFromCursor`; in collision mode ghosts = tiles whose slot would change under a **simulated** move (clone grid via `toJSON/loadJSON`, run `moveTile`, diff slots) — the real grid is untouched during drag. `moveSizeEnd` → real `moveTile` + one `onApply` containing the dragged window and every displaced neighbor; preview hidden. Resize path: `moveSizeEnd` rect differing in size → `snapRectToSlot` → tile resized (`updateTile`/remove+re-add with displacement), neighbors reflow. Drop on ungridded monitor rect → tile removed, snapshot shows unmanaged, no move emitted (window stays where the user dropped it). Drop on a *different* gridded monitor → tile transfers grids. Commit `feat(brain): drag preview + commit`.

### Task 5: Overlay mode + toggle (TDD)
**Files:** `brain.ts` (extend), `test/brain-overlay-mode.test.ts`.
**Behavior:** overlay-mode grid stores tiles as Griddle `absolute` tiles; `dragMoved` ghosts always `[]`; `moveSizeEnd` emits exactly one move (the dragged window, snapped to cells, may overlap others); recency order tracked so `state-snapshot` lists top-most last. `setMode('collision')` on an overlay grid re-adds all tiles in recency order with displacement (most recent keeps its slot preferentially) and emits one apply; `setMode('overlay')` converts in place, no moves. Non-resizable window in a collision grid stays `absolute` and never appears in ghosts. Commit `feat(brain): overlay mode`.

### Task 6: Templates (TDD)
**Files:** `packages/brain/src/templates.ts`, `brain.ts` (extend), `test/templates.test.ts`.
**Interfaces produced:** `builtinTemplates(): Template[]` — ids `tpl:2col`, `tpl:3col`, `tpl:2x2`, `tpl:main-side` (8×6: main {0,0,5,6} + side {5,0,3,6}), `tpl:rows2`.
**Behavior:** `captureTemplate` snapshots cols/rows + sorted slots (reading order), no hwnds. `applyTemplate` maps windows to slots by recency (most recent → first slot), extras auto-placed, then one apply; template with different cols/rows → grid `reflow` first. Commit `feat(brain): templates`.

### Task 7: Persistence + fuzz gate (TDD)
**Files:** `packages/brain/src/persist.ts`, `test/{persist,fuzz}.test.ts`.
**Behavior:** `exportConfig()`/constructor round-trip: grids, templates, exclusions, `layouts[gridId] = grid.toJSON()`; corrupt/missing `layouts` entry → grid starts empty (no throw). **Fuzz:** seeded PRNG, 1,000 random ops (appear/destroy/min/restore/drag/setMode/reflow/applyTemplate) across 2 monitors; after every op assert: all emitted rects in-bounds; collision grids have no overlapping in-flow tiles (walk `grid.toJSON()`); no crash. Any failure prints the seed. Commit `feat(brain): persistence + fuzz suite`. **Milestone gate:** full vitest suite green.

---

## Milestone 2 — Rust hands + editor drives real windows

### Task 8: Tauri app shell + ipc.rs
**Files:** `apps/desktop/src-tauri/` via `npm i -D @tauri-apps/cli && npx tauri init`; `src/ipc.rs` (serde mirror of C1, `#[serde(rename_all="camelCase")]`), `src/main.rs` registering empty command stubs from C2; `tauri.conf.json`: hidden main window at route `/brain` (`visible:false`), CSP `default-src 'self'`, `windows` crate dep with features `Win32_Foundation,Win32_UI_WindowsAndMessaging,Win32_UI_Accessibility,Win32_Graphics_Dwm,Win32_Graphics_Gdi,Win32_UI_HiDpi,Win32_System_Threading,Win32_UI_Shell,Win32_System_ProcessStatus`.
**Verify:** `npx tauri build --debug` produces a runnable exe; `cargo test` (empty) passes. Commit.

### Task 9: monitors.rs (TDD where pure)
**Files:** `src/monitors.rs`, tests in-module.
**Produces:** `fn enumerate() -> Vec<MonitorInfo>` (EnumDisplayMonitors + GetMonitorInfoW + GetDpiForMonitor); stable id per C1; listens for `WM_DISPLAYCHANGE` on a hidden message window → emits `monitors-changed`. Pure-testable: `fn monitor_id(device: &str, x: i32, y: i32) -> String`. `list_monitors` command wired. Commit.

### Task 10: tracker.rs — eligibility + events
**Files:** `src/tracker.rs`, unit tests for the filter truth table.
**Produces:** `fn is_eligible(hwnd) -> bool` implementing spec §5.1 (visible, top-level, not cloaked via `DwmGetWindowAttribute(DWMWA_CLOAKED)`, no `WS_EX_TOOLWINDOW`, has caption or `WS_EX_APPWINDOW`, not our pid, exe not in exclusions); `fn snapshot() -> Vec<WindowInfo>` (EnumWindows + `DWMWA_EXTENDED_FRAME_BOUNDS` + `QueryFullProcessImageNameW` + `GetWindowThreadProcessId` + resizable = `WS_THICKFRAME`); `SetWinEventHook` (WINEVENT_OUTOFCONTEXT) for CREATE/DESTROY/MINIMIZESTART/MINIMIZEEND/MOVESIZESTART/MOVESIZEEND/CLOAKED/UNCLOAKED emitting C2 events; maintains live eligible set behind `Mutex<HashMap<isize, WindowInfo>>` for the C2 security rule. Filter truth table tested with synthetic style bitmasks (factor the style logic into a pure fn taking `(style, exstyle, cloaked, has_owner, pid)`). Commit.

### Task 11: actuator.rs
**Files:** `src/actuator.rs` + pure-fn tests.
**Produces:** `apply_layout` command: validate hwnds against tracker set → `BeginDeferWindowPos(n)` → per move `DeferWindowPos(SWP_NOACTIVATE|SWP_NOZORDER)` → `EndDeferWindowPos`; failed handle → skip + `window-destroyed` emit; record expected rects in `Mutex<HashMap<isize,(RECT,Instant)>>`; `fn matches_expected(hwnd, rect) -> bool` (±2px tolerance, 500 ms window — pure, tested). Frame compensation: `DWMWA_EXTENDED_FRAME_BOUNDS` vs `GetWindowRect` delta applied so the *visible* frame lands on the cell (test the delta math as pure fn). Commit.

### Task 12: brain page + ipc.ts + end-to-end apply
**Files:** `apps/desktop/src/lib/ipc.ts` (typed `listen`/`invoke` wrappers for every C2 name), `src/routes/brain` page instantiating `WindowManagerBrain` wired: events→brain methods, `onApply`→`apply_layout`, `onSnapshot`→emit `state-snapshot`, `onPreview`→emit `preview-state`; config load/save via `read_config`/`write_config` (config.rs: atomic temp+rename in `%APPDATA%/griddle-wm/`, corrupt→`.bak`).
**Verify (manual-ish smoke via dev build):** launch `npx tauri dev`; from devtools of brain window run a scripted `enableGrid` against two Notepad windows → real windows snap. Also add Rust integration test helper `tests/spawn_windows.rs` exposing `create_test_window(title, w, h) -> HWND` via `CreateWindowExW` for later automated tests. Commit.

### Task 13: settings window + minimal editor
**Files:** `src/routes/settings` (monitor list from `list_monitors`, per-monitor enable toggle, cols/rows steppers, `<GriddleGrid {api}>` bound to `state-snapshot` tiles, window titles on tiles); `shell.rs` additions: `show_settings()` creating the window on demand.
**Behavior:** editor drag of a tile → `moveTileFromEditor` → real window moves on drop (listen to Griddle's tile-move callback, send slot to brain via a `settings-move {gridId, hwnd, slot}` event routed to brain page). Enable/disable/cols/rows changes call brain methods and persist. **Gate:** manually arranging Notepad + Explorer from the editor works. Commit.

---

## Milestone 3 — Drag overlay

### Task 14: drag_pump.rs
**Files:** `src/drag_pump.rs`. On `MOVESIZESTART` of managed hwnd: spawn thread sampling `GetCursorPos` + extended-frame rect every 16 ms, emit `drag-pos`; stop on `MOVESIZEEND` (emit final rect with the event). Suppression: tracker must *not* re-emit `movesize-end`-triggered LOCATIONCHANGE as user action (use actuator's `matches_expected`). Commit.

### Task 15: overlay.rs + overlay route
**Files:** `src/overlay.rs` (create per-gridded-monitor overlay: full monitor bounds, `transparent:true, decorations:false, alwaysOnTop:true, skipTaskbar:true, focusable:false`; post-create `SetWindowLongPtrW` add `WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`), `show_overlay`/`hide_overlay` commands; `src/routes/overlay`: reads `?gridId=`, renders faint grid lines (1px, 12% opacity accent), preview footprint (filled 25% accent, 2px border, 120 ms fade), ghost outlines animating from→to with Griddle's default easing. Overlay windows excluded from tracker eligibility (own pid). **Gate:** dragging a managed window shows grid + preview + ghosts; release snaps window and neighbors; overlay fades out. Commit.

---

## Milestone 4 — Modes, templates UI, spanning

### Task 16: Mode toggle + templates UI in settings
**Files:** settings route additions: per-grid mode segmented control (wire `setMode`), template gallery (built-ins + user's; capture button prompts name; apply button; delete for non-builtin), all persisting. Commit.

### Task 17: Spanning grids
**Files:** `brain.ts` (grid over union work area; dead-space cells computed from monitor rects and excluded from placement — `Slot` validity check `slotUsable(slot)` consulted by placement/snap; tests: L-shaped 2-monitor union, window placed into dead zone snaps to nearest usable slot), settings UI: "span monitors" multi-select creating `grid:span:*`, disabling per-monitor grids on those monitors. Commit.

---

## Milestone 5 — Shell polish

### Task 18: Tray, hotkey, pause, single-instance, autostart
**Files:** `shell.rs`: tray icon + menu (per-monitor grid toggles ticking live state, Pause, Settings, Quit), `tauri-plugin-global-shortcut` (default `Ctrl+Super+G` → settings, rebindable from config), `tauri-plugin-single-instance`, `tauri-plugin-autostart` wired to settings toggle, `set_paused` short-circuits tracker emission + actuator. Commit.

### Task 19: Exclusions UI + first-run experience
**Files:** settings: exclusions editor (add by exe name or "pick a window" listing current windows); first-run page shown when no config exists: one-paragraph explanation, monitor picker with "Enable grid", default 12×6, links nothing external. Commit.

---

## Milestone 6 — Hardening + ship

### Task 20: Stress + resilience tests
**Files:** `packages/brain/test/stress.test.ts` (60 windows, churn script per spec §8, apply-latency budget assertion <50 ms for 20-window repack measured in vitest), Rust `tests/integration.rs` using `create_test_window` helper: spawn 10 real windows, enable grid, assert rects match brain layout within ±2px; kill brain window (`webview.close()`) → respawn+rehydrate leaves windows managed. Commit.

### Task 21: Security review pass
Checklist from spec §7 executed against the code: capability file minimal, CSP strict, hwnd validation present (write a Rust test calling `apply_layout` with a foreign hwnd → skipped), no `shell`/`fs` plugin exposure beyond config dir, no network calls (`grep` for fetch/http/reqwest). Fix all findings. Commit.

### Task 22: Critique gates (UX / CTO / CPO)
Run agent critique panels against the built app + screenshots + README draft; every finding triaged: fix, defer (documented in `docs/deferred.md`), or reject with reason. Iterate until panels return no blocking findings. Commit per fix batch.

### Task 23: Installer + docs
**Files:** `tauri.conf.json` bundle config (NSIS, per-user, productName "Griddle WM", icon set generated via `npx tauri icon`), `README.md` (what it is, GIF placeholder section, install steps incl. SmartScreen note, usage guide, limitations incl. elevated windows, build-from-source), `docs/deferred.md`. `npx tauri build` produces `Griddle WM_0.1.0_x64-setup.exe`; install + launch smoke test. Commit + tag `v0.1.0`.

---

## Self-Review Notes

- Spec coverage: §2 modes→Tasks 5/16; §5.1→10; §5.3→4/14/15; §5.4→3; §5.5→6/16; §5.6→13; §5.7→17; §6→11/12/20; §7→8/21/23; §8→7/20/21/22; §9 milestones map 1:1.
- Type names are defined once in C1 and referenced verbatim in all tasks.
- Known risk logged for executors: Griddle `absolute` tile API surface must be confirmed against the installed package's `.d.ts` in Task 5 — if absent, overlay-mode tiles are tracked outside the Grid in a brain-local recency list (same public behavior, note it as library feedback).
