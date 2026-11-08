# v0.3.1 human smoke pass — release gate

v0.3.1 is a patch release: one field fix and a dependency refresh. It adds no
features, so this file only covers what changed. It **does not replace**
[`smoke-test-v0.3.0.md`](smoke-test-v0.3.0.md) or
[`smoke-test-v0.2.0.md`](smoke-test-v0.2.0.md); their P0 sections still gate a
release that touches the areas they cover.

Build under test:
`apps/desktop/src-tauri/target/release/bundle/nsis/Griddle Window
Manager_0.3.1_x64-setup.exe` from `npm run tauri:build`
(or `npm run tauri:build:local` when you do not hold the signing key).
Install it over your previous copy; do not run the exe from `target/`.

What changed:

- **Overlay click-through (field bug, 2026-11-07).** The per-monitor drag
  overlay lost `WS_EX_TRANSPARENT` after its first show/hide, because tao
  rewrites the whole extended style from its own flags on every visibility
  change. Any missed hide then left an invisible, click-eating window over a
  whole monitor. The overlay now uses tao's own ignore-cursor-events flag,
  hides by label, hides on any display-topology change, and a 6 s watchdog
  hides one that outlives its drag.
- **Dependencies.** The updater no longer builds its unused `zip` feature;
  rustls, svelte, devalue, vite and vitest were bumped for Dependabot alerts.

---

## P0 — overlay never swallows clicks

- [ ] **Drag preview still shows.** Drag a window over a gridded monitor; the
      grid preview appears under the cursor and tracks it.
- [ ] **Clicks pass through mid-drag.** While the preview is up, the windows
      beneath it are visible and the overlay does not take focus.
- [ ] **Release hides it.** Drop the window; the preview disappears within
      about a second and every part of that monitor takes clicks again.
- [ ] **Repeat drags.** Do five drags in a row on the same monitor. After the
      last one, click the desktop, the taskbar and a window title bar on that
      monitor; all three respond. (The v0.3.0 bug only appeared from the
      second drag on.)
- [ ] **Display change mid-session.** With a preview showing, unplug or
      disable a monitor (or change its scaling). No overlay is left behind on
      any remaining display, and the next drag still shows a preview.
- [ ] **No ERROR lines.** After the session, `%APPDATA%\griddle-wm\logs\griddle-wm.log`
      carries no `overlay ... missing WS_EX_TRANSPARENT` ERROR line.

## P0 — updater after dropping `zip`

- [ ] **0.3.0 → 0.3.1.** With v0.3.0 installed and the update check enabled
      in Settings, the app offers v0.3.1, installs it, and relaunches on the
      new version. This is the path the v0.3.0 client still takes with its own
      (zip-capable) updater.
- [ ] **`latest.json` points at the raw installer.** The release's
      `latest.json` `windows-x86_64.url` ends in `_x64-setup.exe`, not
      `.zip`. A v0.3.1 client can only install a raw NSIS exe now; a
      zip-wrapped payload would fail to install.

## P1 — regressions worth a glance

- [ ] Templates, app defaults and views still apply as they did in v0.3.0.
- [ ] Settings window opens from the tray and all panels render.
- [ ] Run `powershell -File scripts/log-lint.ps1` after the session.
