# v0.3.0 human smoke pass — release gate

**No v0.3.0 build may be handed to anyone until every P0 item below has been
run by a human at a GUI and checked off.** Same contract as
[`smoke-test-v0.2.0.md`](smoke-test-v0.2.0.md), which this file **does not
replace** — run that file's P0 sections first (the dead-on-arrival webview
checks, diagnosability, privacy). Everything new in v0.3.0 is covered by
automated tests at the logic level only; the pixels and the *feel* have to be
seen once.

Build under test:
`apps/desktop/src-tauri/target/release/bundle/nsis/Griddle Window
Manager_0.3.0_x64-setup.exe` from `npm run tauri:build`
(or `npm run tauri:build:local` when you do not hold the signing key).

> **Install over your previous copy, do not run the exe from `target/`.**
> The 2026-08-31 session lost an hour to exactly this: a stale installed copy
> was tested against fresh source, and every new behaviour "did not work"
> because it was never installed. Confirm the build's timestamp is newer than
> your last commit before you start.

New automation backing this release: the config corpus
(`fixtures/configs/v1..v9.json`, parsed by both loaders), the placement
invariants (`packages/brain/test/invariants.test.ts`, seeded property tests),
the packaged-boot smoke (`scripts/boot-smoke.ps1`) and the log lint
(`scripts/log-lint.ps1`). See [`evals-plan.md`](evals-plan.md).

---

## P0 — config migration (v7/v8 → v9)

The schema moved twice this release. A user upgrading from v0.2.0 carries a
v7 file.

- [ ] **Your existing config survives.** Before installing, copy
      `%APPDATA%\griddle-wm\config.json` somewhere. After the first launch,
      confirm your grids, spacing, templates, app defaults and views are all
      still there, and the file now reads `"version": 9`.
- [ ] **The four new fields defaulted correctly:** `dropPlacement: "fill"`,
      `movePlacement: "size"`, `maximizeBehavior: "expand"`,
      `noRoomPlacement: "split"`.
- [ ] **No quarantine.** `config.json.bak` must **not** appear. If it does,
      the loader rejected your file — stop and report it.

## P0 — drag fill placement (spec 2026-08-31)

- [ ] **A new window fills the open space.** With a grid holding one tile in
      part of it, drag a floating window over the grid. The preview snaps to
      the largest open rectangle — it does **not** track your cursor cell by
      cell — and releasing lands the window exactly where the preview showed.
- [ ] **Hovering an occupied tile still targets open space.** While open
      cells exist anywhere on the grid, dragging over an existing tile must
      never displace it.
- [ ] **Hovering a different open region retargets.** With two separate open
      regions, hovering the smaller one moves the preview there.
- [ ] **Minimum sizes hold.** Drag in a window with a real minimum (Spotify,
      Windows Settings). It never lands smaller than it can legally be, and
      it picks a region that fits rather than refusing.
- [ ] **Moving inside a grid keeps the tile's size.** Drag an existing tile
      around its own grid — its span does not change.

## P0 — expand on maximize (spec 2026-08-31)

- [ ] **Double-click expands in the grid.** Double-click a tiled window's
      title bar. It grows to the largest free space it can reach *inside the
      grid* and stays a window — it does not go full-screen over the taskbar.
- [ ] **The maximize button and Win+Up do the same thing.** All three
      gestures are the same OS event and must behave identically.
- [ ] **Double-clicking again toggles back** to the size it had before.
- [ ] **A boxed-in tile does nothing surprising.** A tile with no free
      neighbours simply stays where it is.
- [ ] **A floating (untiled) window still truly maximizes.** The new
      behaviour applies to tiled windows only.

## P0 — automatic make-room (spec 2026-08-31)

- [ ] **A full grid makes room.** Fill a grid completely, then drag another
      window onto it. The preview shows the aimed tile shrinking to half and
      the newcomer taking the other half — releasing anywhere commits it. The
      old "No room" dead end must be gone.
- [ ] **The reported case works.** Two grids, each with one window filling it
      completely. Drag one onto the other: both end up sharing the grid.
- [ ] **A tile at its minimum still refuses honestly.** When the aimed window
      cannot legally shrink, the refusal message appears instead — no
      collapsed or overlapping windows.
- [ ] **Swap still works.** The Swap band remains available during a refused
      drag and still minimizes the window it replaces.
- [ ] **A click is not a drag.** Click a floating window's title bar over a
      full grid and release without moving. Nothing may be split.

## P0 — settings panel

- [ ] **The gear moved.** It sits at the right end of the display-tab row,
      not in the brand row. Selecting it opens Preferences; selecting a
      display tab leaves Preferences. There is always a way back out.
- [ ] **Five dropdowns render and open in place.** Appearance, Dropping onto
      a grid, Moving within a grid, Maximizing a tiled window, Dropping on a
      full grid. Each list opens *over the panel* — a list that appears in the
      middle of the screen or off-window is the old native-`<select>` bug.
- [ ] **Keyboard works on them.** Tab to a dropdown, open with Enter/Space,
      move with arrows, commit with Enter, dismiss with Escape.
- [ ] **Every choice actually changes behaviour.** Flip each of the four
      placement settings and re-run the matching check above — the old
      behaviour must come back.
- [ ] **Choices persist.** Quit from the tray, relaunch, and confirm all five
      still read what you set.
- [ ] **Light mode.** Switch Appearance to Light and confirm the new
      dropdowns and rows are legible, not dark-on-dark.

## P1 — regressions worth a glance

- [ ] Templates, app defaults and views still apply as they did in v0.2.0.
- [ ] Multi-monitor: unplug and replug a display; grids release and revive.
- [ ] Run `powershell -File scripts/log-lint.ps1` after the session. Two
      known findings are expected until their fixes land (sleep-triggered
      brain-host respawns, a recurring `396x0` rect); anything else is new.
