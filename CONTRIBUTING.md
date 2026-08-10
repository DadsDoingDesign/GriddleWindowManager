# Contributing to Griddle Window Manager

Thanks for looking at this. Griddle Window Manager is a small, Windows-only
Tauri 2 app with a deliberately strict internal shape — most of this document
is about that shape, because a change that respects it is easy to review and a
change that doesn't is usually rewritten.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the [MIT License](LICENSE).

## Prerequisites

Development is **Windows 11 only**. There is no macOS or Linux build, and the
Rust half is Win32-specific, so it will not compile elsewhere.

- **Windows 11** (Windows 10 is untested).
- **[Node.js](https://nodejs.org/) 22 or newer** — the repo uses npm
  workspaces; no pnpm or yarn.
- **[Rust](https://rustup.rs/) stable, ≥ 1.81** with the MSVC toolchain
  (`stable-x86_64-pc-windows-msvc`). 1.81 is the enforced `rust-version` in
  `apps/desktop/src-tauri/Cargo.toml`: from that release, a panic reaching a
  non-unwind `extern "system"` boundary is a defined abort rather than
  undefined behaviour, which the Win32 hook callbacks rely on.
- **Visual Studio 2022 Build Tools** with the **Desktop development with C++**
  workload (this is what supplies the MSVC linker Rust needs). The Windows
  10/11 SDK component that workload installs is also required.
- **WebView2 runtime** — preinstalled on Windows 11.

## Setup

From the checkout root:

```powershell
git clone https://github.com/DadsDoingDesign/GriddleWindowManager.git
cd GriddleWindowManager
npm install
```

## The three commands

Run all three before opening a pull request. CI runs exactly these on
`windows-latest` (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

```powershell
# 1. Layout brain — pure TypeScript, vitest. Fast (~2s).
npm run test -w packages/brain

# 2. Rust shell — cargo, run from the crate root.
cd apps/desktop/src-tauri
cargo test
cd ../../..

# 3. Frontend bundle — vite build of the three webviews.
npm run build -w apps/desktop
```

To run the app itself with devtools:

```powershell
cd apps/desktop
npx tauri dev
```

`npx tauri dev` starts Vite and the Rust shell together. It registers the real
global hotkey and moves your real windows — expect your desktop to be
rearranged while it is running. Use **Pause** (tray menu) to stop actuation
without quitting.

A release build and installer:

```powershell
cd apps/desktop
npx tauri build
# → src-tauri/target/release/bundle/nsis/Griddle Window Manager_<version>_x64-setup.exe
```

Type-checking the Svelte side (not currently run in CI, but useful):

```powershell
npm run check -w apps/desktop
```

## Architecture rules

The app is a "TS brain, Rust hands" split. These three rules are the load-bearing
part of that split; a pull request that breaks one will be sent back.

### 1. `packages/brain` stays pure TypeScript

`packages/brain` is the layout engine and the single source of truth for what
goes where. It must have **zero Tauri imports and zero DOM imports** — no
`@tauri-apps/*`, no `window`, no `document`, no `fetch`, no filesystem. It takes
plain data in (monitor lists, window lists, drag positions) and returns plain
data out (layouts, previews, snapshots).

That purity is why 330 tests run in two seconds with no GUI and no Windows API.
If you find yourself wanting to reach for a Tauri call inside the brain, the
value you want belongs in a parameter or a callback that the host
(`apps/desktop/src/routes/brain/host.ts`) supplies.

### 2. Only `actuator.rs` moves windows

`apps/desktop/src-tauri/src/actuator.rs` is the only module permitted to call
`SetWindowPos` / `DeferWindowPos` on a managed window. Everything else observes.

This is not stylistic. The actuator keeps an *expected-rect ledger* of every
rect it has set, which is how `tracker.rs` and `drag_pump.rs` distinguish a
window move the app caused from one the user caused. A `SetWindowPos` issued
from anywhere else is invisible to that ledger, and the tracker will read it as
a user drag — producing feedback loops and windows that fight you.

If another module needs a window moved, it goes through the actuator.

### 3. IPC changes land in both `types.ts` and `ipc.rs`

The wire contract has two hand-maintained mirrors that must stay identical:

- `packages/brain/src/types.ts` — the TypeScript side.
- `apps/desktop/src-tauri/src/ipc.rs` — the serde side (`#[serde(rename_all =
  "camelCase")]` so field names match verbatim).

Adding or changing a command, an event, or a payload field means editing
**both**, in the same commit. `apps/desktop/src/lib/ipc.ts` is the only place
in the frontend allowed to spell an event or command name; call it, don't
`invoke` directly.

A **new command** additionally needs an entry in
`apps/desktop/src-tauri/src/guard.rs`. That module is a default-deny,
per-window authorization policy: it maps each command name to the window labels
allowed to call it (`main` = brain host, `settings`, `overlay-*`). A command
with no entry is denied for every caller — which is the safe failure, but it
means your feature silently does nothing until you add the policy line and its
test. See [`docs/security-review.md`](docs/security-review.md) finding 1 for
why this exists.

## GUI-affecting changes need a smoke pass

The automated suites cover logic, not pixels. There is no GUI test harness, and
there deliberately isn't one — overlay rendering, drag feel, DPI scaling and
multi-monitor behaviour are verified by a human at a real desktop.

If your change can move a real window, redraw the overlay, alter the settings
editor, or touch the tray/hotkey/pause path, run the relevant sections of
[`docs/smoke-test-v0.2.0.md`](docs/smoke-test-v0.2.0.md) on your own build and
say in the pull request which items you ran and what you saw. "I ran the P0
drag + overlay items on a 2-monitor 150% DPI setup, no regressions" is a useful
review signal; "tests pass" on its own is not, for this class of change.

If your change adds GUI-only behaviour, append its checks to that file.

## Pull requests

- Branch from `master`.
- Keep the change focused; unrelated cleanups in their own commit.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) — it
  asks for what/why, how you tested, and the smoke-pass note above.
- Never commit key material. The updater's signing key lives outside the repo
  (`~/.griddle-wm-keys/`) and `.gitignore` blocks `*.key` / `*.pem` as a second
  line of defence. A leaked private key means anyone can sign a malicious
  update.
- Do not rename the bundle identifier (`dev.griddle.wm`) or the config
  directory (`%APPDATA%\griddle-wm\`). Both shipped in v0.1.0; changing either
  orphans every existing user's grids, templates and app defaults.

## Reporting things

- **Bugs and features**: use the
  [issue templates](https://github.com/DadsDoingDesign/GriddleWindowManager/issues/new/choose).
  The bug template asks for monitor setup and DPI scaling because most window-manager
  bugs are geometry bugs and reproduce only on a particular layout.
- **Security**: do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## A note on `@griddle`

The layout primitives come from [`@griddle/core`](https://www.npmjs.com/package/@griddle/core)
and [`@griddle/svelte`](https://www.npmjs.com/package/@griddle/svelte), a
third-party MIT-licensed library by **Trustybits**
([Trustybits/griddle](https://github.com/Trustybits/griddle)). Griddle Window
Manager is a *consumer* of that library, not its home. Bugs in grid movement or
reflow semantics generally belong upstream; open them there. Local notes on
where the library's edges have been felt live in
[`docs/library-feedback.md`](docs/library-feedback.md).
