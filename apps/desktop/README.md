# apps/desktop

The Griddle Window Manager desktop app: a Tauri 2 (Rust) shell hosting Svelte 5 webviews.

- `src/routes/brain/` — the hidden brain host page; runs `@griddle-wm/brain`
  as the single source of layout truth.
- `src/routes/overlay/` — the transparent per-monitor drag overlay (grid
  lines, footprint, ghost previews).
- `src/routes/settings/` — the settings window (grid cards, live editor,
  templates, exclusions, first-run).
- `src-tauri/` — the Rust "hands": window tracker, actuator, monitors, drag
  pump, overlays, tray/hotkey shell, config persistence.

See the [root README](../../README.md) for what the product is and how to
build it, and [`docs/`](../../docs/) for the design spec, plan, security
review, and deferred items.
