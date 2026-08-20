//! Per-window command authorization (security review 2026-08-08, finding
//! "IPC command surface / least privilege"; see docs/security-review.md).
//!
//! Tauri v2's capability ACL scopes *plugin* permissions per window, but it
//! does not gate app-defined `#[tauri::command]`s at all: every webview that
//! can invoke anything can invoke everything registered in `lib.rs`. The
//! always-running click-through overlay webviews only need events, yet
//! without this module they could call `apply_layout`, `write_config`,
//! `set_paused`, ... . This module is the missing per-window policy: every
//! command passes its calling window's label through [`authorize`] before
//! doing any work.
//!
//! The policy mirrors the legitimate callers in the frontend
//! (`src/lib/ipc.ts` call sites):
//!
//! * brain host (label `main`) — the sole caller of actuation, persistence,
//!   tray and overlay-lifecycle commands (`host.ts`);
//! * settings window (label `settings`) — reads (`list_windows`,
//!   `list_monitors`, `read_config`) and shell toggles (`set_paused`,
//!   `show_settings`);
//! * overlay windows (labels `overlay-<n>`) — only `list_monitors`, needed
//!   to draw the grid; everything else is event-driven.
//!
//! Labels are assigned by Rust at window-creation time (`lib.rs`,
//! `shell::open_settings`, `overlay::ensure_overlay`) and cannot be spoofed
//! by webview content, so they are a sound authority for least privilege.

/// Label of the hidden brain-host window (`tauri.conf.json`).
pub const MAIN_LABEL: &str = "main";
/// Label of the settings window (`shell::SETTINGS_LABEL`).
pub const SETTINGS_LABEL: &str = "settings";
/// Prefix of overlay window labels (`overlay::ensure_overlay`).
pub const OVERLAY_LABEL_PREFIX: &str = "overlay-";

/// Pure policy: may a webview with window label `label` invoke `command`?
/// Unknown commands and unknown labels are always denied (default-deny).
pub fn caller_allowed(command: &str, label: &str) -> bool {
    let main = label == MAIN_LABEL;
    let settings = label == SETTINGS_LABEL;
    let overlay = label.starts_with(OVERLAY_LABEL_PREFIX);
    match command {
        // Brain-host only: window actuation, config persistence, tray state,
        // overlay lifecycle and event vetting (host.ts is their sole
        // legitimate caller).
        // (`set_update_status` drives the tray's update entry and
        // `set_update_handoff` freezes the shell for the installer handoff —
        // both belong to the update driver, which lives in the brain host.)
        "apply_layout" | "focus_window" | "minimize_window" | "write_config" | "update_tray" | "show_overlay"
        | "hide_overlay" | "window_is_tracked" | "brain_alive" | "set_update_status"
        | "set_update_handoff" => main,
        // Brain host + settings UI.
        "read_config" | "set_paused" | "show_settings" | "list_windows" => main || settings,
        // Overlays additionally need the monitor list to draw their grid.
        "list_monitors" => main || settings || overlay,
        _ => false,
    }
}

/// Command-guard entry point: `Ok(())` when the caller is allowed, otherwise
/// a logged, stringly-typed error suitable for returning straight out of a
/// `#[tauri::command]`. Commands that return `()` should early-return on
/// `Err` instead.
pub fn authorize(command: &str, label: &str) -> Result<(), String> {
    if caller_allowed(command, label) {
        Ok(())
    } else {
        log::warn!("{command}: denied for caller window {label:?} (least-privilege policy)");
        Err(format!("{command} is not permitted from window {label:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_COMMANDS: [&str; 15] = [
        "list_windows",
        "list_monitors",
        "apply_layout",
        "focus_window",
        "show_overlay",
        "hide_overlay",
        "read_config",
        "write_config",
        "set_paused",
        "show_settings",
        "update_tray",
        "window_is_tracked",
        "brain_alive",
        "set_update_status",
        "set_update_handoff",
    ];

    #[test]
    fn main_may_invoke_every_command() {
        for cmd in ALL_COMMANDS {
            assert!(caller_allowed(cmd, MAIN_LABEL), "{cmd} from main");
            assert!(authorize(cmd, MAIN_LABEL).is_ok());
        }
    }

    #[test]
    fn settings_gets_reads_and_shell_toggles_only() {
        for cmd in ["read_config", "set_paused", "show_settings", "list_windows", "list_monitors"] {
            assert!(caller_allowed(cmd, SETTINGS_LABEL), "{cmd} from settings");
        }
        for cmd in [
            "apply_layout",
            "focus_window",
            "write_config",
            "update_tray",
            "show_overlay",
            "hide_overlay",
            "window_is_tracked",
            "brain_alive",
            // The settings window asks for updates by *event* (the brain host
            // owns the driver); it must not be able to fake a tray offer or
            // freeze the shell for an installer that is not coming.
            "set_update_status",
            "set_update_handoff",
        ] {
            assert!(!caller_allowed(cmd, SETTINGS_LABEL), "{cmd} must be denied for settings");
            assert!(authorize(cmd, SETTINGS_LABEL).is_err());
        }
    }

    #[test]
    fn overlays_may_only_list_monitors() {
        for label in ["overlay-0", "overlay-1", "overlay-31337"] {
            assert!(caller_allowed("list_monitors", label), "{label}");
            for cmd in ALL_COMMANDS {
                if cmd != "list_monitors" {
                    assert!(!caller_allowed(cmd, label), "{cmd} must be denied for {label}");
                }
            }
        }
    }

    #[test]
    fn unknown_labels_and_commands_are_denied() {
        for label in ["", "Main", "MAIN", "settings2", "overlay", "evil"] {
            for cmd in ALL_COMMANDS {
                assert!(!caller_allowed(cmd, label), "{cmd} from {label:?}");
            }
        }
        assert!(!caller_allowed("no_such_command", MAIN_LABEL));
        assert!(authorize("no_such_command", MAIN_LABEL).is_err());
    }

    #[test]
    fn error_message_names_command_and_label() {
        let err = authorize("write_config", "overlay-0").unwrap_err();
        assert!(err.contains("write_config"), "{err}");
        assert!(err.contains("overlay-0"), "{err}");
    }
}
