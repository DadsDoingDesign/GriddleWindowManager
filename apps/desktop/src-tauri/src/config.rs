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

/// Current config schema version (contract C1). Older files still load: every
/// field a later version added carries `#[serde(default)]`, so a v1 (v0.1.0),
/// v2 (v0.2.0) or v3 file deserializes with those defaults — empty rule/view
/// lists, `auto_check_updates: false` — and is re-stamped to the current
/// version on read. v4 also renames the two original placement modes, which
/// the `GridMode` serde aliases absorb: a pre-v4 file's `collision`/`overlay`
/// read as `push`/`stack` and persist under the new names, with no change in
/// behavior. v7 adds `theme` over v6, which added `manage_settings_window`
/// + `settings_window_pos`
/// over v5, which added `suppress_windows_snap` + `windows_snap_original`
/// (spec 2026-08-19), both `#[serde(default)]` like every addition before
/// them. v8 adds `drop_placement` + `move_placement` (spec 2026-08-31, drag
/// fill placement), and v9 `maximize_behavior` + `no_room_placement` (same
/// day, second batch), all `#[serde(default)]` like every addition before
/// them. Only *future* versions are quarantined.
const CONFIG_VERSION: u32 = 9;
/// Oldest schema version the migration path accepts.
const MIN_CONFIG_VERSION: u32 = 1;

const CONFIG_FILE: &str = "config.json";
const TMP_FILE: &str = "config.json.tmp";
const BAK_FILE: &str = "config.json.bak";

/// Folder name under `%APPDATA%`. A dev build gets its own so a contributor
/// running `npm run tauri:dev` cannot fight — or corrupt — the config of the
/// copy they have installed. Both sides ran a 500 ms debounced writer against
/// one hardcoded path before this (docs/qa-handoff-2026-08-19.md, defect 4).
///
/// `dev` is the cfg alias `tauri-build` emits: true exactly when the
/// `custom-protocol` feature is off, i.e. every `tauri dev` build and no
/// shipped one.
pub const APP_DIR: &str = if cfg!(dev) { "griddle-wm-dev" } else { "griddle-wm" };

/// `%APPDATA%/griddle-wm` (`griddle-wm-dev` in a dev build), or `None` when
/// APPDATA is unset (not a real Windows session; commands degrade to "no
/// config").
pub fn config_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    if appdata.is_empty() {
        return None;
    }
    Some(PathBuf::from(appdata).join(APP_DIR))
}

/// `%APPDATA%/griddle-wm/logs` — the log file lives beside the config rather
/// than in Tauri's identifier-keyed `LogDir`, so everything Griddle writes
/// about you sits in exactly one folder you can inspect or delete.
///
/// Privacy rule for anything logged here (see README "What Griddle records"):
/// the log may name Griddle's own state — hwnds, monitor device names, config
/// paths, error text — and must never contain a window title, an executable
/// name or a path to your documents. Nothing is ever transmitted.
pub fn logs_dir() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("logs"))
}

/// Read + validate the config under `dir`. Missing file → `None`. Corrupt or
/// unknown-future-version file → quarantined to `config.json.bak`, then
/// `None`. A supported older version (v1–v3) migrates in place: the serde
/// defaults fill the fields it lacked, the `GridMode` aliases rename its
/// placement modes, and the version is re-stamped, so the next write persists
/// a current-version file.
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
    // The snap capture's authority is Rust too (spec 2026-08-19 §4): it is
    // Some exactly while Griddle has modified the OS, a fact only the sync
    // in `shell::sync_from_config` knows. Stamping it here means the webview
    // can never persist a stale or forged capture — and it is how the
    // capture reaches disk at all, since the brain merely echoes the config.
    config.windows_snap_original = crate::shell::snap_capture();
    // Same reasoning for the pop-out's position (spec 2026-08-20 addendum):
    // Rust watches the window's move events, so the live value is only known
    // here. Stamped only when we actually have one - writing `None` over a
    // remembered position would forget it on the first config write of a
    // session where the user never opened Settings.
    if let Some(pos) = crate::shell::settings_pos() {
        config.settings_window_pos = Some(pos);
    }
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
        if crate::tracker::set_exclusions(cfg.exclusions.clone())
            | crate::tracker::set_manage_settings_window(cfg.manage_settings_window)
        {
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
    // Non-short-circuiting `|`: both mirrors must be updated even when the
    // first one already reports a change, or a simultaneous edit to the
    // second would be dropped.
    if crate::tracker::set_exclusions(config.exclusions.clone())
        | crate::tracker::set_manage_settings_window(config.manage_settings_window)
    {
        crate::tracker::resync();
    }
    crate::shell::sync_from_config(&app, &config);
    // Re-stamp AFTER the sync: the write that first enables snap suppression
    // is the write that must carry the fresh capture to disk. Stamping only
    // before the sync (in enforce_authoritative_fields) would persist None on
    // exactly that write, and a crash before the next debounced save would
    // strand the OS suppressed with no restore data (spec 2026-08-19 §4).
    config.windows_snap_original = crate::shell::snap_capture();
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
            version: CONFIG_VERSION,
            grids: vec![GridSettings {
                id: "grid:\\\\.\\DISPLAY1@0,0".into(),
                monitor_ids: vec!["\\\\.\\DISPLAY1@0,0".into()],
                cols: 12,
                rows: 6,
                mode: GridMode::Push,
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
                        mode: GridMode::Push,
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
            auto_check_updates: false,
            suppress_windows_snap: false,
            windows_snap_original: None,
            manage_settings_window: false,
            settings_window_pos: None,
            theme: None,
            drop_placement: None,
            move_placement: None,
            maximize_behavior: None,
            no_room_placement: None,
        }
    }

    /// Spec 2026-08-31 (drag fill placement): a v7 config — everything up to
    /// `theme`, no placement-fill fields — migrates in place: version
    /// re-stamped, both fields absent (`None`, which the brain reads as its
    /// defaults), nothing else touched.
    #[test]
    fn v7_config_without_placement_fields_reads_as_untouched() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(7));
        obj.remove("dropPlacement");
        obj.remove("movePlacement");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_string(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v7 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to v8");
        assert_eq!(read.drop_placement, None, "the brain owns the default");
        assert_eq!(read.move_placement, None, "the brain owns the default");
    }

    /// Spec 2026-08-31 (second batch): a v8 config — no expand/auto-split
    /// fields — migrates in place with both absent (`None`, the brain's
    /// defaults), nothing else touched.
    #[test]
    fn v8_config_without_behavior_fields_reads_as_untouched() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(8));
        obj.remove("maximizeBehavior");
        obj.remove("noRoomPlacement");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_string(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v8 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to v9");
        assert_eq!(read.maximize_behavior, None, "the brain owns the default");
        assert_eq!(read.no_room_placement, None, "the brain owns the default");
    }

    /// The v9 behavior fields round-trip verbatim, like the v8 pair.
    #[test]
    fn behavior_fields_round_trip() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.maximize_behavior = Some("windows".into());
        cfg.no_room_placement = Some("refuse".into());
        write_config_to(dir.path(), &cfg).expect("write");
        assert_eq!(read_config_from(dir.path()), Some(cfg));
    }

    /// The placement-fill fields round-trip verbatim — Rust only stores what
    /// the brain wrote.
    #[test]
    fn placement_fields_round_trip() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.drop_placement = Some("size".into());
        cfg.move_placement = Some("fill".into());
        write_config_to(dir.path(), &cfg).expect("write");
        assert_eq!(read_config_from(dir.path()), Some(cfg));
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
    /// `appRules`, `views`, `startupViewId`, `autoCheckUpdates`, no spacing
    /// fields) migrates in place: version re-stamped, the new fields
    /// defaulted, everything it did carry intact, no `.bak` quarantine.
    #[test]
    fn v4_config_without_snap_fields_reads_as_untouched() {
        // Every config written before spec 2026-08-19 lacks the two snap
        // fields; they must read as "preference off, OS never modified" —
        // anything else would let an upgrade silently edit the user's OS.
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(4));
        obj.remove("suppressWindowsSnap");
        obj.remove("windowsSnapOriginal");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v4 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to v5");
        assert!(!read.suppress_windows_snap, "opt-in: absent reads as off");
        assert_eq!(read.windows_snap_original, None, "no capture = never touched");
    }

    /// v5 -> v6. Same contract as the v4 case above, for the pop-out fields:
    /// an upgrade must not start tiling the settings window, and must not
    /// invent a remembered position that would move it out from under the
    /// tray-corner default.
    #[test]
    fn v5_config_without_popout_fields_reads_as_floating_and_unplaced() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(5));
        obj.remove("manageSettingsWindow");
        obj.remove("settingsWindowPos");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v5 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to v6");
        assert!(
            !read.manage_settings_window,
            "opt-in: an upgrade must not start tiling the pop-out"
        );
        assert_eq!(
            read.settings_window_pos, None,
            "no remembered position = the tray-corner default still applies"
        );
    }

    #[test]
    fn popout_fields_round_trip_through_disk() {
        use crate::ipc::WindowPos;
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.manage_settings_window = true;
        // Negative coordinates on purpose: a monitor left of the primary is
        // exactly where a signed field earns its keep.
        cfg.settings_window_pos = Some(WindowPos { x: -1720, y: 240 });
        write_config_to(dir.path(), &cfg).unwrap();
        let read = read_config_from(dir.path()).expect("v6 round-trips");
        assert!(read.manage_settings_window);
        assert_eq!(read.settings_window_pos, cfg.settings_window_pos);
    }

    #[test]
    fn snap_fields_round_trip_through_disk() {
        use crate::ipc::SnapState;
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.suppress_windows_snap = true;
        cfg.windows_snap_original = Some(SnapState {
            dock_moving: true,
            snap_sizing: false,
            snap_assist_flyout: true,
        });
        write_config_to(dir.path(), &cfg).unwrap();
        let read = read_config_from(dir.path()).expect("v5 round-trips");
        assert!(read.suppress_windows_snap);
        assert_eq!(read.windows_snap_original, cfg.windows_snap_original);
    }

    #[test]
    fn v1_config_migrates_to_current_with_defaults() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut json = serde_json::to_value(sample_config()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(1));
        obj.remove("appRules");
        obj.remove("views");
        obj.remove("startupViewId");
        obj.remove("autoCheckUpdates");
        json["grids"][0]["mode"] = serde_json::json!("collision"); // the v1 spelling
        let grid = json["grids"][0].as_object_mut().unwrap();
        grid.remove("gap");
        grid.remove("padding");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v1 config must stay readable");
        assert_eq!(
            read.version, CONFIG_VERSION,
            "re-stamped to the current version"
        );
        assert_eq!(
            read.grids[0].mode,
            crate::ipc::GridMode::Push,
            "the v1 `collision` mode is today's push"
        );
        assert!(read.app_rules.is_empty());
        assert!(read.views.is_empty());
        assert_eq!(read.startup_view_id, None);
        assert!(!read.auto_check_updates);
        assert_eq!(read.grids[0].gap, 0);
        assert_eq!(read.grids[0].padding, 0);
        // The v1 payload survives.
        assert_eq!(read.exclusions, vec!["slack.exe"]);
        assert_eq!(read.grids[0].cols, 12);
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a v1 config is migrated, not quarantined"
        );

        // Round-trip: the next write persists v3, which reads back intact.
        write_config_to(dir.path(), &read).expect("persist migrated config");
        assert_eq!(read_config_from(dir.path()), Some(read));
    }

    /// Spec §7 "Update checks": a **real** v2 config — everything v0.2.0
    /// wrote, spacing/rules/views and all, but no `autoCheckUpdates` and the
    /// placement modes under their original names — migrates to the current
    /// version without losing a single field, and lands opted **out**. This
    /// is the upgrade every shipped v0.2.0 install performs on first launch,
    /// so it must not so much as reorder a slot.
    #[test]
    fn v2_config_migrates_to_current_without_loss_and_opted_out() {
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let expected = sample_config(); // the shape v0.2.0 persisted, minus the new field
        let mut json = serde_json::to_value(&expected).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.insert("version".into(), serde_json::json!(2));
        obj.remove("autoCheckUpdates");
        assert!(
            !json.to_string().contains("autoCheckUpdates"),
            "the v2 file on disk genuinely lacks the field"
        );
        // v0.2.0 spelled today's `push` as `collision`.
        json["grids"][0]["mode"] = serde_json::json!("collision");
        json["views"][0]["grids"][0]["settings"]["mode"] = serde_json::json!("collision");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v2 config must stay readable");
        assert_eq!(
            read.version, CONFIG_VERSION,
            "re-stamped to the current version"
        );
        assert!(
            !read.auto_check_updates,
            "upgrading must never opt a user into network access"
        );
        // Nothing else moved: compare against the whole v2 payload at once.
        assert_eq!(
            AppConfig {
                version: 2,
                auto_check_updates: false,
                ..read.clone()
            },
            AppConfig {
                version: 2,
                ..expected
            },
            "every v2 field survives the migration untouched"
        );
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a v2 config is migrated, not quarantined"
        );

        // Round-trip: the next write persists v3, which reads back intact.
        write_config_to(dir.path(), &read).expect("persist migrated config");
        assert_eq!(read_config_from(dir.path()), Some(read));
    }

    /// Placement modes (contract C1): a **real** v3 config — everything
    /// v0.2.0's successor wrote, with the two original modes under their old
    /// names — migrates to v4 by renaming those modes and nothing else.
    /// `collision` means push and `overlay` means stack, so an upgrading user
    /// keeps the exact grid behavior they had; only the spelling on disk
    /// changes, and only on the next write.
    #[test]
    fn v3_config_migrates_to_v4_renaming_modes_without_loss() {
        use crate::ipc::GridMode;
        let dir = ScratchDir::new();
        fs::create_dir_all(dir.path()).unwrap();
        let mut expected = sample_config();
        expected.grids[0].mode = GridMode::Push;
        expected.views[0].grids[0].settings.mode = GridMode::Stack;

        let mut json = serde_json::to_value(&expected).unwrap();
        json.as_object_mut()
            .unwrap()
            .insert("version".into(), serde_json::json!(3));
        // The v3 file on disk spells the modes the old way.
        json["grids"][0]["mode"] = serde_json::json!("collision");
        json["views"][0]["grids"][0]["settings"]["mode"] = serde_json::json!("overlay");
        fs::write(
            dir.path().join(CONFIG_FILE),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let read = read_config_from(dir.path()).expect("v3 config must stay readable");
        assert_eq!(read.version, CONFIG_VERSION, "re-stamped to current");
        assert_eq!(
            read.grids[0].mode,
            GridMode::Push,
            "`collision` is what push used to be called"
        );
        assert_eq!(
            read.views[0].grids[0].settings.mode,
            GridMode::Stack,
            "`overlay` is what stack used to be called — inside views too"
        );
        // Nothing else moved: compare against the whole v3 payload at once.
        assert_eq!(
            AppConfig {
                version: 3,
                ..read.clone()
            },
            AppConfig {
                version: 3,
                ..expected
            },
            "every v3 field survives the migration untouched"
        );
        assert!(
            !dir.path().join(BAK_FILE).exists(),
            "a v3 config is migrated, not quarantined"
        );

        // Round-trip: the next write persists v4 under the new spelling, and
        // that file reads back identical.
        write_config_to(dir.path(), &read).expect("persist migrated config");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("\"mode\": \"push\""), "new spelling on disk");
        assert!(raw.contains("\"mode\": \"stack\""), "new spelling on disk");
        assert_eq!(read_config_from(dir.path()), Some(read));
    }

    /// The new mode is a first-class value on the wire, not just a rename.
    #[test]
    fn reflow_mode_round_trips_as_lowercase() {
        use crate::ipc::GridMode;
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.grids[0].mode = GridMode::Reflow;
        write_config_to(dir.path(), &cfg).expect("write");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(
            raw.contains("\"mode\": \"reflow\""),
            "camelCase/lowercase wire shape: {raw}"
        );
        assert_eq!(read_config_from(dir.path()), Some(cfg));
    }

    /// The camelCase wire shape of the update toggle is part of contract C1,
    /// and an opted-in config must survive a restart as opted in.
    #[test]
    fn auto_check_updates_round_trips_with_camel_case() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.auto_check_updates = true;
        write_config_to(dir.path(), &cfg).expect("write");
        let raw = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(
            raw.contains("\"autoCheckUpdates\": true"),
            "camelCase field name on disk: {raw}"
        );
        assert_eq!(read_config_from(dir.path()), Some(cfg));
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
    fn config_dir_is_appdata_app_dir() {
        // APPDATA is always set on Windows CI/dev boxes; on other platforms
        // the function may return None, which callers treat as "no config".
        if let Some(dir) = config_dir() {
            assert!(dir.ends_with(APP_DIR), "{}", dir.display());
        }
        // Tests are a dev build by construction (`custom-protocol` is off), so
        // this also pins the namespacing: a contributor running the test suite
        // or `tauri dev` must never be pointed at the installed copy's config.
        assert_eq!(APP_DIR, "griddle-wm-dev");
    }

    #[test]
    fn logs_live_beside_the_config() {
        if let (Some(cfg), Some(logs)) = (config_dir(), logs_dir()) {
            assert_eq!(logs.parent(), Some(cfg.as_path()), "{}", logs.display());
            assert!(logs.ends_with("logs"), "{}", logs.display());
        }
    }
}
