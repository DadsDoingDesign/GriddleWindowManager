# Deferred items — Griddle WM v0.1.0

Everything consciously *not* done for v0.1.0, collected from the design spec
(§6, §7, §10), the security review's accepted findings, and per-task commit
notes. Each item names its source so the deferral stays auditable.

## Product features (spec §10 "out of scope v1")

- Keyboard-driven tiling commands (move/focus/resize via hotkeys).
- Per-app template bindings (auto-apply a template when an app appears).
- Animating real windows during layout changes (only overlay ghosts animate).
- macOS / Linux support.
- Auto-update.
- Code-signed binaries (README documents the SmartScreen flow instead).
- Virtual-desktop integration.
- Saving/restoring app sessions.

## Elevated windows (spec §6)

Elevated windows are treated as unmanageable by the non-elevated process.
Deferred beyond that baseline:

- One-time explanatory notification the first time an elevated window is
  skipped (currently they are skipped silently).
- Optional "restart as admin" setting.

## Distribution (spec §7)

- **winget manifest** — planned fast-follow after v0.1.0 ships.
- README demo GIF — a real recording needs a human at a GUI (the placeholder
  blockquote was removed from the README so the docs don't ship a visible
  construction sign; add the GIF under the intro paragraph when recorded).

## Security review — accepted-not-fixed findings

Full detail in [`security-review.md`](security-review.md) §"Noted but
accepted". Summary of what is still deferred:

1. Geometry sanity clamps on `apply_layout` (reject rects outside the
   virtual desktop, minimum sizes, checked arithmetic in
   `compensate_target`).
2. Cap serialized config size (`layouts` map is unbounded). The other half
   of the original item — validating `hotkey` with `Shortcut::parse` at
   write time — was **fixed** in the critique round (`config.rs`
   `sanitize_hotkey`: invalid accelerators are replaced with the live
   binding before persisting).
3. Split overlay windows into their own capability file granting only
   `core:event:default` (they currently inherit `core:default`, mitigated by
   Rust-side per-label command gating).

Fixed since the list was written (critique round): unique per-write temp
names close the `write_config` temp-file race (old item 4), and
`overlay.rs::ensure_overlay` now uses the poison-tolerant lock pattern (old
item 5).

## Critique round (Task 22) — consciously deferred findings

Decisions from the pre-ship critique triage. What was *fixed* is in the git
log; what follows is what was deliberately not done, and why.

- **Monitor-id re-keying on topology change.** `monitor_id()` embeds the
  virtual-desktop origin, so changing one monitor's resolution re-keys the
  ids of monitors positioned after it and orphans their `grid:<id>` settings
  (the grids simply have to be re-enabled once). Matching returned monitors
  to grid settings by device name — or migrating ids — interacts with
  spanning-grid ids (`grid:span:<a+b>`) and persisted layouts, and is too
  invasive days before v0.1.0. The hotplug revival path shipped in the
  critique round covers the common dock/undock case (same ids); id
  migration is a fast-follow.
- **External (app-initiated) move/resize drift.** Maximize / restore is now
  fully tracked (LOCATIONCHANGE-derived zoom transitions), but a window that
  an *app* moves itself, or the user snaps with Win+Arrow, still diverges
  from its tile until the next event touches it. Feeding generic external
  moves into the brain needs a new contract event plus careful
  `matches_expected` suppression tuning, and misfires would cause visible
  window fights; deferred with the maximize case — by far the common one —
  closed.
- **Hotkey registration-failure feedback in the settings UI.** The rebind
  field now validates and canonicalizes locally (with "Win" accepted for
  Super) and unparseable strings can no longer persist, so the remaining
  silent case is an accelerator another app already owns. Surfacing that
  asynchronously needs a new Rust→settings event; the hint sentence covers
  it for v0.1.0.
- **Rust-side end-to-end drag latency measurement.** The <50 ms repack and
  120 Hz drag-flood budgets measure pure brain time only; a
  WinEvent→emit→brain→DeferWindowPos timing test using the
  `create_test_window` helpers is deferred (needs a live event loop +
  webview to be honest, i.e. a harnessed instrumented build).
- **Brain-death respawn smoke test.** The watchdog (respawn `main` on
  `WindowEvent::Destroyed` unless quitting) shipped with unit-tested policy
  and the pure-TS rehydration proof; actually killing the WebView2 process
  and watching windows stay managed needs a human GUI session (listed
  below).

## Upstream library feedback (@griddle/core, @griddle/svelte)

Worked around in the brain/editor and recorded for upstream in
[`library-feedback.md`](library-feedback.md); revisit if the libraries gain
the features:

- No blocked/dead-cell concept (spanning-grid dead space is enforced by a
  brain-side mask + clone-and-verify around every rules-engine op).
- No z-order on out-of-flow tiles (brain tracks recency itself).
- No resize API for absolute tiles (remove + re-add workaround).
- `Grid.reflow` cannot change row count (brain rebuilds the grid instead).
- Throwing `fromJSON` on corrupt snapshots (brain validates layouts itself).
- Unclamped `setTilePinned` pins (brain and editor clamp before forwarding).
- `<GriddleGrid>` lacks a "controlled" mode and typed drag-event payloads;
  theming of grid lines requires `:global` CSS overrides.

## GUI-bound human smoke tests (from task commit notes)

These behaviors are covered by automated tests at the logic level but their
end-to-end feel was never verified by a human in this release cycle (the
build environment has no interactive GUI):

- Drag overlay look & feel: grid + footprint + ghosts during a real drag,
  fade-out on release, overlay never intercepting clicks (Task 15).
- ~60 Hz `drag-pos` cadence during a physical drag (Task 14).
- Editor tile drags rearranging real windows (Task 13).
- Mode toggles + template capture/apply/delete against a live desktop with
  config persistence across restart (Task 16).
- Spanning grid across two physical monitors, including dead-corner snapping
  (Task 17).
- Tray menu interaction, hotkey trigger, single-instance fronting, autostart
  registry entry (Task 18).
- Exclusions add/remove releasing and re-managing a running app's windows;
  first-run page appearing after deleting `config.json` (Task 19).
- Spanning-grid drag overlay rendering on both member monitors (the view
  model is unit-gated in `overlay-view.test.ts`, but the pixels need eyes)
  (critique round).
- Brain-webview kill → watchdog respawn → windows stay managed (critique
  round; policy unit-tested, GUI flow not).
- Pause during heavy desktop churn, then resume: windows opened/closed
  while paused reconcile (critique round).
- Maximize a managed window → tile released; unmaximize → window returns to
  its slot; drag-to-unsnap from maximized re-manages after the drop
  (critique round).
- Tray tooltip showing the grid-full floating count (critique round).
- Installer install + launch smoke test on a clean machine (Task 23 — the
  NSIS bundle builds and is present, but installing and launching it needs a
  human session).
