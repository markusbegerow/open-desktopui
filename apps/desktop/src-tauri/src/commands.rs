//! Tauri commands exposed to the frontend.
//!
//! M1 scope: read-only status/history from a manually-started oikb daemon,
//! plus a trigger-sync action. Sidecar lifecycle management (spawn/restart
//! the bundled daemon ourselves) lands in M3 per the project plan.

use crate::daemon_sidecar;
use crate::oikb_client;
use crate::oikb_config;
use crate::openwebui_client::{
    self, ChatChunk, ChatMessage, CreatedChat, CurrentUser, KnowledgeBase, OpenWebUiModel, UploadedFile,
};
use serde_json::Value;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn get_daemon_status(api_key: Option<String>) -> Result<Value, String> {
    oikb_client::get_health(api_key).await
}

#[tauri::command]
pub async fn get_daemon_ready() -> Result<bool, String> {
    oikb_client::get_health_ready().await
}

#[tauri::command]
pub async fn get_sync_history(
    api_key: Option<String>,
    limit: Option<u32>,
    kb_id: Option<String>,
    errors_only: Option<bool>,
) -> Result<Value, String> {
    oikb_client::get_history(
        api_key,
        limit.unwrap_or(50),
        kb_id,
        errors_only.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn test_openwebui_connection(
    base_url: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    openwebui_client::test_connection(base_url, api_key).await
}

#[tauri::command]
pub fn set_oikb_global_config(url: Option<String>, token: Option<String>) -> Result<(), String> {
    oikb_config::set_global_config(url, token)
}

#[tauri::command]
pub fn get_oikb_global_config() -> Result<Value, String> {
    let (url, token) = oikb_config::get_global_config()?;
    Ok(serde_json::json!({ "url": url, "token": token }))
}

#[tauri::command]
pub fn write_oikb_sources(
    yaml_path: String,
    sources: Vec<oikb_config::SourceEntry>,
) -> Result<(), String> {
    oikb_config::write_sources(yaml_path, sources)
}

#[tauri::command]
pub fn read_oikb_sources(yaml_path: String) -> Result<Vec<oikb_config::SourceEntry>, String> {
    oikb_config::read_sources(yaml_path)
}

#[tauri::command]
pub fn ensure_default_yaml_path(app: tauri::AppHandle) -> Result<String, String> {
    oikb_config::ensure_default_yaml(&app)
}

#[tauri::command]
pub async fn list_openwebui_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<OpenWebUiModel>, String> {
    openwebui_client::list_models(base_url, api_key).await
}

/// Stops a running `send_chat_message` (the Stop button). A no-op when the
/// reply already finished.
#[tauri::command]
pub fn cancel_chat_message(
    request_id: String,
    cancels: tauri::State<'_, openwebui_client::ChatCancel>,
) {
    cancels.cancel(&request_id);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_chat_message(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    knowledge_ids: Option<Vec<String>>,
    request_id: String,
    channel: Channel<ChatChunk>,
    cancels: tauri::State<'_, openwebui_client::ChatCancel>,
) -> Result<(), String> {
    let token = cancels.register(&request_id);
    let result = openwebui_client::stream_chat_completion(
        base_url,
        api_key,
        model,
        messages,
        knowledge_ids.unwrap_or_default(),
        channel,
        token,
    )
    .await;
    cancels.unregister(&request_id);
    result
}

#[tauri::command]
pub async fn list_knowledge_bases(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<KnowledgeBase>, String> {
    openwebui_client::list_knowledge_bases(base_url, api_key).await
}

#[tauri::command]
pub async fn openwebui_login(
    base_url: String,
    email: String,
    password: String,
) -> Result<String, String> {
    openwebui_client::login(base_url, email, password).await
}

#[tauri::command]
pub async fn get_openwebui_current_user(base_url: String, token: String) -> Result<CurrentUser, String> {
    openwebui_client::get_current_user(base_url, token).await
}

#[tauri::command]
pub async fn trigger_sync(
    api_key: Option<String>,
    identifier: String,
    dry_run: Option<bool>,
) -> Result<Value, String> {
    oikb_client::trigger_sync(api_key, identifier, dry_run.unwrap_or(false)).await
}

#[tauri::command]
pub async fn restart_daemon(
    app: tauri::AppHandle,
    oikb_main_path: String,
    yaml_path: String,
    api_key: Option<String>,
) -> Result<(), String> {
    daemon_sidecar::spawn_daemon(app, oikb_main_path, yaml_path, api_key).await
}

#[tauri::command]
pub fn clear_sync_history() -> Result<(), String> {
    oikb_config::clear_sync_history()
}

/// Asks the user where to save (native dialog) and writes `content` there.
/// The path comes from the dialog on the Rust side rather than from the
/// frontend, so injected script can't use this to write to arbitrary
/// locations. Returns `false` when the user cancels.
#[tauri::command]
pub async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    filter_name: String,
    extension: String,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &[extension.as_str()])
        .blocking_save_file();
    let Some(file) = picked else {
        return Ok(false);
    };
    let path = file
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("could not write {path:?}: {e}"))
        .inspect_err(|e| log::error!("[save_text_file] {e}"))?;
    Ok(true)
}

/// Moves each existing `dir/<name>` to `<name>.<tag>-<timestamp>` rather than
/// deleting it. All-or-nothing: if one rename fails, the ones already done
/// are undone. That matters for SQLite — a main file moved away while a stale
/// `-wal` stays behind would be replayed into the fresh database.
fn move_aside(
    dir: &std::path::Path,
    names: &[&str],
    tag: &str,
    timestamp: u64,
) -> Result<Vec<(std::path::PathBuf, std::path::PathBuf)>, String> {
    let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for name in names {
        let src = dir.join(name);
        if !src.exists() {
            continue;
        }
        let dest = dir.join(format!("{name}.{tag}-{timestamp}"));
        if let Err(e) = std::fs::rename(&src, &dest) {
            for (orig, backup) in moved.iter().rev() {
                let _ = std::fs::rename(backup, orig);
            }
            return Err(format!("could not rename {src:?}: {e}"));
        }
        log::warn!("[move_aside] moved {src:?} -> {dest:?}");
        moved.push((src, dest));
    }
    Ok(moved)
}

#[cfg(test)]
mod move_aside_tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("odui-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_existing_files_and_skips_missing_ones() {
        let dir = temp_dir("moves");
        std::fs::write(dir.join("chat.db"), "main").unwrap();
        std::fs::write(dir.join("chat.db-wal"), "wal").unwrap();
        let moved = move_aside(&dir, &["chat.db-wal", "chat.db-shm", "chat.db"], "corrupt", 42).unwrap();
        assert_eq!(moved.len(), 2);
        assert!(!dir.join("chat.db").exists());
        assert!(!dir.join("chat.db-wal").exists());
        assert_eq!(std::fs::read_to_string(dir.join("chat.db.corrupt-42")).unwrap(), "main");
        assert_eq!(std::fs::read_to_string(dir.join("chat.db-wal.corrupt-42")).unwrap(), "wal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rolls_back_when_a_later_rename_fails() {
        let dir = temp_dir("rollback");
        std::fs::write(dir.join("chat.db"), "main").unwrap();
        std::fs::write(dir.join("chat.db-wal"), "wal").unwrap();
        // A non-empty directory squatting on the main file's backup name makes
        // that rename fail after the WAL has already been moved.
        let blocker = dir.join("chat.db.corrupt-7");
        std::fs::create_dir_all(&blocker).unwrap();
        std::fs::write(blocker.join("keep"), "x").unwrap();

        let result = move_aside(&dir, &["chat.db-wal", "chat.db"], "corrupt", 7);
        assert!(result.is_err());
        // Nothing was lost or half-moved: both originals are back in place.
        assert_eq!(std::fs::read_to_string(dir.join("chat.db")).unwrap(), "main");
        assert_eq!(std::fs::read_to_string(dir.join("chat.db-wal")).unwrap(), "wal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_vault_is_not_an_error() {
        let dir = temp_dir("novault");
        assert!(move_aside(&dir, &["vault.hold"], "bak", 1).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Last-resort recovery for a `chat.db` too corrupted to open/query: moves
/// it (and its `-wal`/`-shm` WAL-mode siblings, if present) aside rather than
/// deleting outright, so a fresh empty database can be created in its place
/// on next launch. `tauri-plugin-sql` only opens/creates its connection pool
/// once at startup, so a plain frontend `window.location.reload()` would
/// reuse the same Rust-side pool rather than reopening it — this restarts
/// the whole app process (`AppHandle::restart`, built into Tauri core, no
/// extra plugin needed) so the fresh file actually gets picked up.
#[tauri::command]
pub fn reset_chat_db(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // WAL/SHM siblings first and the main file last (see `move_aside`).
    move_aside(
        &dir,
        &["chat.db-wal", "chat.db-shm", "chat.db"],
        "corrupt",
        timestamp,
    )?;
    restart_app(&app);
    Ok(())
}

/// `AppHandle::restart` starts the new process while this one is still alive,
/// so `tauri-plugin-single-instance` makes the new one quit immediately and
/// the app just seems to do nothing. On Windows we therefore launch the new
/// instance after a short delay (once this process has exited) and then exit.
fn restart_app(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(exe) = tauri::utils::platform::current_exe() {
            let spawned = std::process::Command::new("cmd")
                .raw_arg(format!(
                    "/C ping -n 3 127.0.0.1 >nul & start \"\" \"{}\"",
                    exe.display()
                ))
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn();
            match spawned {
                Ok(_) => {
                    app.exit(0);
                    return;
                }
                Err(e) => log::error!("[restart_app] delayed spawn failed: {e}"),
            }
        }
    }
    app.restart()
}

/// Recovery for a `vault.hold` that can't be decrypted (e.g. `BadFileKey`
/// because the stored passphrase no longer matches): moves it aside instead
/// of deleting it so the frontend can create a fresh vault. Unlike
/// `reset_chat_db` no restart is needed — a failed `Stronghold.load` leaves
/// nothing registered on the Rust side.
#[tauri::command]
pub fn reset_vault(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("could not resolve app local data dir: {e}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    move_aside(&dir, &["vault.hold"], "bak", timestamp)?;
    Ok(())
}

/// Forwards a frontend-side log line into the same log sink `tauri-plugin-log`
/// writes to (see `lib/log.ts`), so a bug report can attach one combined log
/// instead of a separate browser console dump — `level` is one of
/// "error"/"warn"/"info", defaulting to "info" for anything else.
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[frontend] {message}"),
        "warn" => log::warn!("[frontend] {message}"),
        _ => log::info!("[frontend] {message}"),
    }
}

#[tauri::command]
pub fn set_keep_running_in_tray(state: tauri::State<crate::KeepRunningInTray>, enabled: bool) {
    state.0.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn upload_openwebui_file(
    base_url: String,
    api_key: Option<String>,
    file_path: String,
) -> Result<UploadedFile, String> {
    openwebui_client::upload_file(base_url, api_key, file_path).await
}

#[tauri::command]
pub async fn create_openwebui_chat(
    base_url: String,
    api_key: Option<String>,
    title: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<CreatedChat, String> {
    openwebui_client::create_chat(base_url, api_key, title, model, messages).await
}

#[tauri::command]
pub async fn rate_openwebui_message(
    base_url: String,
    api_key: Option<String>,
    chat_id: String,
    message_id: String,
    model: String,
    rating: i32,
) -> Result<(), String> {
    openwebui_client::rate_message(base_url, api_key, chat_id, message_id, model, rating).await
}

#[tauri::command]
pub async fn transcribe_audio(
    base_url: String,
    api_key: Option<String>,
    audio_bytes: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    openwebui_client::transcribe_audio(base_url, api_key, audio_bytes, mime_type).await
}
