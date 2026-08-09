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

/// Only config schema version this build understands (contract C1).
const CONFIG_VERSION: u32 = 1;

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
/// wrong-version file → quarantined to `config.json.bak`, then `None`.
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
        Ok(cfg) if cfg.version == CONFIG_VERSION => Some(cfg),
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
/// write temp file, fsync, rename over the real one.
pub fn write_config_to(dir: &Path, config: &AppConfig) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(config)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join(TMP_FILE);
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

/// Contract §C2: `read_config() -> AppConfig | null`. Also pushes the loaded
/// exclusion list into the tracker so eligibility matches the config from the
/// first snapshot on, and converges shell state (initial pause seed, hotkey,
/// autostart — plan Task 18) onto the loaded config.
#[tauri::command]
pub fn read_config(app: tauri::AppHandle) -> Option<AppConfig> {
    let dir = config_dir()?;
    let cfg = read_config_from(&dir)?;
    // Task 19: an exclusion-list change re-sweeps the desktop so the live
    // eligible set (and the brain, via the emitted diff events) converges
    // without a restart.
    if crate::tracker::set_exclusions(cfg.exclusions.clone()) {
        crate::tracker::resync();
    }
    crate::shell::sync_from_config(&app, &cfg);
    Some(cfg)
}

/// Contract §C2: `write_config(config: AppConfig)`. Keeps the tracker's
/// exclusion list and the shell's hotkey/autostart registrations in sync
/// with what is being persisted.
#[tauri::command]
pub fn write_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
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

    fn sample_config() -> AppConfig {
        use crate::ipc::{GridMode, GridSettings, Slot, Template};
        AppConfig {
            version: 1,
            grids: vec![GridSettings {
                id: "grid:\\\\.\\DISPLAY1@0,0".into(),
                monitor_ids: vec!["\\\\.\\DISPLAY1@0,0".into()],
                cols: 12,
                rows: 6,
                mode: GridMode::Collision,
                enabled: true,
                active_template_id: None,
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
        assert!(
            !dir.path().join(TMP_FILE).exists(),
            "temp file cleaned up after rename"
        );
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
        assert!(!dir.path().join(TMP_FILE).exists());
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
    fn unsupported_version_is_treated_as_corrupt() {
        let dir = ScratchDir::new();
        let mut cfg = sample_config();
        cfg.version = 2;
        write_config_to(dir.path(), &cfg).expect("write");
        assert_eq!(read_config_from(dir.path()), None);
        assert!(dir.path().join(BAK_FILE).exists(), "quarantined");
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

    #[test]
    fn config_dir_is_appdata_griddle_wm() {
        // APPDATA is always set on Windows CI/dev boxes; on other platforms
        // the function may return None, which callers treat as "no config".
        if let Some(dir) = config_dir() {
            assert!(dir.ends_with("griddle-wm"), "{}", dir.display());
        }
    }
}
