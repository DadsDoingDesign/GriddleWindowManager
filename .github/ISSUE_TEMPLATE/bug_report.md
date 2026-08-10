---
name: Bug report
about: Something in Griddle Window Manager behaves wrongly
title: ''
labels: bug
assignees: ''
---

<!--
Do NOT report security vulnerabilities here — see SECURITY.md for private
reporting via the Security tab.

Most window-manager bugs are geometry bugs: they reproduce on one monitor
arrangement and not another. The environment section below is not boilerplate,
it is usually the thing that makes the bug reproducible.
-->

## What happened

<!-- What you saw. If a window went somewhere wrong, say which window and where. -->

## What you expected

## Steps to reproduce

1.
2.
3.

<!-- A screen recording of the drag/snap is worth a lot here — attach one if you can. -->

## Environment

**Griddle Window Manager version:**
<!-- e.g. 0.2.0 — Settings → General, or the installer filename -->

**Windows build:**
<!-- Win+R → `winver`, e.g. Windows 11 Pro 24H2 (build 26100.2314) -->

**Monitor setup:** <!-- fill in one row per monitor -->

| # | Resolution | DPI scaling | Orientation | Primary? |
| --- | --- | --- | --- | --- |
| 1 |  | % |  |  |
| 2 |  | % |  |  |

<!-- DPI scaling is Settings → System → Display → "Scale". Mixed scaling
     across monitors is a common trigger — please report it accurately. -->

**Grid affected:**

- Grid size (columns × rows):
- Grid mode: <!-- Tile (stored as `collision`) or Stack (stored as `overlay`) -->
- Spanning grid (one grid across multiple monitors)? <!-- yes / no -->
- Gap / padding values: <!-- e.g. gap 8, padding 0 -->

**Application(s) whose windows misbehave:**
<!-- Executable names, e.g. chrome.exe, WindowsTerminal.exe.
     Note if the window is elevated (running as admin) — elevated windows are
     unmanageable by design. -->

## Does it reproduce with a fresh config?

<!-- Please check. This separates real bugs from stale/corrupt config, and it is
     the single most useful line in the report.

     To test: quit Griddle Window Manager from the tray, rename
     %APPDATA%\griddle-wm\config.json to config.json.bak, relaunch, set up a
     minimal grid, and try again. Restore the .bak afterwards to get your grids,
     templates, app defaults and views back. -->

- [ ] Yes — reproduces with a fresh config
- [ ] No — only with my existing config (please attach or paste the relevant
      part of `config.json`; it contains grid geometry and executable names, no
      credentials)
- [ ] Haven't tested

## Anything else

<!-- Was the app paused? Did it start at login? Did you just hotplug a monitor,
     dock/undock, change scaling, or apply a view or template? Log output from
     `npx tauri dev` if you build from source. -->
