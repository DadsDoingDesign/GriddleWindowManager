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

## P0 — app defaults: tile context menu + rules card (spec 2026-08-09 §2, ~5 min)

On an enabled grid with a few managed windows (settings window open):

- [ ] Right-click a tile in the settings editor: a menu opens at the cursor
      with "Save as default for \<exe\> on this grid" and "…on all grids";
      no remove entries appear yet (none exist). Right-clicking must **not**
      pick the tile up for a drag.
- [ ] Dismissal: Esc closes the menu; clicking anywhere outside closes it,
      and the dismissing press never picks up a tile for a drag;
      right-clicking a *different* tile closes it and opens that tile's
      menu.
- [ ] Keyboard: Tab to a tile in the editor (focus ring visible), press
      Shift+F10 (or the menu key) — the same menu opens with the first item
      focused; ArrowUp/ArrowDown cycle through items, Enter activates,
      focus returns to the tile after the menu closes.
- [ ] Save "on this grid" for a tile: the App defaults card lists the rule —
      exe, the monitor's name as scope, and a slot summary matching the
      tile's cells. Right-click the tile again: "Remove default for \<exe\>
      on this grid" now appears (danger-colored).
- [ ] Rule fires: close every window of that program, move another window
      onto the saved cells, then launch the program again — its new window
      displaces the squatter and lands exactly on the saved cells (Tile
      mode). Windows already on screen never move when a rule is saved.
- [ ] Scope precedence: save "on all grids" for the same exe with a
      *different* slot (drag the tile elsewhere first). The card shows both
      rules (grid scope listed before "All grids"). A new window of the exe
      on this grid lands on the grid-specific slot; delete the grid-specific
      rule from the card and the next new window lands on the all-grids
      slot.
- [ ] Persistence: quit and relaunch — the App defaults card shows the same
      rules, and they still fire.

## P0 — startup views (spec 2026-08-09 §3/§4, ~8 min)

With a grid enabled and a few recognizable programs tiled (e.g. a browser,
an editor, a terminal):

- [ ] **Capture**: in the Views card, type a name and click "Save current as
      view" — the view appears in the list with the right grid/window
      counts. The button is disabled while the name is empty; with every
      grid disabled, the card says to enable one first and the button stays
      disabled.
- [ ] **Apply now**: change the grid dims and gap, drag windows around,
      then click Apply now — the grid returns to the captured dims/spacing
      and each program's window lands back on its saved cells in one
      visible batch.
- [ ] **Claim window**: close one of the captured programs, click Apply
      now, then launch the program within two minutes — its new window
      lands on the saved cells (not where an app rule or auto-placement
      would put it). Launch a *second* window of the same program: it
      places normally (the claim is spent).
- [ ] **Claim beats app rule**: save an app default for one captured
      program on different cells (right-click its tile). Apply the view and
      relaunch the program — during the two-minute window it takes the
      *view's* cells; after the window lapses, a new window takes the app
      rule's cells.
- [ ] **Rename / delete**: Rename swaps to an inline input (Enter commits,
      Esc cancels, focus lands in the input); Delete removes the row.
      Deleting the view selected under "Load at startup" flips the radio
      back to None.
- [ ] **Startup view**: pick a view under "Load at startup", quit Griddle
      WM, launch it again — the view's grids come up with their captured
      settings, already-open captured programs snap to their saved cells,
      and a captured program launched right after Griddle (within two
      minutes) still lands on its cells. With "None" selected, launch
      behaves exactly as v0.1.0 (layout restore only).
- [ ] **Reboot with autostart**: with autostart on and a startup view
      chosen, reboot Windows — as apps relaunch (auto-started or opened by
      hand within two minutes), each captured program lands on its saved
      cells even though every hwnd is new.
- [ ] **v1 config upgrade**: launch this build over a v0.1.0 config —
      it loads with no `.bak`, the Views card is empty, and after saving a
      view + quitting, `%APPDATA%/griddle-wm/config.json` reads
      `"version": 2` with the view and `startupViewId` persisted.

---

Record the outcome (pass/fail per item, machine specs, monitor topology) in
the release notes for the tag. Any P0 failure blocks the tag until fixed and
re-run.
