//! Reads/writes oikb's own global config file (`~/.config/oikb/config.yaml`).
//!
//! Mirrors `oikb-main/src/oikb/config.py` exactly: same path resolution
//! (`OIKB_CONFIG_DIR` env override, else `~/.config/oikb`), same file name,
//! same `{url, token}` shape, same "merge into existing keys" semantics as
//! `set_config`. This is oikb's *default* connection — the one `resolve_url`/
//! `resolve_token` fall back to when a `.oikb.yaml` entry doesn't specify its
//! own `url`/`token`. `_make_client()` re-resolves it fresh on every sync
//! call, so writing this file takes effect immediately, with no daemon
//! restart required.

use serde_yaml::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn home_dir() -> Option<PathBuf> {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn config_dir() -> Result<PathBuf, String> {
    match std::env::var("OIKB_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => Ok(home_dir()
            .ok_or("could not determine home directory")?
            .join(".config")
            .join("oikb")),
    }
}

fn config_file_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.yaml"))
}

/// Mirrors `oikb-main/src/oikb/history.py`'s `_DEFAULT_DB` resolution:
/// `{CONFIG_DIR}/history.db`, a plain SQLite file with a single `sync_log`
/// table. No CLI command, daemon API route, or Python method exposes
/// clearing it (the class has an unexported `clear(older_than_days)` that
/// only prunes by age) — so this manipulates the data file directly, same
/// approach as `config_file_path` above, never touching oikb source.
fn history_db_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("history.db"))
}

pub fn clear_sync_history() -> Result<(), String> {
    let path = history_db_path()?;
    if !path.exists() {
        return Ok(());
    }
    let conn =
        rusqlite::Connection::open(&path).map_err(|e| format!("opening {path:?}: {e}"))?;
    // history.db is also held open by the running daemon (WAL-mode pool) —
    // give a brief grace period instead of failing immediately on contention.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("setting busy timeout: {e}"))?;
    conn.execute("DELETE FROM sync_log", [])
        .map_err(|e| format!("clearing sync_log in {path:?}: {e}"))?;
    Ok(())
}

fn load(path: &PathBuf) -> Result<BTreeMap<String, Value>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let contents = std::fs::read_to_string(path).map_err(|e| format!("reading {path:?}: {e}"))?;
    if contents.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_yaml::from_str(&contents).map_err(|e| format!("parsing {path:?}: {e}"))
}

fn save(path: &PathBuf, data: &BTreeMap<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating {parent:?}: {e}"))?;
    }
    let contents = serde_yaml::to_string(data).map_err(|e| format!("serializing config: {e}"))?;
    // Log the path only, never `data` — it can carry the oikb `token` field.
    log::info!("writing oikb config: {path:?}");
    std::fs::write(path, contents).map_err(|e| format!("writing {path:?}: {e}"))
}

pub fn set_global_config(url: Option<String>, token: Option<String>) -> Result<(), String> {
    let path = config_file_path()?;
    let mut data = load(&path)?;
    if let Some(url) = url.filter(|s| !s.is_empty()) {
        data.insert("url".to_string(), Value::String(url));
    }
    if let Some(token) = token.filter(|s| !s.is_empty()) {
        data.insert("token".to_string(), Value::String(token));
    }
    save(&path, &data)
}

pub fn get_global_config() -> Result<(Option<String>, Option<String>), String> {
    let path = config_file_path()?;
    let data = load(&path)?;
    let get_str = |key: &str| {
        data.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    Ok((get_str("url"), get_str("token")))
}

/// Defense-in-depth check on a user-supplied `.oikb.yaml` path (Settings UI
/// lets the user point at an arbitrary existing file, so we can't restrict
/// to a fixed directory) — rejects anything that isn't an absolute path with
/// a `.yaml`/`.yml` extension, or that contains a `..` segment, before it
/// ever reaches `fs::write`/`fs::read_to_string`.
fn validate_yaml_path(path: &std::path::Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{} must be an absolute path", path.display()));
    }
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml"))
        .unwrap_or(false);
    if !ext_ok {
        log::warn!("rejected .oikb.yaml path (bad extension): {}", path.display());
        return Err(format!("{} must have a .yaml or .yml extension", path.display()));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        log::warn!("rejected .oikb.yaml path (contains ..): {}", path.display());
        return Err(format!("{} must not contain '..' path segments", path.display()));
    }
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
pub struct SourceEntry {
    pub name: String,
    pub folder: String,
    pub kb_id: String,
    pub interval: String,
}

/// Full-replace `.oikb.yaml`'s `sources:` list from the app's own local list
/// of known sources (Addendum 11) — the app is now the source of truth for
/// "all sources including disabled ones"; `.oikb.yaml` only ever receives
/// the *enabled* subset (the frontend filters before calling this), since
/// oikb itself has no enabled/disabled concept. `interval` is a per-source
/// duration string (`daemon.py`'s `_schedule_entry` accepts `"30s"/"5m"/"1h"/"1d"`
/// or a cron expression) set by the UI, defaulting to `"1h"`.
///
/// Note: `daemon.py` loads `.oikb.yaml` once at startup (no hot-reload), so
/// this write only takes effect after the daemon is restarted — unlike
/// `set_global_config` above, which the daemon re-reads on every sync.
pub fn write_sources(yaml_path: String, sources: Vec<SourceEntry>) -> Result<(), String> {
    let path = PathBuf::from(&yaml_path);
    validate_yaml_path(&path)?;
    let list: Vec<Value> = sources
        .into_iter()
        .map(|s| {
            let mut m = serde_yaml::Mapping::new();
            m.insert(Value::String("name".to_string()), Value::String(s.name));
            m.insert(Value::String("source".to_string()), Value::String(s.folder));
            m.insert(Value::String("kb-id".to_string()), Value::String(s.kb_id));
            m.insert(Value::String("interval".to_string()), Value::String(s.interval));
            Value::Mapping(m)
        })
        .collect();

    let mut doc = serde_yaml::Mapping::new();
    doc.insert(Value::String("sources".to_string()), Value::Sequence(list));

    let contents =
        serde_yaml::to_string(&Value::Mapping(doc)).map_err(|e| format!("serializing {yaml_path}: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating {parent:?}: {e}"))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("writing {yaml_path}: {e}"))
}

/// Reads back whatever `sources:` entries already exist in `.oikb.yaml` —
/// used once to seed the app's local source list from a file a user already
/// had configured (e.g. from before Addendum 11), so it doesn't just vanish.
pub fn read_sources(yaml_path: String) -> Result<Vec<SourceEntry>, String> {
    let path = PathBuf::from(&yaml_path);
    validate_yaml_path(&path)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(&path).map_err(|e| format!("reading {yaml_path}: {e}"))?;
    if contents.trim().is_empty() {
        return Ok(vec![]);
    }
    let doc: Value = serde_yaml::from_str(&contents).map_err(|e| format!("parsing {yaml_path}: {e}"))?;
    let sources = doc
        .get("sources")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|entry| {
                    let m = entry.as_mapping()?;
                    let name = m.get("name")?.as_str()?.to_string();
                    let folder = m.get("source")?.as_str()?.to_string();
                    let kb_id = m.get("kb-id")?.as_str()?.to_string();
                    let interval = m
                        .get("interval")
                        .and_then(|v| v.as_str())
                        .unwrap_or("1h")
                        .to_string();
                    Some(SourceEntry { name, folder, kb_id, interval })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(sources)
}

/// Resolves and, if missing, creates the app-owned default `.oikb.yaml`
/// (`<app_data_dir>/oikb/.oikb.yaml`) — so a fresh install has a real,
/// writable config path with zero typing. Never overwrites an existing
/// file (including one with real entries already in it).
pub fn ensure_default_yaml(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let path = data_dir.join("oikb").join(".oikb.yaml");

    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("creating {parent:?}: {e}"))?;
        }
        std::fs::write(&path, "sources: []\n").map_err(|e| format!("writing {path:?}: {e}"))?;
    }

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `set_global_config`/`get_global_config` resolve their path through the
    // `OIKB_CONFIG_DIR` env var, which is process-wide state — serialize the
    // handful of tests that touch it so they can't race each other under
    // cargo test's default thread-per-test parallelism.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn sample_sources() -> Vec<SourceEntry> {
        vec![SourceEntry {
            name: "docs".to_string(),
            folder: "C:\\Users\\me\\Documents".to_string(),
            kb_id: "kb-123".to_string(),
            interval: "1h".to_string(),
        }]
    }

    #[test]
    fn write_then_read_sources_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".oikb.yaml").to_string_lossy().to_string();

        write_sources(path.clone(), sample_sources()).unwrap();
        let read_back = read_sources(path).unwrap();

        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].name, "docs");
        assert_eq!(read_back[0].kb_id, "kb-123");
        assert_eq!(read_back[0].interval, "1h");
    }

    #[test]
    fn read_sources_on_missing_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".oikb.yaml").to_string_lossy().to_string();
        assert_eq!(read_sources(path).unwrap(), vec![]);
    }

    #[test]
    fn write_sources_rejects_non_yaml_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sources.json").to_string_lossy().to_string();
        let err = write_sources(path, sample_sources()).unwrap_err();
        assert!(err.contains(".yaml or .yml"));
    }

    #[test]
    fn write_sources_rejects_parent_dir_segments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("..")
            .join("escape.yaml")
            .to_string_lossy()
            .to_string();
        let err = write_sources(path, sample_sources()).unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn write_sources_rejects_relative_path() {
        let err = write_sources("relative/.oikb.yaml".to_string(), sample_sources()).unwrap_err();
        assert!(err.contains("absolute"));
    }

    #[test]
    fn set_global_config_merges_rather_than_replaces() {
        let _guard = ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OIKB_CONFIG_DIR", dir.path());

        set_global_config(Some("http://localhost:3000".to_string()), None).unwrap();
        set_global_config(None, Some("secret-token".to_string())).unwrap();

        let (url, token) = get_global_config().unwrap();
        assert_eq!(url.as_deref(), Some("http://localhost:3000"));
        assert_eq!(token.as_deref(), Some("secret-token"));

        std::env::remove_var("OIKB_CONFIG_DIR");
    }
}
