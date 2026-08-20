# Windows Snap suppression — Design Spec

**Date:** 2026-08-19
**Status:** Approved (user-selected scope, restore policy, and default)
**Context:** First real-use QA session (docs/qa-handoff-2026-08-19.md). Dragging a
managed window toward a monitor edge triggers Windows' native drag-to-edge snap,
which resizes the window mid-drag — fighting Griddle's overlay/placement and
desynchronising the cursor grab point. FancyZones has the identical conflict and
the identical remedy (it disables the OS setting).

## 1. Decisions (locked, from the design conversation)

1. **Scope: drag-to-edge + Snap Layouts flyout.** Suppress the two mouse-driven
   gestures that collide with Griddle's own drag handling. Keyboard `Win+Arrow`
   (governed by `WindowArrangementActive`) is deliberately left working.
2. **Restore on quit, remember choice.** Original values are captured before any
   change and persisted in the config; tray Quit restores them; next launch
   re-applies the suppression if the preference is on. A user who quits Griddle
   gets stock Windows back immediately. A crash cannot strand the machine: the
   persisted originals let the next launch (or a manual toggle-off) restore.
3. **Opt-in, default off.** Unchecked checkbox in the first-run wizard beside
   "Start with Windows"; the same toggle in Settings → General. Changing a
   user's OS settings is their call; Griddle asks, explains, and undoes.

## 2. What is changed on Windows, exactly

| # | Setting | Mechanism | Effect |
| - | ------- | --------- | ------ |
| 1 | `DockMoving` (HKCU\Control Panel\Desktop) | `SystemParametersInfoW(SPI_SETDOCKMOVING, …, SPIF_UPDATEINIFILE \| SPIF_SENDCHANGE)` | Drag-to-edge snap off |
| 2 | `SnapSizing` (same key) | `SPI_SETSNAPSIZING`, same flags | Drag-to-top/bottom-edge resize off |
| 3 | `EnableSnapAssistFlyout` (HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced), DWORD | Registry write + `WM_SETTINGCHANGE` broadcast (no SPI exists) | Snap Layouts flyout on maximize-hover off |

Reads use the corresponding `SPI_GET*` calls; the flyout value reads from the
registry, treating *absent* as `1` (Windows' default is on). All three are
per-user (HKCU) — no elevation needed.

`WindowArrangementActive` (`SPI_GETWINARRANGING`) is read for diagnostics but
never written: when the user has already disabled all snapping globally,
setting sub-flags is redundant, and the settings UI can say so.

## 3. Config schema (v4 → v5)

```rust
/// Captured pre-Griddle values of the three OS settings, stored so restore
/// survives a crash. `None` = Griddle has not modified the OS.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapState {
    pub dock_moving: bool,
    pub snap_sizing: bool,
    pub snap_assist_flyout: bool,
}

// on AppConfig:
#[serde(default)]                    // v1–v4 configs: false
pub suppress_windows_snap: bool,
#[serde(default)]                    // v1–v4 configs: None
pub windows_snap_original: Option<SnapState>,
```

`CONFIG_VERSION` bumps to 5. Both fields use the established `#[serde(default)]`
migration pattern (`app_rules`, `views`, `auto_check_updates`), so every older
config still deserializes and is re-stamped on read.

**Invariant:** `windows_snap_original` is `Some` exactly while Griddle believes
it has modified the OS. Set (from a fresh capture) at the moment of first
suppression; cleared at the moment of restore.

## 4. Module: `apps/desktop/src-tauri/src/snap.rs`

Pure decision core, thin Win32 edge — the same layering as `actuator.rs`.

```rust
/// Pure: what should happen given the preference and the stored capture?
/// (wanted, original) -> Action
///   (true,  None)        => CaptureAndSuppress   // first enable
///   (true,  Some(_))     => Suppress             // re-apply on launch; keep capture
///   (false, Some(orig))  => Restore(orig)        // toggle off / quit restore
///   (false, None)        => Nothing              // never touched
pub fn plan(wanted: bool, original: Option<SnapState>) -> Action;
```

Win32 half (`#[cfg(windows)]`): `read_os() -> SnapState`,
`write_os(dock, sizing, flyout)`, both logging every value they change at
`info` level (values are booleans — no privacy concern). `write_os` failures
log and leave the stored capture in place, so restore can be retried.

Quit restore does **not** clear the persisted capture (the brain's debounced
writer may not run again before exit); instead, launch with `wanted == true`
re-applies, and launch with `wanted == false && original == Some` performs a
deferred restore-and-clear. This makes the stored capture self-healing in
every crash ordering.

## 5. Lifecycle wiring

- `shell::sync_from_config` (the existing convergence point that already syncs
  hotkey + autostart on every config sighting) additionally calls
  `snap::sync(app, cfg)`. Idempotent: applying the same state twice is a no-op.
- Tray Quit (`MENU_ID_QUIT`, after `mark_exiting()`): if the live preference is
  on, restore the OS values synchronously before `app.exit(0)`.
- The settings toggle emits the existing `settings-set-prefs` event extended
  with `suppressWindowsSnap`; the brain host owns the config write (single
  writer, unchanged) and the capture/restore side-effect runs in Rust when the
  new config value is synced.

## 6. UI

**First-run wizard** (Settings.svelte first-run block): checkbox under "Start
with Windows", unchecked:

> Turn off Windows edge-snap while Griddle runs — stops Windows' own
> drag-to-edge snap from fighting the grid. Griddle puts it back when it quits.

**Settings → General**: same toggle, same copy, plus a dimmed note when
`WindowArrangementActive == 0`: "Windows snapping is already fully disabled in
Windows Settings."

## 7. Testing

- **Unit (Rust):** `plan()` truth table (4 arms); serde round-trip of
  `SnapState` and the two new fields; v4-config-without-fields loads with
  `false`/`None`; v5 round-trips.
- **Unit (brain):** prefs event carries the new field; config write preserves it.
- **Smoke (human, appended to docs/smoke-test-v0.2.0.md):** toggle on → drag to
  edge → no Windows snap, Griddle overlay appears; tray Quit → drag-to-edge
  works again in stock Windows; relaunch → suppressed again; toggle off →
  restored immediately; `Win+Arrow` works throughout.

## 8. Out of scope

- Detecting third-party snap tools (FancyZones, AquaSnap).
- The cursor-misalignment report is *hypothesised* to be Windows Snap resizing
  the window mid-drag; if it persists with snap suppressed, it becomes a
  separate investigation (drag-offset math in drag_pump/brain), not part of
  this feature.
- Uninstaller restore: quit-restore already covers the uninstall path in
  practice (NSIS kills the app first, and the app restored on quit; a crash
  during uninstall leaves the standard Windows Settings toggle as the remedy).
