# Security Review — Griddle Window Manager

Reviewed at v0.1.0; re-checked through v0.2.0 and the opt-in updater.

Review date: 2026-08-08. Fixes landed: 2026-08-09.
Scope: `apps/desktop/src-tauri` (Rust shell), `apps/desktop/src` (webviews),
capability/CSP configuration, against spec §7 (security model) in
`docs/superpowers/specs/2026-08-08-griddle-window-manager-design.md`.

Verification after fixes: `cargo test` in `apps/desktop/src-tauri`
(109 tests, includes the new regression tests below), `npm run test -w
packages/brain` (178 tests), `npm run check -w apps/desktop` (0 errors).

## What changed since the v0.1.0 review

Re-checked twice. First on 2026-08-09 against the v0.2.0 feature work
(spacing / app rules / startup views), then on 2026-08-10 against the
opt-in updater (`ca120be`), which is the change that actually moved this
app's security posture. Read the findings below with these deltas applied:

* **Four commands were added after the review's fix commit**, all of them
  routed through the same `guard.rs` default-deny policy: `window_is_tracked`
  and `brain_alive` (v0.1.0 hardening, `main` only), and `set_update_status`
  and `set_update_handoff` (updater, `main` only). The table under finding 1
  is the current 15-command surface, not the 11 the review found.
* **One new capability file**, `apps/desktop/src-tauri/capabilities/updater.json`,
  granting `updater:default` and `process:allow-restart` to the `main` window
  and to no other. Two capability files have been added since the review, and
  this is the only one that *widens* anything (`capabilities/overlay.json`,
  minor finding 3, narrowed overlay webviews instead).
  Rationale: the brain host is the only window that owns the
  config toggle, the 24 h clock, and the persist-then-freeze handoff the
  installer needs; the settings window asks for a check by *event* and holds no
  updater handle, so a compromised settings page cannot start a download;
  overlay webviews are excluded entirely. `process:allow-restart` rather than
  `process:default` — the app is relaunched after an install, never asked to
  exit.
* **The CSP was widened** from `default-src 'self'` to
  `default-src 'self'; connect-src 'self' https://github.com https://objects.githubusercontent.com`.
* **No new Rust-side event handlers.** The webview↔webview event surface did
  grow; see the refreshed residual-risk inventory under finding 2.

The v0.1.0 conclusion of finding 6 ("no network access") no longer holds and
has been rewritten in place rather than left standing.

Re-check verification (2026-08-10): `cargo test` in `apps/desktop/src-tauri`
(130 tests), `npm run test -w packages/brain` (330 tests),
`npm run build -w apps/desktop` (clean).

## Fixed — important findings

### 1. IPC command surface / least privilege (`capabilities/default.json`, all command modules)

**Issue.** Tauri v2's capability ACL does not gate app-defined commands, so
every webview — including the always-running click-through overlay webviews —
could invoke the full 11-command surface registered in `lib.rs`
(`apply_layout`, `write_config`, `set_paused`, `update_tray`, ...). No command
inspected the calling window's label.

**Fix.** New module `src/guard.rs`: a pure, default-deny, per-window command
policy (`caller_allowed` / `authorize`). Every `#[tauri::command]` now takes
the calling `tauri::Window` and authorizes its label before doing any work
(labels are assigned by Rust at window-creation time and cannot be spoofed by
webview content).

The table below is the **current** policy (`guard::caller_allowed`), not the
one as of the review: four commands have been added since, and each was added
to the policy and to `guard::tests::ALL_COMMANDS` in the same commit.

| Command | Allowed caller labels | Added |
| --- | --- | --- |
| `apply_layout`, `focus_window`, `write_config`, `update_tray`, `show_overlay`, `hide_overlay` | `main` (brain host) only | v0.1.0 |
| `window_is_tracked` | `main` only | v0.1.0, after the review (`7a3e31f`) |
| `brain_alive` | `main` only | v0.1.0, after the review (`55a0224`) |
| `set_update_status`, `set_update_handoff` | `main` only | updater (`ca120be`) |
| `read_config`, `set_paused`, `show_settings`, `list_windows` | `main`, `settings` | v0.1.0 |
| `list_monitors` | `main`, `settings`, `overlay-*` (overlays draw the grid) | v0.1.0 |

The two updater commands are `main`-only for a specific reason: `set_update_status`
puts the "update available" entry in the tray, and `set_update_handoff` freezes
window management and lets the brain window die for the installer. Neither may be
reachable from the settings page, or a compromised settings webview could fake an
offer or wedge the window manager without an installer ever arriving.

Denials are logged; commands returning `Result` return a descriptive `Err`,
`()`/collection commands no-op / return empty.

**Regression tests.** `guard::tests` (5 tests): main allowed everywhere,
settings restricted to reads + shell toggles, overlays restricted to
`list_monitors`, unknown labels/commands denied, error message shape.

### 2. Event spoofing between webviews (`src/routes/brain/host.ts`, `config.rs`)

**Issue.** Tauri events carry no sender identity; the brain host listened
with broadcast `listen`, so any webview could forge tracker events. Concrete
abuses: a forged `paused-changed: true` was persisted by the brain's debounced
save while the live Rust `PAUSED` flag stayed `false` (UI/disk claim paused,
actuation continues; next launch seeds genuinely paused from the poisoned disk
value); a forged `window-destroyed` for a real managed hwnd made the brain
drop that window's tile.

**Fix (two layers, Rust authority wins).**

* `config.rs::enforce_authoritative_fields` — `write_config` now re-stamps
  `config.paused` from the live `shell::is_paused()` flag before anything is
  persisted. A poisoned webview copy can no longer reach disk, so the
  next-launch pause seed always reflects a state the user actually chose via
  `set_paused` (tray/settings). Mismatches are logged.
* `host.ts::confirmedWindowDestroyed` — before freeing a slot on
  `window-destroyed`, the brain host confirms against a fresh Rust-side
  `list_windows` sweep (which re-seeds the tracker's live set from the actual
  desktop). Events naming a still-live hwnd are ignored and logged; if the
  sweep itself fails the event is trusted (leaking a dead tile is worse than
  dropping one that the next appearance re-adds).

**Regression test.**
`config::tests::write_persists_the_authoritative_pause_flag_not_the_submitted_one`.

**Residual risk (accepted, same trust domain).** All webviews are first-party
pages served from `frontendDist` behind a `default-src 'self'` CSP (widened
since the updater to allow `connect-src` to the two GitHub release origins —
see finding 6); there is no route for third-party content. Within that trust
domain, a compromised webview
could still forge cosmetic/bounded events: `state-snapshot` (spoofs the
settings UI display only), `movesize-end`/`drag-pos` (can cause a re-tile of a
*managed* window — actuation stays bounded by the Rust tracked-set +
actuation-time identity re-verification, so arbitrary handles can never be
moved; spec §7 holds). Full event-sender authentication is not expressible in
Tauri v2's event system; the command surface (which is where side effects
live) is label-gated per finding 1.

*Inventory refresh (v0.2.0, 2026-08-09.)* The v0.2.0 feature work adds **no**
`#[tauri::command]`s — `guard.rs` is unchanged by it — but it does add eight webview↔webview
`settings-*` events the brain host acts on, and forgeable ones now reach
further than "cosmetic":

| Event | Forged effect |
| --- | --- |
| `settings-set-spacing` | re-spaces one grid (bounded: integers clamped to 0–64, cells never smaller than 16 px) |
| `settings-set-app-rule` / `settings-remove-app-rule` | adds/removes a placement rule; **persisted** by the host's debounced `write_config`. Never moves a live window (rules fire on `window-appeared` only) |
| `settings-capture-view` / `settings-rename-view` / `settings-delete-view` | adds/renames/removes a stored view; persisted |
| `settings-set-startup-view` | changes which view is applied at next launch; persisted |
| `settings-apply-view` | **re-tiles the whole desktop** — reconfigures every grid in the view and re-places the current window sweep |

This is the same class as v0.1.0's `settings-enable-grid` /
`settings-set-dims` / `settings-set-exclusions` (already able to re-tile
everything and to persist), so the posture is unchanged: the blast radius is
still "rearrange the user's own managed windows and rewrite their own config",
never arbitrary window handles or arbitrary files. Two properties keep it
bounded, and both still hold in v0.2.0: (a) actuation goes through
`apply_layout`, which is `main`-only and validates every hwnd against the
tracker's live set with actuation-time identity re-verification; (b)
`write_config` is `main`-only and re-stamps the authoritative `paused` flag.
The acceptance stands — the entry above is refreshed only so the inventory
backing it is not stale.

*Inventory refresh (updater, 2026-08-10.)* The updater adds two commands
(`set_update_status`, `set_update_handoff`, both `main`-only per finding 1)
and four more webview↔webview events. Three of them travel settings → brain
host and are the first forgeable events that can reach the network or the
installer, so they are worth stating individually:

| Event | Forged effect |
| --- | --- |
| `update-state` | brain host → settings; renders the Updates card. Forging it misreports update status in the settings UI. Cosmetic |
| `settings-check-updates` | one HTTPS GET of the fixed release feed, at most. Deliberately not gated on the opt-in toggle (the click *is* the consent), so a forged one is a network request the user did not ask for — bounded to the build-time endpoint, no attacker-chosen URL, no payload |
| `settings-install-update` | **nothing, unless the user already confirmed an offer.** `installNow` requires a live `Update` handle *and* `canInstall(state)`; a forged event with no pending offer finds neither. When an offer is genuinely on the table it downloads and installs it — the same artifact, signature-checked, that the user was already looking at |
| `settings-dismiss-update` | drops a pending offer and closes its handle. Denial of an update, not installation of one |

The bound that matters is that none of these can change *what* is fetched or
*what* is installed: the endpoint is baked into `tauri.conf.json` at build
time and the package must verify against the pinned minisign public key. The
worst a forged event achieves is an unrequested check, or an install the user
had already been offered. Blast radius unchanged in kind.

### 3. Actuator handle reuse (`actuator.rs`, `tracker.rs`)

**Issue.** Eligibility was not re-verified at actuation time: `apply_moves` /
`focus` only checked `IsWindow` after the live-set lookup. Windows recycles
HWND values quickly and the `EVENT_OBJECT_DESTROY` hook is asynchronous
(`WINEVENT_OUTOFCONTEXT`), so a stale live-set entry could briefly denote a
different window — potentially one the eligibility filter would reject (tool
window, excluded exe, another process's popup) — and the actuator would move
or focus it.

**Fix.** `tracker::verify_for_actuation(key)` runs immediately before every
move (`actuator::win::apply_moves`) and focus (`actuator::focus_validated`):
it re-probes the handle and requires (a) the owning exe to match the tracked
`WindowInfo` (`tracker::probe_matches_tracked` — a recycled handle belongs to
a different process/exe) and (b) the probe to still pass structural
eligibility (visible, top-level, uncloaked, not `WS_EX_TOOLWINDOW`,
captioned, not excluded — exclusions are re-read live). Failures take the
existing dead-handle path: untrack + `window-destroyed`. Cost is one
`OpenProcess`/`QueryFullProcessImageNameW` per moved window.

The own-pid eligibility rule is re-applied with a sentinel pid (`u32::MAX`,
never a real Windows pid): our own windows can never enter the tracked set
(snapshot/hook paths use the real pid, and our overlays additionally carry
`WS_EX_TOOLWINDOW`), the exe-identity match rejects handles recycled to our
own process anyway, and the sentinel keeps the check exercisable from
in-process `CreateWindowExW` test windows (`test_windows::track_test_window`
now seeds the tracked info with the process's real exe basename for the same
reason).

**Regression tests.**
`actuator::win_tests::recycled_handle_with_foreign_identity_is_not_moved`,
`actuator::win_tests::recycled_handle_now_a_tool_window_is_not_moved`,
`actuator::win_tests::focus_refuses_a_recycled_handle_and_untracks_it`,
`tracker::win_tests::verify_for_actuation_full_lifecycle`,
`tracker::tests::probe_matches_tracked_requires_the_same_exe`.

### 4. Unsafe FFI / panic safety (`tracker.rs`, `monitors.rs`, `Cargo.toml`)

**Issue.** None of the `extern "system"` callbacks (`win_event_proc`,
`enum_windows_proc`, `enum_proc`, `watcher_wndproc`) guarded against Rust
panics unwinding across the FFI boundary. With `rust-version = "1.77.2"`,
toolchains 1.77–1.80 make that undefined behavior (the guaranteed abort only
landed in 1.81); on ≥1.81 a panic in a hook callback aborts the whole window
manager. The callbacks call into allocating/third-party code (tauri
`Emitter::emit`) outside this crate's control.

**Fix.**

* `Cargo.toml`: `rust-version` raised to `1.81`, so unwind-across-FFI is a
  defined abort at worst, never UB.
* New module `src/ffi_guard.rs`: `guard(context, default, f)` wraps a callback
  body in `catch_unwind(AssertUnwindSafe(...))`, logs the panic payload with
  the callback name, and returns a safe default. All four callbacks now run
  their Rust bodies through it (raw-pointer derefs stay outside the guarded
  closure; `monitors::enum_proc`'s body was factored into the safe
  `push_monitor` helper). One bad event can no longer take down the WM.
  (`AssertUnwindSafe` is sound: every lock in the crate recovers from poison
  via `unwrap_or_else(|p| p.into_inner())`.)

**Regression tests.** `ffi_guard::tests` (4 tests): result pass-through,
default on panic, `&str`/`String`/`panic_any` payloads, no state rollback.

## Noted but accepted — minor findings

These were reviewed and deliberately **not** fixed at the time of the review;
they are tracked here so the acceptance is explicit. Three were fixed later in
the v0.1.0 series and are marked **Fixed** below — the entries are kept rather
than deleted so the record of what was accepted, and then reconsidered, stays
readable.

1. **Input sanity on `apply_layout` geometry** (`actuator.rs`,
   `validated_targets`): hwnds are validated but x/y/width/height are passed
   to `DeferWindowPos` unchecked, so the (trusted, label-gated) brain host
   could park managed windows at unreachable coordinates or degenerate sizes.
   Related: `compensate_target` additions can overflow for extreme values
   (`i32::MAX` widths) — debug-build panic inside the command / release-build
   wrapping — though the command itself no longer accepts non-`main` callers,
   and only tracked windows are affected (self-DoS/misplacement, not
   escalation). *Recommendation on file:* clamp/reject rects that do not
   intersect the virtual desktop, enforce a minimum size, use
   checked/saturating arithmetic.
2. **Config persistence hardening** (`config.rs`): the opaque `layouts` map
   is unbounded in size, and an unparseable `hotkey` string is persisted
   verbatim (`apply_hotkey` keeps the old live binding but the bad value
   re-fails on every launch). *Recommendation on file:* validate `hotkey`
   with `Shortcut::parse` at write time (fall back to `DEFAULT_HOTKEY`), cap
   serialized config size.
   **Partly fixed** — `config::sanitize_hotkey` now rejects an unparseable
   `hotkey` at write time and persists the live binding instead. The unbounded
   `layouts` map is still open.
3. **Overlay capability scope** (`capabilities/default.json`): overlay-*
   windows inherit all of `core:default` (incl. `allow-cursor-position`,
   `allow-get-all-windows`) though they only need `core:event`. Impact is
   reduced by finding 1's command gating (app commands are now label-gated in
   Rust), but the plugin-level split is still worth doing. *Recommendation on
   file:* separate capability file granting overlay-* only
   `core:event:default`.
   **Fixed** (`5e32bda`) — `capabilities/overlay.json` grants `overlay-*` only
   `core:event:default`, and `capabilities/default.json` was narrowed to
   `main` + `settings`.
4. **Concurrent `write_config` temp-file race** (`config.rs`,
   `write_config_to`): the fixed `config.json.tmp` name means two concurrent
   writers can truncate each other's in-progress temp file and promote a
   partially-written file; the corrupt result is quarantined on next read, so
   this degrades to config loss, not corruption-executed-as-data.
   *Recommendation on file:* process-global writer mutex or per-write unique
   temp names.
5. **Lock poisoning consistency** (`overlay.rs:` `ensure_overlay`):
   `registry().lock().expect(...)` is the only lock site that panics on
   poison instead of `unwrap_or_else(|p| p.into_inner())`. A panic elsewhere
   while holding it would turn subsequent `show/hide_overlay` calls into
   panics (now contained per finding 4's guard philosophy, but still worth
   aligning). *Recommendation on file:* adopt the poison-tolerant pattern.
   **Fixed** — `ensure_overlay` now uses
   `registry().lock().unwrap_or_else(|p| p.into_inner())` like every other
   lock site in the crate.
6. **Network access audit** (spec §7). ⚠️ **Rewritten 2026-08-10.** The
   v0.1.0 text here said the app made no network access at all and that
   `reqwest`/`hyper` were unused transitive dependencies of Tauri. Both
   statements were true when written and are false as of `ca120be`. The real
   posture:

   * **The frontend still initiates nothing.** `grep -rn "fetch(\|XMLHttpRequest\|WebSocket\|EventSource" apps/desktop/src`
     is still empty. The updater's JS side (`src/routes/brain/updates.ts`)
     calls `@tauri-apps/plugin-updater`, which crosses the IPC boundary; the
     HTTP happens in Rust, in `tauri-plugin-updater` → `reqwest` → `hyper` →
     `rustls`. `devUrl` remains dev-mode only.
   * **Exactly one destination, fixed at build time.** An HTTPS GET of
     `https://github.com/DadsDoingDesign/GriddleWindowManager/releases/latest/download/latest.json`
     (`tauri.conf.json` → `plugins.updater.endpoints`), and — only after the
     user confirms an offer — the installer artifact that feed names, which
     GitHub serves via a redirect to `objects.githubusercontent.com`. No
     webview, event, or config value can redirect either request: the endpoint
     is compiled into the bundle.
   * **Off by default, and the off state is a pure function.**
     `AppConfig::auto_check_updates` defaults to `false` (`config.rs`), and the
     only two paths to the network are `shouldAutoCheck` and `canCheckNow` in
     `packages/brain/src/updates.ts`, both pure and both pinned by
     `packages/brain/test/updates.test.ts`. With the toggle off, nothing is
     requested unless the user presses "Check now".
   * **Nothing installs without confirmation, and nothing unsigned installs at
     all.** A check only ever produces an offer; download and install require
     `canInstall(state)` plus a live handle. The package is verified against the
     minisign public key pinned in `tauri.conf.json` before it runs.
   * **Capability-scoped.** `capabilities/updater.json` grants `updater:default`
     and `process:allow-restart` to `main` only (see the delta section at the
     top). Settings and overlay webviews cannot reach the plugin.
   * **CSP.** Now `default-src 'self'; connect-src 'self' https://github.com https://objects.githubusercontent.com`.
     Stated honestly: this is a *widening*, and it is not what permits the
     update check — the plugin's fetch is Rust-side and not subject to the
     webview CSP at all. Its effect is that a compromised first-party webview
     may now open connections to those two origins, which `'self'` alone
     forbade. That is a small residual risk accepted for now because the
     origins are declared rather than implicit; narrowing `connect-src` back to
     `'self'` is on file as a recommendation, pending a release-build check that
     no part of the plugin's JS shim performs a webview-side fetch.

   *Release-time checks* (both must hold, and the first replaces the stale
   `cargo tree -i reqwest` gate, which now fails as written):

   ```
   cargo tree -i reqwest -e normal --target x86_64-pc-windows-msvc
   ```
   must show exactly one reverse path —
   `reqwest → tauri-plugin-updater → griddle-wm`. Any other parent means
   something else pulled in an HTTP client and this audit has to be redone.

   ```
   grep -rn "fetch(\|XMLHttpRequest\|WebSocket\|EventSource" apps/desktop/src
   ```
   must be empty: all outbound traffic stays behind the Rust plugin, where the
   endpoint is fixed and the signature check is mandatory.

   The dependencies this pulled in are attributed in
   [`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md), which was
   regenerated for the same reason.

## Dependency advisories — triage

### RUSTSEC-2024-0429 — `glib` unsoundness (not reachable in shipped builds)

GitHub Dependabot reports one moderate advisory against `glib 0.18.5`:
unsoundness in the `Iterator`/`DoubleEndedIterator` impls for
`glib::VariantStrIter`. Affected range is `>=0.15.0, <0.20.0`; the fix landed in
`0.20.0`.

**Assessment: not reachable in anything this project ships.** `glib` is not in
the dependency graph for the target we build. On the Windows target `cargo tree`
prints nothing at all:

```
cargo tree -i glib --target x86_64-pc-windows-msvc     # nothing to print
cargo tree -i glib --target x86_64-unknown-linux-gnu   # glib → atk → gtk →
                                                       # libappindicator →
                                                       # tray-icon → tauri
```

The crate arrives solely through GTK's Linux tray stack. This app is Windows 11
x64 only — the window-tracking half is Win32-specific and there is no Linux
build — so that code is never compiled, linked or shipped.

**It cannot be fixed here.** `gtk 0.18.2` requires `glib ^0.18`, and that gtk is
pinned by `tauri 2.11.5`:

```
cargo update -p glib --precise 0.20.9
error: failed to select a version for the requirement `glib = "^0.18"`
required by package `gtk v0.18.2`
```

A plain `cargo update` does not move it either — there is no semver-compatible
patched version. Resolving the alert requires Tauri to move its Linux GTK stack
to `gtk 0.20`, which is upstream work.

Dependabot reaches the same conclusion by itself and says so on the alert:
*"Dependabot cannot update glib to a non-vulnerable version. The latest possible
version of glib that can be installed is 0.18.5. The earliest fixed version is
0.20.0."* So there is no automated remediation to wait for either.

For completeness on severity: the defect is a NULL-pointer dereference, not
memory corruption. `VariantStrIter::impl_get` passed `&p` where the variadic C
function `g_variant_get_child` mutates the pointer in place, so recent rustc
versions discard the write and `CStr::from_ptr` is handed NULL. The blast radius
is a crash while iterating GVariant strings — on Linux, in code this project
does not build.

**Action:** dismiss the Dependabot alert as *not affected — vulnerable code is
not present in the shipped artifact*, and re-check when the Tauri minor version
moves. If a Linux build is ever attempted, this advisory becomes live and must
be resolved before shipping.
