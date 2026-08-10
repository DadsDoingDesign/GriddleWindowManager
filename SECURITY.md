# Security Policy

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions, or pull
requests.**

Report privately through GitHub:

1. Go to the
   [Security tab](https://github.com/DadsDoingDesign/GriddleWindowManager/security)
   of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker gets out
   of it. A minimal repro — a window label, a payload, a config file — is worth
   more than a description of the class of bug.

If private reporting is unavailable to you for any reason, email
**dev@trustybits.com** with `GriddleWindowManager` in the subject.

### What to expect

This is a small project maintained by one person in their spare time. The
timelines below are what is actually sustainable, not a corporate SLA:

| Stage | Target |
| --- | --- |
| Acknowledgement that the report was received | within **7 days** |
| Initial assessment (valid / not / need more info, and rough severity) | within **14 days** |
| Fix released for a confirmed issue affecting a supported version | best effort, typically within **30 days** of the assessment |

If you have not heard back after 14 days, please ping the same channel — mail
does get lost.

You will be credited in the release notes for the fix unless you ask not to be.
There is no bug bounty; there is no money in this project.

### Coordinated disclosure

Please give a reasonable window before publishing. If a fix is taking longer
than expected, say so and we'll agree on a date rather than letting it drift.
If a report is not a vulnerability, that will be said plainly and you are free
to write about it immediately.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x | ✅ Yes |
| 0.1.x | ❌ No — upgrade to 0.2.x |

Only the latest 0.2.x release receives fixes. There are no long-term-support
branches. Because releases are per-user NSIS installs, upgrading is running the
newer installer; your `%APPDATA%\griddle-wm\config.json` is upgraded in place.

## Threat model

Two things about this app are worth stating plainly before you assess a report.

**1. Griddle Window Manager manipulates other applications' windows.** That is
its entire purpose. It enumerates top-level windows across the desktop, reads
their titles, executable names and geometry, hooks `SetWinEventHook` for
move/size/destroy events, and moves the eligible ones with batched
`DeferWindowPos` calls. Those capabilities are the feature, not the
vulnerability — a report that amounts to "it can move my windows" or "it can
see my window titles" is working as designed.

Deliberate limits on that power:

- The process runs **unelevated**, by design. Windows does not permit a
  non-elevated process to move elevated windows, so admin windows are enumerated
  and then left entirely alone. Griddle Window Manager does not request, and
  should never need, elevation. A change that made it ask for elevation would
  itself be a security regression.
- **No network access in the app's own logic**: no HTTP client of ours, no
  telemetry, no remote assets, and a strict CSP. Window titles never leave the
  machine. The only outbound traffic that can exist is the **opt-in** update
  check (default off), which talks to GitHub and verifies a minisign signature
  against the public key pinned in `tauri.conf.json`.
- Configuration is plain local JSON in `%APPDATA%\griddle-wm\`, written
  atomically. It contains grid geometry, template/view names and executable
  names — no credentials.

**2. The IPC surface is the sensitive part.** The interesting attack surface is
the boundary between the webviews and the Rust shell — not the Win32 code. The
app runs several WebView2 windows (a hidden brain host, the settings window, and
always-on click-through overlays), and Tauri v2's capability ACL does not gate
app-defined commands. A webview that could invoke freely would be able to move
arbitrary windows, rewrite the config, or unpause a paused app.

That surface is defended by a default-deny, per-window authorization policy in
`apps/desktop/src-tauri/src/guard.rs` (window labels are assigned by Rust at
creation time and cannot be spoofed by page content), plus Rust-side
re-stamping of authoritative fields such as the pause flag, and validation of
every hwnd against the tracker's live eligible set before actuation.

**Reports in these areas are the most valuable:**

- Any way for a webview — especially an overlay webview — to invoke a command it
  is not authorized for, or to forge an event the brain host trusts.
- Any way to make the actuator move a window that is not in the tracker's
  eligible set, or to escape the exclusion list.
- Any path that gets attacker-controlled content (a window title, a config
  value, an executable name) executed or interpreted rather than displayed.
- Anything that causes the app to gain, request, or effectively obtain elevated
  privileges.
- Anything that lets an unsigned or attacker-supplied payload pass the updater's
  signature check.
- Memory-safety or panic-across-FFI issues in the Win32 hook callbacks.

The existing analysis of this surface — the fixed findings, and the residual
risks that were consciously accepted — is written up in
[`docs/security-review.md`](docs/security-review.md). Reading it first will tell
you whether something is already known and accepted, and gives you the
vocabulary the fix will be discussed in.
