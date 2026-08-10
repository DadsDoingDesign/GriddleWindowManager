<!--
Thanks for contributing to Griddle Window Manager.
Please read CONTRIBUTING.md first — the three architecture rules there are what
this review will be against.
-->

## What

<!-- What this change does, in a sentence or two. -->

## Why

<!-- The problem it solves. Link the issue if there is one: "Fixes #123". -->

## How tested

<!-- Paste the tail of each run, or say plainly which you ran. -->

```
npm run test -w packages/brain
cargo test          # from apps/desktop/src-tauri
npm run build -w apps/desktop
```

<!-- New behaviour should come with new tests. Brain logic goes in
     packages/brain/test/; Rust logic in a #[cfg(test)] module beside the code. -->

**New/changed tests:**

## Smoke pass

<!-- Required if this change can move a real window, redraw the overlay, alter
     the settings editor, or touch the tray / hotkey / pause path. Say which
     items of docs/smoke-test-v0.2.0.md you ran, on what hardware, and what you
     saw. Delete this section only if the change is genuinely GUI-neutral. -->

- Items run:
- Monitor setup used (count / resolution / DPI scaling):
- Result:

## Checklist

- [ ] `npm run test -w packages/brain` is green
- [ ] `cargo test` (from `apps/desktop/src-tauri`) is green
- [ ] `npm run build -w apps/desktop` succeeds
- [ ] No secrets, keys or `.env` files in the diff (the updater signing key
      lives outside the repo, in `~/.griddle-wm-keys/`)
- [ ] No generated output committed (`dist/`, `target/`, `node_modules/`)
- [ ] GUI-affecting change: relevant `docs/smoke-test-v0.2.0.md` items were run
      by a human, and results are noted above — or the change is GUI-neutral
- [ ] `packages/brain` still has zero Tauri and zero DOM imports
- [ ] No `SetWindowPos` / `DeferWindowPos` on managed windows outside
      `actuator.rs`
- [ ] IPC change (if any) lands in **both** `packages/brain/src/types.ts` and
      `apps/desktop/src-tauri/src/ipc.rs`, and a new command has a
      `guard.rs` policy entry plus its test
- [ ] Bundle identifier (`dev.griddle.wm`) and config directory
      (`%APPDATA%\griddle-wm\`) are unchanged
- [ ] User-visible change: `README.md` updated
