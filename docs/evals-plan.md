# Evals across the application — proposal

**Date:** 2026-08-31. Written after the drag-fill / expand / auto-split
batch, when "the suites are green" and "the app works" have again proven to
be different claims.

**Status (same day):** §1–§4 are built. §1: `scripts/boot-smoke.ps1` +
`.github/workflows/boot-smoke.yml` (manual + master pushes). §2:
`fixtures/configs/v1..v9.json`, parsed by `test/config-corpus.test.ts` and
`config.rs::corpus_every_version_loads_and_restamps`. §3:
`test/invariants.test.ts` (seeded; `INVARIANT_SEED=<n>` reproduces). §4:
`scripts/log-lint.ps1` (3-day window by default; `-Days 0` for history) —
whose first run found two live issues: the watchdog respawns the brain host
after every long sleep (wall-clock heartbeat deadline), and a recurring
396x0 rect for one hwnd that the actuator's collapse guard blocks daily.
Both are filed as follow-up tasks; the lint gate stays red until they land.
§5–§6 remain future work.

## What we already have

| Layer | What it covers | Count today |
| --- | --- | --- |
| Brain vitest | All placement logic, drags, previews, persistence, reflow, spanning; fuzz + stress files | 467 tests |
| Rust unit tests | Config migration, guard authorization, tracker eligibility, actuator (incl. real-window tests on Windows) | 153 tests |
| Type gates | `tsc`, `svelte-check`, `cargo check` — contract drift inside one language | every build |
| Human smoke | `docs/smoke-test-*.md` P0 checklists at a real GUI | per release |

## Where releases have actually failed

Every serious defect so far slipped **between** those layers, not inside
one: the WebView2 browser-args invariant made v0.1.0 *and* v0.2.0 dead on
arrival with every suite green; the 0×0-move bug was found by reading three
days of field logs; the settings pop-out's native-select bug only appeared
in the undecorated window. The eval gaps below are ordered by which class
of escape they close.

## Proposed evals, in priority order

### 1. Packaged-boot smoke (closes the DOA class) — highest value

A CI job (or a local script run before tagging) that installs the built
NSIS bundle in a clean Windows environment, launches it, and asserts within
60 s: the tray icon exists, `brain_alive` heartbeats are arriving (readable
from the log), every expected webview spawned, and the log contains no
`ERROR`. This is the only eval that would have caught both DOA releases.
Effort: a PowerShell script + a `windows-latest` workflow job; no new
frameworks.

### 2. Shared config corpus (closes cross-language schema drift)

`fixtures/configs/v1.json … v9.json` — real files as each release wrote
them — loaded by BOTH loaders in their own suites: persist.ts asserts
sanitize + re-serialize, config.rs asserts serde + re-stamp, and each
asserts the other's output parses. Today the two loaders are tested against
hand-built JSON that lives in each language separately; v8/v9 touched five
files and nothing would catch a spelling mismatch between them. Effort:
small; mostly moving existing fixtures into files.

### 3. Placement invariants as property tests (protects the new behaviors)

The fuzz harness exists; add invariants for everything this week shipped,
checked over randomized grids/windows/drag paths:

- a fill footprint never overlaps an in-flow tile and never sits below the
  window's min cells;
- auto-split leaves both tiles at or above their mins, exactly tiling the
  victim's old span;
- expand → maximize → expand returns the original slot (toggle round-trip);
- preview footprint always equals commit slot (WYSIWYG, the invariant the
  whole codebase is built on — currently asserted only in examples).

### 4. Log-lint eval (turns field logs into a regression suite)

A script over `%APPDATA%/griddle-wm/logs` that counts: zero-sized or
off-screen moves, `WM_SETTINGCHANGE` frequency (the OS-sync storm rule),
watchdog respawns, refusal rates, `ShowWindowAsync declined`. Run it after
every dogfooding session; thresholds become assertions. The 2026-08-21/22
log reviews each found a real bug — this automates the reading.

### 5. Settings-panel rendering eval (closes the GUI-pixels gap, later)

The panel can't run outside Tauri because `window.__TAURI_INTERNALS__` is
absent. A checked-in dev stub (fake `invoke`/`listen` returning canned
config + snapshots) would let Playwright drive the built page in plain
Chromium: screenshot-diff the Preferences tab, both themes, the tab row,
the pickers open and closed. Same stub unlocks overlay rendering evals fed
canned `PreviewState`s (footprint, ghosts, refusal, bands).

### 6. Drag-path scenario runner (nice-to-have)

A table-driven harness replaying recorded drag traces (cursor samples +
rects from real sessions) through the brain and asserting final layouts —
the bridge between unit tests and the human smoke pass. Recordings come
free from a debug flag that dumps `DragPos` streams.

## What I would NOT build

- End-to-end UI automation of real window dragging on a live desktop —
  brittle, slow, and the brain-side scenario runner covers the logic while
  the packaged-boot smoke covers the plumbing.
- Coverage-percentage gates — the escapes were never in uncovered lines.

## Suggested order

1 and 2 before the next release tag (they gate the release itself), 3 and 4
as ongoing hygiene, 5 when the panel next gets heavy design work, 6 when a
drag-feel bug next survives the suites.
