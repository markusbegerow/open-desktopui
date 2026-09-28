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

#[tauri::command]
pub async fn send_chat_message(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    knowledge_ids: Option<Vec<String>>,
    channel: Channel<ChatChunk>,
) -> Result<(), String> {
    openwebui_client::stream_chat_completion(
        base_url,
        api_key,
        model,
        messages,
        knowledge_ids.unwrap_or_default(),
        channel,
    )
    .await
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

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("could not write {path}: {e}"))
        .inspect_err(|e| log::error!("[write_text_file] {e}"))
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
    for suffix in ["", "-wal", "-shm"] {
        let src = dir.join(format!("chat.db{suffix}"));
        if src.exists() {
            let dest = dir.join(format!("chat.db{suffix}.corrupt-{timestamp}"));
            std::fs::rename(&src, &dest).map_err(|e| format!("could not rename {src:?}: {e}"))?;
            log::warn!("[reset_chat_db] moved {src:?} -> {dest:?}");
        }
    }
    app.restart()
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
