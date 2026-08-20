# v0.2.0 human smoke pass — release gate

**No v0.2.0 build may be handed to anyone until every P0 item below has been
run by a human at a GUI and checked off.** The tag itself was cut from a
headless build environment on green automation (330 vitest + 130 cargo tests)
plus a built installer — so at tag time every box here is still open, exactly
as at v0.1.0. Same contract as
[`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md): everything here is covered by
automated tests at the logic level only — the pixels have to be *seen* once.
v0.2.0 tasks append their GUI-only checks to this file as they land.

Build under test:
`apps/desktop/src-tauri/target/release/bundle/nsis/Griddle Window
Manager_0.2.0_x64-setup.exe` from a clean `npm run tauri:build`
(or `npm run tauri:build:local` when you do not hold the signing key).

> **Do not verify with a `cargo build --release` binary.** Tauri sets
> `dev = !custom_protocol` and only the Tauri CLI passes that feature, so a
> bare cargo build points every window at `http://localhost:5173` and shows
> "can't reach this page". It looks exactly like a broken app.

---

## P0 — the v0.2.0 dead-on-arrival regression (run before anything else)

Added 2026-08-19 after the WebView2 browser-argument bug
([`qa-handoff-2026-08-19.md`](qa-handoff-2026-08-19.md)) made every release to
date unusable: no window built at runtime could create its webview, so Settings,
the drag overlays and the brain's respawn path all failed silently. These three
boxes are the ones that would have caught it.

- [ ] **Settings opens at all.** With no `%APPDATA%\griddle-wm\config.json`,
      launch the app. The first-run welcome window appears *and stays*. A frame
      that flashes and vanishes within a second is the exact failure signature.
- [ ] **Settings opens again.** Close it, then reopen from the tray item, then
      from `Ctrl+Win+G`, then by launching the exe a second time. All three
      routes must work *every* time — the old bug bricked all of them
      permanently after the first failure.
- [ ] **The drag overlay appears.** With a grid enabled on a monitor that has
      windows on it, drag one. The grid preview must fade in. This is a
      separate webview from Settings and failed for the same reason.

## P0 — diagnosability (added 2026-08-19)

- [ ] `%APPDATA%\griddle-wm\logs\` exists after a run and contains a log file
      naming the version at startup. A shipped build that writes no log is the
      reason the above went undiagnosed for two releases.
- [ ] Open the log and confirm it contains **no window titles, no executable
      names and no document paths** — only Griddle's own state. This is a
      privacy promise in the README, not just a nicety.
- [ ] Launch with `GRIDDLE_DEBUG=1` set: the internal brain window becomes
      visible and the log gains debug-level lines.

## P0 — Windows-snap suppression (spec 2026-08-19)

- [ ] Settings → General → "Turn off Windows edge-snap while Griddle runs" on:
      dragging a window to a screen edge no longer triggers Windows' own snap,
      and Griddle's grid preview handles the drag instead.
- [ ] `Win+Arrow` still snaps (deliberately untouched).
- [ ] Tray Quit: drag-to-edge works again immediately in stock Windows.
- [ ] Relaunch: suppression re-applies without touching the toggle.
- [ ] Toggle off: drag-to-edge restored immediately, and
      `%APPDATA%\griddle-wm\config.json` shows `windowsSnapOriginal: null`.
- [ ] First-run wizard shows the unchecked "Turn off Windows edge-snap"
      checkbox and honours it when checked.

## P0 — drag intake + spoken refusals (spec 2026-08-20)

- [ ] Fill a grid so a newly opened window floats. Drag that floating window:
      the overlay appears immediately (the grab itself, not the first move).
- [ ] Drop it on a grid with room: it becomes a tile, snapped to the aimed
      cell.
- [ ] Drop it on the full push grid: the window stays where you dropped it
      and the overlay says "No room — this grid is full" for about 1.5 s.
- [ ] While hovering an impossible drop, the footprint turns grey and the
      message shows live — before you release.
- [ ] Drop on an ungridded monitor: nothing happens and nothing is said.

## P0 — make-room drop zone (spec 2026-08-20)

- [ ] Drag a window over a full grid: alongside "No room", a dashed
      "Drop here to make room" pill appears at your footprint.
- [ ] Move the cursor onto the pill: it arms (solid, glowing), the message
      becomes "Release to make room", and the ghosts preview the split — the
      aimed tile shrinking to half, your window taking the other half.
- [ ] Release while armed: exactly that split commits.
- [ ] Release elsewhere: nothing splits; the plain refusal stands.
- [ ] Over a grid whose aimed tile is 1×1 (nothing to donate): no make-room
      pill — but the Swap pill still appears.
- [ ] Two pills show side by side; arming Swap previews the aimed window's
      whole slot and says "Release to swap — the window there minimizes".
- [ ] Releasing on Swap: that window minimizes and yours takes its slot.
- [ ] Dragging a window with a large minimum size (Discord) over a full fine
      grid: no Swap onto slots smaller than its minimum, and placements give
      it enough cells instead of letting it overflow.

## P0 — window-eligibility carve-outs (spec 2026-08-20)

- [ ] Open Griddle's Settings window on a gridded monitor: it tiles like any
      other window, and dragging it previews and snaps.
- [ ] The drag overlays and (under GRIDDLE_DEBUG=1) the brain window never
      appear as tiles.
- [ ] Add griddle-wm.exe to exclusions: Settings stops being managed.
- [ ] A borderless / custom-chrome window (an Electron app, a launcher)
      tiles like any captioned window — the caption gate is gone.
- [ ] Tile a window running as administrator, then let Griddle try to move it
      (e.g. drop another window onto its cell): the overlay says Windows
      blocks the move.

## P0 — build isolation (added 2026-08-19)

- [ ] With a copy installed, run `npm run tauri:dev`. It must write to
      `%APPDATA%\griddle-wm-dev\`, leaving the installed copy's
      `%APPDATA%\griddle-wm\config.json` untouched.
- [ ] Toggling "Start with Windows" in that dev build must refuse and log why,
      rather than pointing the logon entry at `target\debug`.

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
      of producing sliver cells), and nothing overlaps. The stepper itself
      must say so — it reads "64px → \<smaller\>px" and the hint under the
      row explains the cap. The number shown must match the gutters in the
      editor preview and on the desktop.
- [ ] **Spacing is explained without hovering**: with the mouse parked away
      from the controls, the sentence "Gap spaces neighboring windows apart;
      padding insets the whole grid from the monitor edges." is visible under
      the Gap/Padding row (also reachable by keyboard — Tab through the
      steppers, nothing important is tooltip-only).
- [ ] **Press-and-hold**: hold the Gap "+" button down — after a short pause
      the value climbs on its own and stops at 64 (and at 0 on "−"); the
      windows keep up. The same works on Columns/Rows. A single quick click
      still moves exactly one step.
- [ ] Disable and re-enable the grid, then quit and relaunch: gap and
      padding survive both round-trips (steppers and desktop agree).

## P0 — app defaults: tile context menu + rules card (spec 2026-08-09 §2, ~5 min)

On an enabled grid with a few managed windows (settings window open):

- [ ] Right-click a tile in the settings editor: a menu opens at the cursor
      with a header naming the tile's program ("chrome.exe — default spot")
      above "Save for this grid" and "Save for all grids"; no remove entries
      appear yet (none exist). Right-clicking must **not** pick the tile up
      for a drag.
- [ ] **Long exe names stay readable**: do the same on a tile whose program
      has a long name (msedgewebview2.exe, ApplicationFrameHost.exe,
      WindowsTerminal.exe). The two save entries must still read as two
      *different* entries — no ellipsis may swallow "this grid" / "all
      grids" — and the exe in the header may wrap but must not be cut off
      mid-word into meaninglessness.
- [ ] Dismissal: Esc closes the menu; clicking anywhere outside closes it,
      and the dismissing press never picks up a tile for a drag;
      right-clicking a *different* tile closes it and opens that tile's
      menu.
- [ ] Keyboard: Tab to a tile in the editor (focus ring visible), press
      Shift+F10 (or the menu key) — the same menu opens with the first item
      focused; ArrowUp/ArrowDown cycle through items, Enter activates,
      focus returns to the tile after the menu closes.
- [ ] Save "for this grid" for a tile: the App defaults card lists the rule —
      a miniature drawing of the grid with the saved cells highlighted, the
      exe, the monitor's name as scope, and a slot summary matching the
      tile's cells. The miniature's highlighted block must sit where the tile
      sits in the editor above. Right-click the tile again: the first entry
      now reads "Update for this grid" and "Remove for this grid" appears
      (danger-colored).
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

- [ ] **Capture**: in the Views card, type a name and click "Capture view" —
      the view appears in the list with the right grid/window counts. The
      button is disabled while the name is empty; with every grid disabled,
      the card says to enable one first and the button stays disabled.
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
- [ ] **A view does not launch apps**: close every window of one captured
      program, then click Apply now. The grids rebuild and the remaining
      windows land, and the closed program stays closed — the card's hint
      says exactly that, so nothing about the outcome should read as a bug.
- [ ] **Rename / delete**: Rename swaps to an inline input (Enter commits,
      Esc cancels, focus lands in the input). Delete is a **two-step**:
      the first click arms it ("Sure?", danger-colored), a second click
      inside a couple of seconds deletes, and letting it sit disarms it — the
      same guard template deletion uses. One stray click must never destroy a
      view. Deleting the view selected under "Load at startup" flips the
      radio back to None.
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

## P0 — updates (spec §7, ~6 min)

The updater is v0.2.0's only network feature and the README makes a hard
promise about it ("With the toggle off, the app makes no network requests at
all"). Nothing here is covered by pixels alone — item 1 is the promise.

- [ ] **Toggle off means silence.** With **Check for updates automatically**
      off (the default on a fresh config), launch the app and leave it running
      for a few minutes through a normal session — enable a grid, drag windows,
      open and close Settings. With a network monitor watching the process
      (Resource Monitor → Network, or Fiddler/Wireshark filtered to the
      process), **zero** outbound requests leave it. No DNS lookup for
      `github.com`, no TLS connection.
- [ ] **"Check now" works with the toggle off.** Settings → Updates → click
      **Check now** while the toggle is still off. It checks (button reads
      "Checking…", then a result line), and the toggle stays off — clicking is
      the consent, and it does not silently enable anything. This is the only
      request the monitor should show.
- [ ] **Up-to-date path.** On the current release, the hint under the button
      reads that you are on the latest, with a "last checked" time that
      updates on each click.
- [ ] **Toggle on persists.** Turn the toggle on, quit, relaunch: it is still
      on, and the card's subtitle shows the last-checked time.
- [ ] **Update-available prompt.** Install the *previous* release, enable the
      check, and confirm the banner appears naming the new version, the
      release date, and the release notes — and that it appears *only* as a
      prompt: nothing downloads or installs until you click.
- [ ] **Dismiss.** "Not now" closes the banner and the app carries on; it does
      not reappear for the rest of the session.
- [ ] **Install and restart.** Click install: the banner shows download
      progress in MB, then "Installing — Griddle Window Manager will restart".
      The app restarts on the new version, and Settings → Updates shows the
      new version number. Grids, templates, views and app defaults all survive
      the upgrade.
- [ ] **Failure is honest.** Disconnect the network and click **Check now**:
      the error card explains what went wrong and offers "Try again"; the app
      stays usable and nothing is left half-installed.

## P1 — information architecture + copy (critique round, ~3 min)

- [ ] Scroll the settings page top to bottom with a grid enabled. Card order
      reads: monitor card(s) → spanning grid card(s) → Span monitors → **App
      defaults** → **Views** → General → Excluded apps → Floating windows.
      The two placement cards must sit above General/Excluded, near the grid
      editors that feed them.
- [ ] The Views card says, in visible copy, both (a) how a view differs from
      a template and (b) that applying one places windows but never launches
      programs, and that during the two-minute window a view outranks app
      defaults.
- [ ] The General card's subtitle reads "Launch at sign-in and the settings
      hotkey" and its last line points at "Load at startup" in the Views card
      — a user hunting for startup behavior in General is not left stranded.
- [ ] Snapshot verbs match: the template gallery's button says "Capture
      layout", the Views card's says "Capture view".

## P1 — claim window edge cases (critique round, ~5 min)

- [ ] **Docking**: with a startup view whose grid lives on an external
      monitor, undock, quit Griddle Window Manager, relaunch, then dock within two
      minutes with one of the view's programs already running. When the
      monitor appears, that program's window lands on its saved cells (not
      auto-placed). Automated coverage exists in `views.test.ts`; this checks
      the real hotplug burst.
- [ ] **Pause**: with a startup view selected, pause from the tray, relaunch
      Griddle Window Manager (it comes back paused), wait more than two minutes, then
      resume and launch one of the view's programs. Its window still lands on
      the saved cells — the pause does not spend the claim window.

---

Record the outcome (pass/fail per item, machine specs, monitor topology) in
the release notes for the tag. Any P0 failure blocks the tag until fixed and
re-run.
