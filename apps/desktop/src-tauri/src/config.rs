//! Config persistence (plan Task 12): `%APPDATA%/griddle-wm/config.json`.
//!
//! Writes are atomic: serialize to `config.json.tmp` in the same directory
//! (fsync'd), then rename over `config.json` — `std::fs::rename` maps to
//! `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows, so readers see either
//! the old or the new file, never a torn one. A corrupt (unparseable or
//! wrong-version) `config.json` is quarantined as `config.json.bak` and
//! reported as "no config" so the app starts fresh without destroying the
//! evidence.
//!
//! The path logic is factored over a base directory so tests run against
//! scratch dirs; only the `#[tauri::command]`s touch `%APPDATA%`.

use crate::ipc::AppConfig;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Current config schema version (contract C1, spec v0.2 §4). Version 1
/// files (written by v0.1.0) still load: the fields v2 added all carry
/// `#[serde(default)]`, so a v1 file deserializes with empty defaults and is
/// re-stamped as v2 on read — only *future* versions are quarantined.
const CONFIG_VERSION: u32 = 2;
/// Oldest schema version the migration path accepts.
const MIN_CONFIG_VERSION: u32 = 1;

const CONFIG_FILE: &str = "config.json";
const TMP_FILE: &str = "config.json.tmp";
const BAK_FILE: &str = "config.json.bak";

/// `%APPDATA%/griddle-wm`, or `None` when APPDATA is unset (not a real
/// Windows session; commands degrade to "no config").
pub fn config_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    if appdata.is_empty() {
        return None;
    }
    Some(PathBuf::from(appdata).join("griddle-wm"))
}

/// Read + validate the config under `dir`. Missing file → `None`. Corrupt or
/// unknown-future-version file → quarantined to `config.json.bak`, then
/// `None`. A supported older version (v1) migrates in place: the serde
/// defaults fill the fields it lacked and the version is re-stamped, so the
/// next write persists a v2 file (spec v0.2 §4).
pub fn read_config_from(dir: &Path) -> Option<AppConfig> {
    let path = dir.join(CONFIG_FILE);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::error!("read_config: cannot read {}: {e}", path.display());
            return None;
        }
    };
    match serde_json::from_slice::<AppConfig>(&bytes) {
        Ok(mut cfg) if (MIN_CONFIG_VERSION..=CONFIG_VERSION).contains(&cfg.version) => {
            if cfg.version < CONFIG_VERSION {
                log::info!(
                    "read_config: migrating config version {} -> {CONFIG_VERSION}",
                    cfg.version
                );
                cfg.version = CONFIG_VERSION;
            }
            Some(cfg)
        }
        Ok(cfg) => {
            log::warn!(
                "read_config: unsupported config version {} (expected {CONFIG_VERSION}); quarantining",
                cfg.version
            );
            quarantine(dir, &path);
            None
        }
        Err(e) => {
            log::warn!("read_config: corrupt {}: {e}; quarantining", path.display());
            quarantine(dir, &path);
            None
        }
    }
}

/// Move a bad config aside as `config.json.bak` (replacing any previous
/// quarantine) so a fresh start never silently destroys user data.
fn quarantine(dir: &Path, path: &Path) {
    let bak = dir.join(BAK_FILE);
    let _ = fs::remove_file(&bak);
    if let Err(e) = fs::rename(path, &bak) {
        log::error!(
            "read_config: failed to quarantine {} -> {}: {e}",
            path.display(),
            bak.display()
        );
    }
}

/// Atomically persist `config` under `dir` (created if missing):
/// write temp file, fsync, rename over the real one. The temp name is
/// unique per write (pid + sequence), so concurrent writers — e.g. a second
/// debounced save racing shutdown — can no longer truncate each other's
/// in-flight temp file (security review deferred item 4, now fixed).
pub fn write_config_to(dir: &Path, config: &AppConfig) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(config)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        "{TMP_FILE}.{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, dir.join(CONFIG_FILE)) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Never leave a stale temp file behind on failure.
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Security hardening (docs/security-review.md, "event spoofing between
/// webviews"): re-stamp config fields whose authority lives in Rust before
/// anything is persisted. Tauri events carry no source identity, so a forged
/// `paused-changed` event could poison the brain's in-memory copy of
/// `paused`; the live flag (`shell::is_paused`, flipped only by the
/// `set_paused` command / tray) is the truth, and it is what reaches disk —
/// so the next launch can never seed a pause state the user never chose.
pub(crate) fn enforce_authoritative_fields(config: &mut AppConfig) {
    let live = crate::shell::is_paused();
    if config.paused != live {
        log::warn!(
            "write_config: overriding submitted paused={} with authoritative paused={live}",
            config.paused
        );
        config.paused = live;
    }
    sanitize_hotkey(config, &crate::shell::current_hotkey());
}

/// Security review deferred item 2 (now fixed): never persist an accelerator
/// `Shortcut::parse` rejects — it would silently fail to register on every
/// later launch, leaving the user with no hotkey at all. An invalid string
/// is replaced with `fallback` (the currently registered binding), which is
/// itself backstopped by the default.
pub(crate) fn sanitize_hotkey(config: &mut AppConfig, fallback: &str) {
    use tauri_plugin_global_shortcut::Shortcut;
    if config.hotkey.parse::<Shortcut>().is_ok() {
        return;
    }
    let replacement = if fallback.parse::<Shortcut>().is_ok() {
        fallback.to_string()
    } else {
        crate::shell::DEFAULT_HOTKEY.to_string()
    };
    log::warn!(
        "write_config: rejecting unparseable hotkey {:?}; persisting {:?} instead",
        config.hotkey,
        replacement
    );
    config.hotkey = replacement;
}

/// Contract §C2: `read_config() -> AppConfig | null`. For the **brain host**
/// it also pushes the loaded exclusion list into the tracker so eligibility
/// matches the config from the first snapshot on, and converges shell state
/// (initial pause seed, hotkey, autostart — plan Task 18) onto the loaded
/// config. For the **settings** window it is a pure read (critique round 3):
/// settings mounts call this while the brain's 500 ms save debounce may
/// still hold newer state, so letting that call re-apply the *on-disk*
/// hotkey/autostart or trigger a tracker resync would transiently revert a
/// change the user just made — and would let a less-privileged window
/// indirectly drive desktop re-sweeps. Side effects belong to the config's
/// owner (the brain host) alone.
#[tauri::command]
pub fn read_config(app: tauri::AppHandle, window: tauri::Window) -> Option<AppConfig> {
    crate::guard::authorize("read_config", window.label()).ok()?;
    let dir = config_dir()?;
    let cfg = read_config_from(&dir)?;
    if window.label() == crate::guard::MAIN_LABEL {
        // Task 19: an exclusion-list change re-sweeps the desktop so the
        // live eligible set (and the brain, via the emitted diff events)
        // converges without a restart.
        if crate::tracker::set_exclusions(cfg.exclusions.clone()) {
            crate::tracker::resync();
        }
        crate::shell::sync_from_config(&app, &cfg);
    }
    Some(cfg)
}

/// Contract §C2: `write_config(config: AppConfig)`. Keeps the tracker's
/// exclusion list and the shell's hotkey/autostart registrations in sync
/// with what is being persisted. Only the brain host may persist (security
/// review: least privilege), and Rust-owned fields are re-stamped from their
/// live authority first ([`enforce_authoritative_fields`]).
#[tauri::command]
pub fn write_config(
    app: tauri::AppHandle,
    window: tauri::Window,
    config: AppConfig,
) -> Result<(), String> {
    crate::guard::authorize("write_config", window.label())?;
    let mut config = config;
    enforce_authoritative_fields(&mut config);
    // Task 19: see read_config — exclusion edits take effect live.
    if crate::tracker::set_exclusions(config.exclusions.clone()) {
        crate::tracker::resync();
    }
    crate::shell::sync_from_config(&app, &config);
    let dir = config_dir().ok_or_else(|| "APPDATA is not set".to_string())?;
    write_config_to(&dir, &config).map_err(|e| {
        log::error!("write_config: {e}");
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Fresh scratch directory per test (removed on drop).
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "griddle-wm-config-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            ScratchDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// No leftover temp file (any name containing ".tmp") in `dir`.
    fn no_tmp_files(dir: &Path) -> bool {
        fs::read_dir(dir)
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .all(|e| !e.file_name().to_string_lossy().contains(".tmp"))
            })
            .unwrap_or(true)
    }

    fn sample_config() -> AppConfig {
        use crate::ipc::{AppRule, GridMode, GridSettings, Slot, Template};
        AppConfig {
            version: 2,
            grids: vec![GridSettings {
                id: "grid:\\\\.\\DISPLAY1@0,0".into(),
                monitor_ids: vec!["\\\\.\\DISPLAY1@0,0".into()],
                cols: 12,
                rows: 6,
                mode: GridMode::Collision,
                enabled: true,
                active_template_id: None,
                gap: 8,
                padding: 16,
            }],
            templates: vec![Template {
                id: "tpl:user:mine".into(),
                name: "Mine".into(),
                cols: 8,
                rows: 6,
                slots: vec![Slot {
                    col: 0,
                    row: 0,
                    w: 5,
                    h: 6,
                }],
                builtin: false,
            }],
            exclusions: vec!["slack.exe".into()],
            layouts: HashMap::from([(
                "grid:\\\\.\\DISPLAY1@0,0".to_string(),
                serde_json::json!({ "version": 1, "tiles": [] }),
            )]),
            hotkey: "Ctrl+Super+G".into(),
            autostart: false,
            paused: false,
            app_rules: vec![AppRule {
                exe: "code.exe".into(),
                grid_id: None,
                slot: Slot {
                    col: 6,
                    row: 0,
                    w: 6,
                    h: 6,
                },
            }],
            views: vec![crate::ipc::View {
                id: "view:1".into(),
                name: "Work".into(),
                grids: vec![crate::ipc::ViewGrid {
                    settings: GridSettings {
                        id: "grid:\\\\.\\DISPLAY1@0,0".into(),
                        monitor_ids: vec!["\\\\.\\DISPLAY1@0,0".into()],
                        cols: 12,
                        rows: 6,
                        mode: GridMode::Collision,
                        enabled: true,
                        active_template_id: None,
                        gap: 8,
                        padding: 16,
                    },
                    assignments: vec![crate::ipc::ViewAssignment {
                        exe: "code.exe".into(),
                        slot: Slot {
                            col: 0,
                            row: 0,
                            w: 6,
                            h: 6,
                        },
                    }],
                }],
            }],
            startup_view_id: Some("view:1".into()),
        }
    }

    #[test]
    fn missing_dir_and_missing_file_read_as_none() {
        let dir = ScratchDir::new();
        assert_eq!(read_config_from(dir.path()), None);
        fs::create_dir_all(dir.path()).unwrap();
        assert_eq!(read_config_from(dir.path()), None);
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = ScratchDir::new();
        let cfg = sample_config();
        write_config_to(dir.path(), &cfg).expect("write");
        assert_eq!(read_config_from(dir.path()), Some(cfg));
        assert!(no_tmp_files(dir.path()), "temp file cleaned up after rename");
    }

    #[test]
    fn rewrite_replaces_existing_config_atomically() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        write_config_to(dir.path(), &cfg).expect("first write");
        cfg.paused = true;
        cfg.exclusions.push("figma.exe".into());
        write_config_to(dir.path(), &cfg).expect("overwrite");
        let read = read_config_from(dir.path()).expect("readable");
        assert!(read.paused);
        assert_eq!(read.exclusions, vec!["slack.exe", "figma.exe"]);
        assert!(no_tmp_files(dir.path()));
    }

    /// Security review deferred item 4 (now fixed): two interleaved writers
    /// use distinct temp names, so neither can truncate the other's in-flight
    /// temp file; the config ends up as one of the two writes, intact.
    #[test]
    fn concurrent_writers_use_unique_temp_names() {
        let dir = ScratchDir::new();
        let a = sample_config();
        let mut b = sample_config();
        b.exclusions.push("second.exe".into());
        let threads: Vec<_> = [a.clone(), b.clone()]
            .into_iter()
            .map(|cfg| {
                let path = dir.path().to_path_buf();
                std::thread::spawn(move || write_config_to(&path, &cfg).expect("write"))
            })
            .collect();
        for t in threads {
            t.join().expect("writer thread");
        }
        let read = read_config_from(dir.path()).expect("readable after the race");
        assert!(read == a || read == b, "one intact write wins");
        assert!(no_tmp_files(dir.path()), "no temp litter after the race");
    }

    /// Spec v0.2 §4 groundwork: a config written before `gap`/`padding`
    /// existed (every v0.1.0 install) must keep deserializing — the fields
    /// default to 0 via `#[serde(default)]`, never a quarantine.
    #[test]
    fn config_without_spacing_fields_reads_with_zero_defaults() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let grid = json["grids"][0].as_object_mut().unwrap();
        grid.remove("gap");
        grid.remove("padding");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v0.1.0 config must stay readable");
        assert_eq!(read.grids[0].gap, 0);
        assert_eq!(read.grids[0].padding, 0);
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a spacing-less config is valid, not corrupt"
        );
    }

    /// Spec v0.2 §4 groundwork, same pattern as the spacing fields: a config
    /// written before `appRules` existed must keep deserializing — the field
    /// defaults to an empty list via `#[serde(default)]`, never a quarantine.
    #[test]
    fn config_without_app_rules_reads_with_empty_default() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        json.as_object_mut().unwrap().remove("appRules");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("rule-less config must stay readable");
        assert!(read.app_rules.is_empty());
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a rule-less config is valid, not corrupt"
        );
    }

    /// The camelCase wire shape of an app rule is part of contract C1:
    /// `gridId: null` must round-trip as the any-grid scope.
    #[test]
    fn app_rules_round_trip_with_camel_case_and_null_grid_id() {
        let dir = ScratchDir::new();
        let cfg = sample_config();
        write_config_to(dir.path(), &cfg).expect("write");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("\"appRules\""), "camelCase field name on disk");
        assert!(raw.contains("\"gridId\": null"), "any-grid scope is null");
        assert_eq!(read_config_from(dir.path()), Some(cfg));
    }

    #[test]
    fn corrupt_file_reads_none_and_is_quarantined_as_bak() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"{ not json ]").unwrap();

        assert_eq!(read_config_from(dir.path()), None);
        assert!(
            !dir.path().join(CONFIG_FILE).exists(),
            "corrupt file moved aside"
        );
        let bak = fs::read(dir.path().join(BAK_FILE)).expect("bak exists");
        assert_eq!(bak, b"{ not json ]", "quarantine preserves the bytes");
        // A second read (no file at all now) is still just None.
        assert_eq!(read_config_from(dir.path()), None);
    }

    #[test]
    fn quarantine_replaces_a_previous_bak() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join(BAK_FILE), b"old bak").unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"newer corruption").unwrap();
        assert_eq!(read_config_from(dir.path()), None);
        assert_eq!(
            fs::read(dir.path().join(BAK_FILE)).unwrap(),
            b"newer corruption"
        );
    }

    #[test]
    fn unknown_future_version_is_treated_as_corrupt() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.version = CONFIG_VERSION + 1;
        write_config_to(dir.path(), &cfg).expect("write");
        assert_eq!(read_config_from(dir.path()), None);
        assert!(dir.path().join(BAK_FILE).exists(), "quarantined");
    }

    /// Spec v0.2 §4: a complete v1 config (as written by v0.1.0 — no
    /// `appRules`, `views`, `startupViewId`, no spacing fields) migrates in
    /// place: version re-stamped to 2, the new fields empty-defaulted,
    /// everything it did carry intact, and no `.bak` quarantine.
    #[test]
    fn v1_config_migrates_to_v2_with_defaults() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(1));
        obj.remove("appRules");
        obj.remove("views");
        obj.remove("startupViewId");
        let grid = json["grids"][0].as_object_mut().unwrap();
        grid.remove("gap");
        grid.remove("padding");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v1 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to v2");
        assert!(read.app_rules.is_empty());
        assert!(read.views.is_empty());
        assert_eq!(read.startup_view_id, None);
        assert_eq!(read.grids[0].gap, 0);
        assert_eq!(read.grids[0].padding, 0);
        // The v1 payload survives.
        assert_eq!(read.exclusions, vec!["slack.exe"]);
        assert_eq!(read.grids[0].cols, 12);
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a v1 config is migrated, not quarantined"
        );

        // Round-trip: the next write persists v2, which reads back intact.
        write_config_to(dir.path(), &read).expect("persist migrated config");
        assert_eq!(read_config_from(dir.path()), Some(read));
    }

    /// The camelCase wire shape of the view fields is part of contract C1:
    /// views and `startupViewId` must round-trip, including `null` for none.
    #[test]
    fn views_round_trip_with_camel_case_field_names() {
        let dir = ScratchDir::new();
        let cfg = sample_config();
        write_config_to(dir.path(), &cfg).expect("write");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("\"views\""), "camelCase views on disk");
        assert!(raw.contains("\"startupViewId\""), "camelCase id on disk");
        assert!(raw.contains("\"assignments\""), "assignments serialized");
        assert_eq!(read_config_from(dir.path()), Some(cfg));

        // startupViewId: None serializes as null and reads back as None.
        let mut cfg = sample_config();
        cfg.startup_view_id = None;
        write_config_to(dir.path(), &cfg).expect("write");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("\"startupViewId\": null"));
        assert_eq!(read_config_from(dir.path()), Some(cfg));
    }

    #[test]
    fn corrupt_then_write_recovers_cleanly() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"garbage").unwrap();
        assert_eq!(read_config_from(dir.path()), None);

        let cfg = sample_config();
        write_config_to(dir.path(), &cfg).expect("write after corruption");
        assert_eq!(read_config_from(dir.path()), Some(cfg));
        assert!(dir.path().join(BAK_FILE).exists(), "evidence kept");
    }

    /// Plan Task 20 (brain-webview death → respawn): the respawned brain
    /// rehydrates from this file, and the `layouts` entries are opaque
    /// `Grid.toJSON()` blobs Rust must not reinterpret — they have to survive
    /// a process death (write, drop everything, fresh read) value-identical,
    /// including nested tile shapes with absolute/pinned fields, or the
    /// respawned brain cannot put windows back on their slots.
    #[test]
    fn layout_snapshots_survive_death_and_respawn_intact() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        let blob = serde_json::json!({
            "version": 1,
            "config": { "cols": 12, "rows": 6, "gravity": "none" },
            "tiles": [
                { "id": "131074", "col": 0, "row": 0, "w": 3, "h": 2 },
                { "id": "262148", "col": 3, "row": 0, "w": 1, "h": 1,
                  "position": "absolute", "pinned": { "x": 3, "y": 0 } }
            ]
        });
        cfg.layouts
            .insert("grid:\\\\.\\DISPLAY1@0,0".to_string(), blob.clone());
        write_config_to(dir.path(), &cfg).expect("write before death");

        // Simulated brain death: nothing survives in memory. The respawn's
        // read_config must hand back exactly what was persisted.
        let read = read_config_from(dir.path()).expect("readable after respawn");
        assert_eq!(
            read.layouts.get("grid:\\\\.\\DISPLAY1@0,0"),
            Some(&blob),
            "layout snapshot must round-trip untouched"
        );
        assert_eq!(read, cfg, "whole config survives death intact");
    }

    /// Security review regression: the persisted `paused` bit must come from
    /// the live shell flag, not from whatever the webview submitted — a
    /// forged `paused-changed` event can poison the brain's copy, but it
    /// must never reach disk.
    #[test]
    fn write_persists_the_authoritative_pause_flag_not_the_submitted_one() {
        // PAUSED is process-global; the live-set lock serializes every test
        // touching it (see shell.rs / actuator.rs tests).
        let _guard = crate::tracker::live_set_test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());

        // Poisoned webview copy says paused, authority says running.
        crate::shell::set_paused_flag(false);
        let mut cfg = sample_config();
        cfg.paused = true;
        enforce_authoritative_fields(&mut cfg);
        assert!(!cfg.paused, "submitted paused=true must be overridden");

        // And the other direction: authority paused, submitted running.
        crate::shell::set_paused_flag(true);
        let mut cfg = sample_config();
        cfg.paused = false;
        enforce_authoritative_fields(&mut cfg);
        assert!(cfg.paused, "authoritative paused=true must be persisted");

        // Nothing else is touched.
        crate::shell::set_paused_flag(false);
        let mut cfg = sample_config();
        let pristine = cfg.clone();
        enforce_authoritative_fields(&mut cfg);
        assert_eq!(cfg, pristine, "matching pause flag leaves config intact");
    }

    /// Security review deferred item 2 (now fixed): an unparseable hotkey is
    /// never persisted — it is replaced by the currently registered binding
    /// (or the default), so a restart can never silently lose the hotkey.
    #[test]
    fn unparseable_hotkey_is_replaced_before_persisting() {
        let mut cfg = sample_config();
        cfg.hotkey = "NotAKey+G".into();
        sanitize_hotkey(&mut cfg, "Ctrl+Alt+G");
        assert_eq!(cfg.hotkey, "Ctrl+Alt+G", "falls back to the live binding");

        let mut cfg = sample_config();
        cfg.hotkey = String::new();
        sanitize_hotkey(&mut cfg, "also+garbage+");
        assert_eq!(
            cfg.hotkey,
            crate::shell::DEFAULT_HOTKEY,
            "default backstops an invalid fallback"
        );

        let mut cfg = sample_config();
        cfg.hotkey = "Ctrl+Super+F12".into();
        sanitize_hotkey(&mut cfg, "Ctrl+Alt+G");
        assert_eq!(cfg.hotkey, "Ctrl+Super+F12", "valid hotkeys pass through");
    }

    #[test]
    fn config_dir_is_appdata_griddle_wm() {
        // APPDATA is always set on Windows CI/dev boxes; on other platforms
        // the function may return None, which callers treat as "no config".
        if let Some(dir) = config_dir() {
            assert!(dir.ends_with("griddle-wm"), "{}", dir.display());
        }
    }
}
