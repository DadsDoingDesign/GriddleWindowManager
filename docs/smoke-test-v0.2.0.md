# v0.2.0 human smoke pass — release gate

**The `v0.2.0` tag must not be cut until every P0 item below has been run by
a human at a GUI and checked off.** Same contract as
[`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md): everything here is covered by
automated tests at the logic level only — the pixels have to be *seen* once.
v0.2.0 tasks append their GUI-only checks to this file as they land.

Build under test: `apps/desktop/src-tauri/target/release/bundle/nsis/Griddle
WM_0.2.0_x64-setup.exe` from a clean `npx tauri build`.

---

## P0 — regression (run first)

- [ ] Re-run v0.1.0 P0 items **3 (drag + overlay)**, **4 (settings editor
      drag)**, and **5 (tray/hotkey/pause)** from
      [`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md) on this build — the
      spacing changes touch every pixel-rect path those items exercise.
- [ ] **v0.1.0 config upgrade**: launch this build over an existing
      `%APPDATA%/griddle-wm/config.json` written by v0.1.0 (no `gap`/
      `padding` fields). The config loads (no `.bak` quarantine appears),
      grids come back enabled with their layouts, and both spacing steppers
      read 0px.

## P0 — spacing: gap + padding (spec 2026-08-09 §1, ~6 min)

On a Tile grid with a few managed windows:

- [ ] In Settings, step **Gap** up from 0: on every click the real windows
      re-space themselves in one visible batch (no staggered movement), and
      neighboring windows end up exactly one even gutter apart.
- [ ] Step **Padding** up: the whole layout insets from the monitor edges
      (including the taskbar edge) by the same margin on all four sides.
- [ ] The settings editor miniature matches the desktop: the same relative
      gutters between tiles and the same margin around the grid appear in
      the editor as on the real monitor (spec §1 editor parity).
- [ ] Drag a real window with gap/padding set: the overlay's faint grid
      lines frame the gutters (a line pair on each seam) and its border
      hugs the *padded* area; the highlighted footprint sits inside the
      cell content, and the drop lands the window exactly on it.
- [ ] Stack mode: a non-resizable window (e.g. a fixed-size dialog) is
      position-snapped *inside* the padded area — it never touches the
      monitor edge while padding is on.
- [ ] Set an extreme combination (many columns + gap 64) on a small/scaled
      monitor: cells visibly refuse to collapse (gap coerces down instead
      of producing sliver cells), and nothing overlaps.
- [ ] Disable and re-enable the grid, then quit and relaunch: gap and
      padding survive both round-trips (steppers and desktop agree).

<!-- Later v0.2.0 tasks (app rules, startup views) append their GUI-only
     checks below this line. -->

---

Record the outcome (pass/fail per item, machine specs, monitor topology) in
the release notes for the tag. Any P0 failure blocks the tag until fixed and
re-run.
