# v0.1.0 human smoke pass — release gate

**The `v0.1.0` tag must not be cut until every P0 item below has been run by
a human at a GUI and checked off.** This is the scripted ~30-minute pass the
pre-ship critique demanded: the product's hero moment (the drag overlay) and
its disaster-recovery path (brain respawn) are covered by automated tests at
the logic level only — no human has watched them run. Everything here maps
1:1 onto the "GUI-bound human smoke tests" list in
[`deferred.md`](deferred.md).

While running the pass, also capture the two README assets (see the last
section) — same session, no extra setup.

Build under test: `apps/desktop/src-tauri/target/release/bundle/nsis/Griddle
WM_0.1.0_x64-setup.exe` from a clean `npx tauri build`.

---

## P0 — gate items (must pass, in this order)

### 1. Install + launch on a clean machine (~5 min)

- [ ] Copy the NSIS installer to a machine (or fresh Windows account) that
      has never run Griddle WM. Run it. Expect the SmartScreen "Windows
      protected your PC" flow described in the README ("More info → Run
      anyway") — confirm the README's wording matches what you see.
- [ ] Install completes **without an elevation prompt** (per-user install).
- [ ] Launch from the Start menu. The tray icon appears; no visible windows
      except the first-run settings page.

### 2. First-run enable (~2 min)

- [ ] The first-run page lists your monitors with resolution + "primary".
- [ ] Pick a monitor, click **Enable grid**: every eligible window on that
      monitor snaps into the 12×6 grid in one batch, and the page switches
      to the full settings view.
- [ ] Quit (tray → Quit) and relaunch: the first-run page does **not**
      return; the grid is still enabled and windows are still managed.

### 3. Drag + resize with overlay — the hero moment (~8 min)

On a **Tile** grid:

- [ ] Start dragging a managed window: the translucent grid fades in
      *quickly* (no multi-hundred-ms WebView2 stutter), with a highlighted
      footprint under the cursor.
- [ ] The footprint follows the cursor smoothly (~60 Hz feel, no visible
      lag or rubber-banding).
- [ ] Dragging onto an occupied cell shows ghost outlines of the neighbors
      that would be pushed; the ghosts move as you move.
- [ ] Release: the window lands exactly on the previewed cell, neighbors
      land where their ghosts were, and the overlay fades out.
- [ ] Resize a managed window: the outline snaps to whole cells; release
      lands on the previewed footprint.
- [ ] **The overlay never intercepts clicks**: while the overlay is fading
      out (and after), click things under where it was — every click goes
      through.
- [ ] Drop a window onto a monitor with no grid: it stays exactly where
      dropped (unmanaged).

Switch the grid to **Stack** mode:

- [ ] Drag shows the footprint with **no** ghosts; windows may overlap
      after the drop; the most recently touched window sits on top.

### 4. Settings editor drag (~3 min)

- [ ] Open Settings; the grid editor shows a tile per managed window with
      its title.
- [ ] Drag a tile to an empty cell: the **real window** moves when you
      drop. Drag a tile onto an occupied cell: the neighbor is displaced,
      both real windows move.

### 5. Tray, hotkey, pause (~5 min)

- [ ] Tray menu: per-monitor "Grid:" items show correct check state;
      toggling one enables/disables that grid live.
- [ ] Ctrl+Win+G opens (and fronts) the settings window from any app.
- [ ] Rebind the hotkey to e.g. `Ctrl+Alt+G` in Settings (type `Ctrl+Win+G`
      forms too — field shows "Win" spelling); the new binding works, the
      old one stops working.
- [ ] **Pause** from the tray: dragging managed windows does nothing (no
      overlay, no snap). While paused: move one managed window somewhere
      random, minimize another, close a third, open a new app window.
- [ ] **Unpause**: the moved window snaps back to its slot, the minimized
      one's tile is released, the closed one's tile is gone, the new window
      gets placed. (This exercises `brain.reconcile` end-to-end.)
- [ ] Launching the exe a second time fronts the settings window of the
      running instance instead of starting a second copy.

### 6. Brain-webview kill → respawn (~4 min)

This is the disaster-recovery path; `respawn_brain_host` has never executed
outside unit tests.

- [ ] With a grid enabled and windows managed, open Task Manager →
      Details, find the `msedgewebview2.exe` tree owned by Griddle WM and
      end the **renderer** process for the hidden brain page (or
      `taskkill /f /im msedgewebview2.exe` for the blunt version — it kills
      all Griddle webviews; overlays/settings recreate on demand).
- [ ] Within ~15 s the heartbeat watchdog fires. If a debug build is
      handy, expect the log lines: `brain host sent no heartbeat for …;
      forcing respawn` (heartbeat path) or `brain host window died
      unexpectedly; respawning` (Destroyed path), then `brain host
      respawned; rehydrating from config`.
- [ ] After the respawn: drag a managed window — the overlay appears and
      snapping works; previously managed windows are still on their slots
      (rehydrated from config).

## P1 — strongly recommended (run if the session allows)

### 7. Spanning grid on two physical monitors (~5 min)

Requires two physical monitors. **If this cannot be run, do not cut
spanning** — the README already labels spanning as the newest, least-tested
feature; leave that sentence in place.

- [ ] Create a spanning grid over two monitors; windows on both snap into
      one grid.
- [ ] During a drag, the overlay renders on **both** member monitors, and
      the footprint crosses the seam correctly.
- [ ] With mixed-height monitors (L-shaped union): drops into the dead
      corner snap to the nearest usable cells; nothing can be placed in
      the dead space.
- [ ] Re-enabling a per-monitor grid tears down the span.

### 8. Modes, templates, exclusions, maximize (~5 min)

- [ ] Toggle Tile↔Stack on a live grid; the hint line under the control
      restates the active mode.
- [ ] Capture the current layout as a template; apply a built-in template
      (windows map by recency); delete the captured template (two-click
      arm). Restart: templates and layouts survive.
- [ ] Exclude a running app (e.g. `notepad.exe`): its windows are released
      in place immediately; remove the exclusion: they are re-managed
      without a restart.
- [ ] Maximize a managed window: its tile is released and it is left
      alone. Unmaximize: it returns to its slot. Drag it out of maximized
      (drag-to-unsnap): it re-manages after the drop.
- [ ] Fill a small grid (e.g. 1×1) with more windows than fit: the tray
      tooltip reports the floating count.

## README assets to capture during this session

- [ ] **GIF** (~10 s): a drag on a Tile grid — overlay fade-in, footprint
      following the cursor, ghost reflow, drop, fade-out. Place under the
      README intro paragraph.
- [ ] **PNG**: the settings window with a populated grid editor and
      template gallery. Place in the README Usage section.

---

Record the outcome (pass/fail per item, machine specs, monitor topology) in
the release notes for the tag. Any P0 failure blocks the tag until fixed and
re-run.
