# Security Review — Griddle Window Manager v0.1.0

Review date: 2026-08-08. Fixes landed: 2026-08-09.
Re-checked against v0.2.0 (spacing / app rules / startup views) on
2026-08-09: no new commands, no new capability grants, no new Rust-side
event handlers — see the refreshed residual-risk inventory under finding 2.
Scope: `apps/desktop/src-tauri` (Rust shell), `apps/desktop/src` (webviews),
capability/CSP configuration, against spec §7 (security model) in
`docs/superpowers/specs/2026-08-08-griddle-window-manager-design.md`.

Verification after fixes: `cargo test` in `apps/desktop/src-tauri`
(109 tests, includes the new regression tests below), `npm run test -w
packages/brain` (178 tests), `npm run check -w apps/desktop` (0 errors).

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
webview content):

| Command | Allowed caller labels |
| --- | --- |
| `apply_layout`, `focus_window`, `write_config`, `update_tray`, `show_overlay`, `hide_overlay` | `main` (brain host) only |
| `read_config`, `set_paused`, `show_settings`, `list_windows` | `main`, `settings` |
| `list_monitors` | `main`, `settings`, `overlay-*` (overlays draw the grid) |

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
pages served from `frontendDist` behind `default-src 'self'` CSP; there is no
route for third-party content. Within that trust domain, a compromised webview
could still forge cosmetic/bounded events: `state-snapshot` (spoofs the
settings UI display only), `movesize-end`/`drag-pos` (can cause a re-tile of a
*managed* window — actuation stays bounded by the Rust tracked-set +
actuation-time identity re-verification, so arbitrary handles can never be
moved; spec §7 holds). Full event-sender authentication is not expressible in
Tauri v2's event system; the command surface (which is where side effects
live) is label-gated per finding 1.

*Inventory refresh (v0.2.0, 2026-08-09.)* v0.2.0 adds **no**
`#[tauri::command]`s — `guard.rs` is unchanged and the default-deny policy
table above is still complete — but it does add eight webview↔webview
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

These were reviewed and deliberately **not** fixed for v0.1.0; they are
tracked here so the acceptance is explicit.

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
3. **Overlay capability scope** (`capabilities/default.json`): overlay-*
   windows inherit all of `core:default` (incl. `allow-cursor-position`,
   `allow-get-all-windows`) though they only need `core:event`. Impact is
   reduced by finding 1's command gating (app commands are now label-gated in
   Rust), but the plugin-level split is still worth doing. *Recommendation on
   file:* separate capability file granting overlay-* only
   `core:event:default`.
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
6. **Network access audit** (spec §7 "no network"): verified zero
   app-initiated network access — no fetch/XHR/WebSocket in `apps/desktop/src`,
   no HTTP-client crates among the app's own dependencies, CSP
   `default-src 'self'`, `devUrl` is dev-mode only. `reqwest`/`hyper` are
   compiled in solely as unused transitive dependencies of the Tauri
   framework itself (`Cargo.lock`); no code path in this app invokes them.
   *Release-time check:* `cargo tree -i reqwest` should show only `tauri`
   depending on it.
