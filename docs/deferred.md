# Deferred items — Griddle Window Manager v0.1.0 → v0.2.0

Everything consciously *not* done for v0.1.0, collected from the design spec
(§6, §7, §10), the security review's accepted findings, and per-task commit
notes. Each item names its source so the deferral stays auditable.

## Product features (spec §10 "out of scope v1")

- Keyboard-driven tiling commands (move/focus/resize via hotkeys).
- Per-app template bindings (auto-apply a template when an app appears).
- Animating real windows during layout changes (only overlay ghosts animate).
- macOS / Linux support.
- Code-signed binaries (README documents the SmartScreen flow instead).
- Virtual-desktop integration.
- Saving/restoring app sessions.

**Shipped since this list was written:** *Auto-update* was on this list for
v0.1.0 and shipped in **v0.2.0** as an opt-in, off-by-default update check
(README, "License, notices, privacy and updates"). Code-signed binaries above
remain deferred — the updater verifies its payloads with the project's own
minisign key, which is a different thing from an Authenticode certificate.

## Elevated windows (spec §6)

Elevated windows are treated as unmanageable by the non-elevated process.

- ~~One-time explanatory notification the first time an elevated window is
  skipped.~~ **Done 2026-08-21.** Not one-time-per-run in the end: it fires
  when the user *drags* one, which is the moment the exclusion is confusing,
  and it reuses the overlay's existing refusal message rather than the
  dedicated notice webview that failed with `STATUS_ENTRYPOINT_NOT_FOUND`.
  A per-run notice at startup would have arrived before the user asked
  anything.
- Optional "restart as admin" setting — still deferred. It is the only way to
  actually manage these windows, but it means shipping a path that runs the
  whole app elevated, which deserves its own think.

## Distribution (spec §7)

- **winget manifest** — planned fast-follow after v0.1.0 ships.
- README demo GIF + settings screenshot — a real recording needs a human at
  a GUI. Both captures are line items in the release-gating smoke pass
  ([`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md), "README assets"), so the
  same session that verifies the overlay produces the proof for the README.

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

Also standing open by choice: the one **Dependabot advisory** on the repo
(RUSTSEC-2024-0429, `glib` unsoundness). It is unreachable in anything we ship
— `glib` reaches `Cargo.lock` only through Tauri's Linux-gated GTK tray stack
and is absent from the Windows dependency graph — and there is no version to
upgrade to. It is deliberately **not dismissed**, so the push banner keeps
acting as a tripwire if Griddle ever gains a Linux build. Full triage and the
reasoning in [`security-review.md`](security-review.md) §"Dependency
advisories".

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
  below). *Update (critique round 2):* a `brain_alive` heartbeat now also
  covers the deaths `Destroyed` cannot see (renderer crash with a live
  window object, boot failure, wedged JS event loop) — but
  `respawn_brain_host` itself has still never executed outside unit tests,
  which is why the webview-kill test is a P0 item in the release-gating
  smoke pass.

## Critique round 2 (pre-tag) — consciously deferred findings

Second triage against the pre-ship critique. What was *fixed* is in the git
log (HWND-recycling re-adoption, full pause-resume reconciliation, the
actuator's `IsIconic` guard, the brain-host heartbeat, targeted Rust-side
emits, read-only settings enumeration, monitors-changed debounce, the
settings mode-copy/pause/stepper/hotkey-display UX batch, README link and
placeholder fixes). What follows was deliberately not done, and why.

- **Release gate.** The `v0.1.0` tag is gated on the scripted human smoke
  pass in [`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md) — this build
  environment has no interactive GUI, so the pass cannot be run from here.
  The "GUI-bound human smoke tests" list below maps onto that script. If
  the two-physical-monitor spanning item cannot be run, spanning ships
  anyway with the README's "least real-world testing" labeling (added this
  round) rather than being cut.
- **Friendly monitor names.** Monitors are still presented as
  `DISPLAY1`/`DISPLAY2` (GDI device names) with resolution + "primary"
  metadata. Real display names need
  `QueryDisplayConfig`/`DISPLAYCONFIG_TARGET_DEVICE_NAME` plumbed through
  `MonitorInfo` and every UI surface; queued as a fast-follow.
- **TS-side targeted emits** (`preview-state`, `state-snapshot`). The Rust
  hot path (drag-pos at ~60 Hz plus all tracker events) now uses
  `emit_to("main")`, which removes the per-frame fan-out. The brain-side
  emits still broadcast: overlay windows have dynamic labels
  (`overlay-<n>`) the host does not track, `preview-state` only fires on
  footprint *changes* (not per frame), and `state-snapshot` only on state
  changes — the remaining waste is small and the label-registry plumbing is
  not worth it days before the tag.
- **Per-window apply-failure feedback to the brain.** When `SetWindowPos`
  fails for a live window ("alive but unmovable", e.g. turned elevated),
  the tile and window now *documentedly* diverge until the next user
  interaction (the actuator comment was corrected this round). Reporting
  per-hwnd outcomes back through `apply_layout` so the brain can drop the
  stale `appliedRects` entry needs a command-result contract change plus
  brain retry logic; accepted as the same class of drift as external app
  moves (above).

## Critique round 3 (pre-tag) — decisions and deferrals

Third triage. Fixed this round (details in the git log): the brain-host
heartbeat is now throttling-proof (90 s timeout + WebView2
`--disable-background-timer-throttling` + `apply_layout`/`list_windows`
count as beats + a 10-minute idle-soak smoke item), the five builtin
templates were re-authored on the 12×6 default lattice so applying one never
re-dimensions a fresh grid (this **supersedes the plan's Task 6 geometry**
for `tpl:main-side` — 12×6 `{0,0,7,6}+{7,0,5,6}` instead of 8×6; a data
change plus test updates, no logic change), the Apply button discloses
re-gridding whenever a template's dims differ from the grid's, a maximized
window racing an apply is skipped like a minimized one (no more SW_RESTORE
fighting the user), fresh installs no longer write a default config before
any user action (also un-racing the first-run page), the first-run card
offers a pre-checked "Start with Windows", spanning-grid UI now carries the
README's "Experimental" labeling, `read_config` is a pure read for the
settings window, the tray works from a watcher-maintained monitor cache,
overlays got their own minimal capability file, and `apps/desktop/README.md`
lost its create-vite boilerplate. Deliberately not done:

- **Hide-to-tray apps are treated as destroyed.** The tracker routes
  `EVENT_OBJECT_HIDE` through the destroy flow, so a Slack/Discord-style
  close-to-tray forgets the window's tile *and its remembered slot*. In
  practice the window usually recovers its cell on unhide (the unchanged
  rect snaps back to the same slot, gravity is `none`) — but if another
  window took the cell meanwhile, the returning app lands elsewhere, unlike
  minimize/restore which remembers the slot. Same drift class as the
  external-move item in round 1. Fast-follow: route HIDE through the
  minimize flow (slot remembered) instead of the destroy flow; needs care
  around genuine hides (cloak transitions, virtual-desktop switches) that
  must *not* hold slots forever.
- **Template gallery rendered per grid card.** The gallery is a global
  collection but appears inside every enabled grid card, so two gridded
  monitors show it twice (the per-card placement does give Apply an
  unambiguous target grid, and the shared-ness is now a hint line instead
  of a label parenthetical). For 0.2: one Templates card with an explicit
  "Apply to: [grid]" affordance, or collapsed-by-default galleries.
- **Spanning grids ship Experimental rather than cut.** The two-physical-
  monitor smoke item may go unrun before tagging (no second monitor in the
  build environment). Decision per round 2 stands, now with the UI honest
  about it: the Span monitors card and every span-grid card carry an
  "Experimental" badge plus the README's caveat line. If that smoke item
  ever *fails* (not merely goes unrun), the creation UI gets cut for 0.1.0
  and the brain support stays dark.

## v0.2.0 critique round — decisions and deferrals

Triage of the spacing / app-rules / startup-views critique. Everything the
panel raised as **blocking or important was fixed** (git log: context-menu
label redesign with a non-truncatable exe header, the Views card's
"a view doesn't launch programs" + templates-vs-views + claim-precedence
copy, armed two-step view deletion, the card reorder putting App defaults and
Views above General/Excluded, and claims honored by the monitor-hotplug
revive path). The minor batch landed too: a visible spacing hint line, honest
gap-coercion display on the steppers, "Update…" labels when a rule already
exists, mini SVG slot previews on rule rows, the General→Views
cross-reference, aligned capture verbs, press-and-hold stepper repeat,
dead-space repair after `setSpacing`/`setMonitors` (plus a spanning grid in
the fuzz harness), constructor-side config normalization, a pause-frozen
claim window, and the refreshed security-review inventory.

Deliberately **not** done:

- **Clamping the gap stepper's maximum to the largest non-coerced value.**
  The critique offered this as an alternative to showing the coerced value;
  showing it won. A hard clamp is wrong here because the cap is a function of
  the *current* dims: a user who wants 48px on a grid they are about to make
  coarser would find the stepper refusing a value that becomes legal one
  click later, with no explanation. The stepper now reads "64px → 41px" with
  a hint naming the cap, so the number on screen never disagrees with the
  editor or the desktop, and lowering the column count immediately restores
  the full gap.
- **Debouncing the live re-apply behind the steppers.** Press-and-hold makes
  the 0–64 range one gesture, but it does not reduce the number of full
  re-layouts — each step still re-applies the grid. Coalescing them would buy
  smoothness at the cost of the thing that makes spacing legible in the first
  place (spec v0.2 §1: "changing either value live re-applies the grid in one
  batch"), and `flush()` already emits only the tiles whose rect actually
  changed. Revisit only if a real desktop with many windows visibly stutters
  under a held button — it is a P0 line item in the v0.2.0 smoke pass.
- **A grid-accurate preview for all-grids app rules.** The rule-row miniature
  draws an `gridId: null` rule against the first enabled grid's dims, because
  such a rule genuinely has no single home and its slot re-clamps per grid.
  Drawing one miniature per grid would turn a one-line list row into a
  gallery; the text summary remains the authoritative, accessible label and
  the scope chip already says "All grids".
- **Non-resizable windows and spanning dead space.** `desiredRect` keeps a
  non-resizable window's own size and clamps it into the grid's *effective*
  area, so an oversized window pinned near an L-shaped union's seam can still
  overhang dead space even though its slot is usable. Fixing it properly
  means either shrinking such windows (which the "position-snap only" rule
  forbids, spec §5.4) or a nearest-fully-covered-position search that has no
  answer when the window is wider than every covered strip. Same drift class
  as the accepted external-move item above; the fuzz gate's spanning
  invariants are therefore stated over in-flow tiles and cell usability
  rather than over every emitted rect.

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
build environment has no interactive GUI). **This list is now the
release-gating script [`smoke-test-v0.1.0.md`](smoke-test-v0.1.0.md) — the
v0.1.0 tag must not be cut before its P0 items pass:**

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

**v0.2.0 carries the same gate forward.** The spacing / app-defaults / views
work adds its own GUI-only checks — plus the v0.1.0 regression items the
pixel-rect changes touch — in
[`smoke-test-v0.2.0.md`](smoke-test-v0.2.0.md). Everything in it is
logic-tested (330 vitest + 130 cargo tests) and, exactly as at v0.1.0, none
of it has been seen by a human from this build environment. The `v0.2.0`
commit and tag mark the code and the built installer; **the P0 pass is still
owed and gates handing that installer to anyone.** Record the results
(pass/fail per item, machine specs, monitor topology) against the tag.

## Scrolling / canvas tile overflow (site-only, hidden)

The marketing demo (`site/demo/index.html`) grew a second grid setting, **Tile
overflow**, orthogonal to the re-order logic: what happens when a rearrangement
needs room the board does not have. Two of its five values ship —

- **Tiles drop** — the spill falls off the board in reading order (this is what
  the app already does when a grid is full: the window floats).
- **Restricted** — nothing may leave the board; a move that would cost a window
  is refused instead.

— and three are **implemented, working, and deliberately hidden** behind
`hidden` attributes on their `<option>`s:

- **Scroll vertical** / **Scroll horizontal** — the board keeps its columns,
  rows and tile proportions, and the spill continues past one edge; you scroll
  to it, carousel-style. Cell size never recomputes, so tile aspect is
  preserved.
- **Canvas** — both axes at once, with drag-to-pan and Ctrl+wheel zoom.

**Why they are hidden rather than shipped or deleted.** Scrolling only means
something when the board sits inside a viewport *smaller than the board*. That
is true of a web page and false of a desktop: the monitor already is the
viewport, so there is nowhere for the board to continue to. The honest options
on a real desktop were to minimize the overflow, to park windows off-screen, or
to page across Windows virtual desktops — the first loses the "still there, just
aside" feel, the second is a support trap (invisible live windows the user
cannot recover if Griddle is paused or removed), and the third rests on an
undocumented COM API that breaks between Windows builds.

The site demos the app. A setting the app cannot honour would make it a brochure
instead, so the three come out of the selector until the app can back them.

**They are not dead code.** `extent()`, the carousel offset in `cellRect()`,
cell snapping, panning and zooming all still run, and the two shipped modes go
through the same paths (`extent()` simply returns the visible page). Restoring
the feature on the site is deleting three `hidden` attributes.

**What would unblock shipping it:** virtual-desktop paging in the app — one
board page per Windows virtual desktop, so "scrolling" is switching desktops and
every window stays visible, alt-tab-able and on the taskbar. That is the only
one of the three approaches where an off-page window is never a window the user
has lost.

## Settings.svelte component split (2026-08-20)

`apps/desktop/src/routes/settings/Settings.svelte` is ~2900 lines. The
minimap pop-out (spec 2026-08-20) added tab gating, which marks clean seams
for `DisplayTab` / `AddGridTab` / `PreferencesTab`, and the prop surface is
small because the tab bodies can call the global `emitSettings*` helpers
directly rather than receiving handlers.

The blocker is CSS, not markup: Svelte scopes `<style>` per component, and
that file's ~800 lines of class rules are what the extracted markup is
styled by. A split must also move the shared rules into `settings.css`
(currently tokens only) and leave component-local rules behind, verifying
each surface visually. Mechanical, wide, zero user-visible benefit — do it
deliberately, with screenshots before and after, not alongside feature work.

## GridEditor is aspect-locked, not responsive (2026-08-20)

`GridEditor.svelte` computes its layout once at init from a hardcoded
`EDITOR_W = 632`, mirroring the monitor's aspect ratio. The settings pop-out's
default height is therefore tuned to the map a 16:9 display produces (~348px).
Displays with other aspect ratios, or a taller taskbar, make the map taller
than the default window and the page scrolls — correct, but not tidy, and the
window is resizable so the user can fix it.

The real fix is making the editor size to its container (measure the width,
cap by available height, preserve aspect) instead of a constant. It was not
done here because the component carries an editor/desktop parity guarantee —
"what the editor shows is exactly what the desktop gets" — and it deliberately
reads props once at init, with the parent remounting it on config change.
Making it responsive means reworking that contract, which deserves its own
pass with parity tests rather than a size tweak mid-session.
