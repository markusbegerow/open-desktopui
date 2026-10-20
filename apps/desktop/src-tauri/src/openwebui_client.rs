//! Open WebUI client: model listing + streaming chat completions.
//!
//! Shapes below are captured from a live instance (not guessed) — see the
//! project plan's "M2 execution plan" addendum:
//!   - `GET /api/models` -> `{"data": [{"id": "...", "name": "...", ...}, ...]}`
//!   - `POST /api/chat/completions` (stream:true) -> SSE lines of the form
//!     `data: {"choices":[{"delta":{"content":"..."},"finish_reason":null,...}],...}`
//!     terminated by a final `data: [DONE]` line. This is the standard
//!     OpenAI chat-completion-chunk shape.
//!
//! Routed through reqwest (not the webview's `fetch`) so this isn't at the
//! mercy of the target server's CORS configuration — same reasoning as
//! `test_connection` below.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub files: Option<Vec<MessageFileRef>>,
}

// `type` is kept as a plain string (not an enum) so an unexpected value from
// a live server round-trips untouched instead of failing to deserialize.
#[derive(Serialize, Deserialize, Clone)]
pub struct MessageFileRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct UploadedFile {
    pub id: String,
    pub filename: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatChunk {
    #[serde(rename_all = "camelCase")]
    Delta { content: String },
    #[serde(rename_all = "camelCase")]
    Done {
        // Best-effort: llama.cpp-backed servers (like this user's) include a
        // `timings` block on the final SSE chunk with prompt/completion
        // token counts. Not every Open WebUI backend provides this — when
        // absent, both are `None` and the caller just doesn't count that
        // message towards the token stat.
        prompt_tokens: Option<u32>,
        completion_tokens: Option<u32>,
    },
    Error { message: String },
}

#[derive(Serialize, Clone)]
pub struct OpenWebUiModel {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
}

pub async fn test_connection(base_url: String, api_key: Option<String>) -> Result<Value, String> {
    let url = format!("{}/api/models", base_url.trim_end_matches('/'));
    let mut req = reqwest::Client::new().get(&url);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        log::error!("[openwebui] request to {url} failed: {}", resp.status());
        return Err(format!("server responded with status {}", resp.status()));
    }

    resp.json::<Value>()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))
}

pub async fn list_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<OpenWebUiModel>, String> {
    let url = format!("{}/api/models", base_url.trim_end_matches('/'));
    let mut req = reqwest::Client::new().get(&url);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        log::error!("[openwebui] request to {url} failed: {}", resp.status());
        return Err(format!("server responded with status {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    let models = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("response had no `data` array")?
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let name = m
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(OpenWebUiModel { id, name })
        })
        .collect();

    Ok(models)
}

/// `GET /api/v1/knowledge/` -> `{"items": [{"id": "...", "name": "...", ...}, ...], "total": N}`
/// — captured live against this user's server.
pub async fn list_knowledge_bases(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<KnowledgeBase>, String> {
    let url = format!("{}/api/v1/knowledge/", base_url.trim_end_matches('/'));
    let mut req = reqwest::Client::new().get(&url);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        log::error!("[openwebui] request to {url} failed: {}", resp.status());
        return Err(format!("server responded with status {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    let items = body
        .get("items")
        .and_then(|d| d.as_array())
        .ok_or("response had no `items` array")?
        .iter()
        .filter_map(|kb| {
            let id = kb.get("id")?.as_str()?.to_string();
            let name = kb
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(KnowledgeBase { id, name })
        })
        .collect();

    Ok(items)
}

/// `POST /api/v1/auths/signin` with `{"email", "password"}` -> on success, a
/// JSON object containing a `token` field (session JWT) — request field
/// names confirmed live (a validation error against this server named
/// exactly `email`/`password`); the success response shape follows Open
/// WebUI's documented convention and is exercised for real the first time a
/// user actually signs in through `LoginView`.
pub async fn login(base_url: String, email: String, password: String) -> Result<String, String> {
    let url = format!("{}/api/v1/auths/signin", base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] sign-in to {url} failed: {status}");
        return Err(format!("sign-in failed ({status}): {body}"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    body.get("token")
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
        .ok_or_else(|| format!("sign-in succeeded but response had no `token` field: {body}"))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrentUser {
    pub id: Option<String>,
    pub name: Option<String>,
    pub detected_language: Option<String>,
    pub profile_image_url: Option<String>,
}

/// ASSUMPTION — NOT YET VERIFIED against a live instance: Open WebUI's user
/// info response has never been confirmed to expose a language/locale field
/// at all. Best-effort check of a couple of plausible field paths; `None` if
/// neither is present, so callers always have a defined fallback (English).
fn extract_detected_language(body: &Value) -> Option<String> {
    body.get("language")
        .or_else(|| body.get("locale"))
        .or_else(|| body.get("settings")?.get("ui")?.get("language"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

/// `GET /api/v1/auths/` -> current session's user info, including `id` and
/// `name` — shape captured live against this user's server:
/// `{"id","name","role","email","profile_image_url",...}`. Called right
/// after sign-in to auto-fill the display name and to derive a stable
/// per-account key (`id` + server URL) for scoping local chat history —
/// rather than guessing whether the signin response itself repeats these
/// fields.
pub async fn get_current_user(base_url: String, token: String) -> Result<CurrentUser, String> {
    let url = format!("{}/api/v1/auths/", base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        log::error!("[openwebui] request to {url} failed: {}", resp.status());
        return Err(format!("server responded with status {}", resp.status()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    Ok(CurrentUser {
        id: body.get("id").and_then(|n| n.as_str()).map(|n| n.to_string()),
        name: body.get("name").and_then(|n| n.as_str()).map(|n| n.to_string()),
        detected_language: extract_detected_language(&body),
        profile_image_url: body
            .get("profile_image_url")
            .and_then(|n| n.as_str())
            .map(|n| n.to_string()),
    })
}

/// A folder as Open WebUI reports it. `system_prompt` comes from the folder's
/// `data` object, which the list endpoint omits, so it is `None` when the
/// per-folder lookup failed (`system_prompt_known = false`) and the caller
/// should keep whatever it already has.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon: Option<String>,
    pub is_expanded: bool,
    pub system_prompt: Option<String>,
    pub system_prompt_known: bool,
}

fn parse_server_folder(body: &Value) -> Result<ServerFolder, String> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("folder response had no `id`: {body}"))?
        .to_string();
    let data = body.get("data").filter(|d| d.is_object());
    Ok(ServerFolder {
        id,
        name: body
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        parent_id: body
            .get("parent_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        icon: body
            .get("meta")
            .and_then(|m| m.get("icon"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        is_expanded: body
            .get("is_expanded")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        system_prompt: data
            .and_then(|d| d.get("system_prompt"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        system_prompt_known: body.get("data").is_some(),
    })
}

async fn folder_request(
    method: reqwest::Method,
    base_url: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = reqwest::Client::new()
        .request(method, &url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(15));
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] folder request to {url} failed: {status}");
        return Err(format!("folder request failed ({status}): {text}"));
    }
    // Some routes answer with an empty body or a bare `true`.
    let text = resp.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected response body: {e}"))
}

/// `GET /api/v1/folders/` plus one `GET /api/v1/folders/{id}` per folder for
/// the system prompt (shape taken from Open WebUI's `routers/folders.py`;
/// not yet exercised against this user's server). A 403 here means the
/// folders feature is disabled or not permitted for the account.
pub async fn list_folders(base_url: String, token: String) -> Result<Vec<ServerFolder>, String> {
    let list = folder_request(reqwest::Method::GET, &base_url, "/api/v1/folders/", &token, None).await?;
    let items = list
        .as_array()
        .ok_or_else(|| format!("unexpected folders response: {list}"))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let mut folder = parse_server_folder(item)?;
        match folder_request(
            reqwest::Method::GET,
            &base_url,
            &format!("/api/v1/folders/{}", folder.id),
            &token,
            None,
        )
        .await
        .and_then(|detail| parse_server_folder(&detail))
        {
            Ok(detail) => {
                folder.system_prompt = detail.system_prompt;
                folder.system_prompt_known = detail.system_prompt_known;
            }
            Err(e) => {
                log::warn!("[openwebui] could not load folder {}: {e}", folder.id);
                folder.system_prompt_known = false;
            }
        }
        out.push(folder);
    }
    Ok(out)
}

fn folder_form(name: Option<&str>, system_prompt: Option<&str>, icon: Option<&str>) -> Value {
    let mut form = serde_json::Map::new();
    if let Some(name) = name {
        form.insert("name".into(), Value::String(name.to_string()));
    }
    if let Some(prompt) = system_prompt {
        form.insert("data".into(), serde_json::json!({ "system_prompt": prompt }));
    }
    if let Some(icon) = icon {
        form.insert("meta".into(), serde_json::json!({ "icon": icon }));
    }
    Value::Object(form)
}

pub async fn create_folder(
    base_url: String,
    token: String,
    name: String,
    parent_id: Option<String>,
    system_prompt: Option<String>,
    icon: Option<String>,
) -> Result<ServerFolder, String> {
    let mut body = folder_form(Some(&name), system_prompt.as_deref(), icon.as_deref());
    if let Some(parent) = parent_id {
        body["parent_id"] = Value::String(parent);
    }
    let created = folder_request(reqwest::Method::POST, &base_url, "/api/v1/folders/", &token, Some(body)).await?;
    parse_server_folder(&created)
}

/// Updates any of name / system prompt / icon. Sending `Some("")` clears a
/// prompt or icon (the server merges `data`/`meta` rather than replacing them).
pub async fn update_folder(
    base_url: String,
    token: String,
    id: String,
    name: Option<String>,
    system_prompt: Option<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let body = folder_form(name.as_deref(), system_prompt.as_deref(), icon.as_deref());
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/folders/{id}/update"),
        &token,
        Some(body),
    )
    .await
    .map(|_| ())
}

pub async fn update_folder_parent(
    base_url: String,
    token: String,
    id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/folders/{id}/update/parent"),
        &token,
        Some(serde_json::json!({ "parent_id": parent_id })),
    )
    .await
    .map(|_| ())
}

pub async fn update_folder_expanded(
    base_url: String,
    token: String,
    id: String,
    is_expanded: bool,
) -> Result<(), String> {
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/folders/{id}/update/expanded"),
        &token,
        Some(serde_json::json!({ "is_expanded": is_expanded })),
    )
    .await
    .map(|_| ())
}

/// `delete_contents=false` keeps the folder's chats (they become unfiled);
/// the server default would delete them. Subfolders are always removed
/// server-side, so callers re-parent them first.
pub async fn delete_folder(base_url: String, token: String, id: String) -> Result<(), String> {
    folder_request(
        reqwest::Method::DELETE,
        &base_url,
        &format!("/api/v1/folders/{id}?delete_contents=false"),
        &token,
        None,
    )
    .await
    .map(|_| ())
}

/// `POST /api/v1/chats/{id}/folder` with `{"folder_id": ...}` (`null` unfiles).
pub async fn move_chat_to_folder(
    base_url: String,
    token: String,
    chat_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/chats/{chat_id}/folder"),
        &token,
        Some(serde_json::json!({ "folder_id": folder_id })),
    )
    .await
    .map(|_| ())
}

const MAX_PROFILE_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Resolves `image_url` (possibly relative) against `base_url` and returns it
/// only if it points at the same origin as the server, so the bearer token is
/// never sent anywhere else.
fn resolve_same_origin(base_url: &str, image_url: &str) -> Result<reqwest::Url, String> {
    let base = reqwest::Url::parse(base_url.trim_end_matches('/'))
        .map_err(|e| format!("invalid server URL: {e}"))?;
    let resolved = base
        .join(image_url)
        .map_err(|e| format!("invalid image URL: {e}"))?;
    if resolved.origin() != base.origin() {
        return Err("profile image is hosted on a different server".into());
    }
    Ok(resolved)
}

/// Downloads the account's profile image from the Open WebUI server (the
/// route may require the bearer token). Only same-origin URLs are fetched.
pub async fn fetch_profile_image(
    base_url: String,
    token: String,
    image_url: String,
) -> Result<Vec<u8>, String> {
    let url = resolve_same_origin(&base_url, &image_url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))?;
    let resp = client
        .get(url.clone())
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("server responded with status {}", resp.status()));
    }
    let is_image = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("image/"));
    if !is_image {
        return Err("profile image response was not an image".into());
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("could not read profile image: {e}"))?;
    if bytes.len() > MAX_PROFILE_IMAGE_BYTES {
        return Err("profile image is too large (max 5 MB)".into());
    }
    Ok(bytes.to_vec())
}

/// ASSUMPTION — NOT YET VERIFIED against a live instance (unlike the routes
/// documented above, which were captured from this user's running server).
/// Standard Open WebUI shape to start from:
///   `POST /api/v1/files/`, multipart field `file`, Bearer auth
///   -> `{"id": "...", "filename": "...", ...}`. Confirm against a live
///   server and adjust `parse_uploaded_file` below if the field names
///   differ — that is the only place this needs to change.
pub async fn upload_file(
    base_url: String,
    api_key: Option<String>,
    file_path: String,
) -> Result<UploadedFile, String> {
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("could not read {file_path}: {e}"))?;
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let url = format!("{}/api/v1/files/", base_url.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.clone());
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut req = reqwest::Client::new().post(&url).multipart(form);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] upload to {url} failed: {status}");
        return Err(format!("upload failed ({status}): {body}"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    parse_uploaded_file(&body, &filename)
}

fn parse_uploaded_file(body: &Value, fallback_filename: &str) -> Result<UploadedFile, String> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("upload succeeded but response had no `id` field: {body}"))?
        .to_string();
    let filename = body
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback_filename)
        .to_string();
    Ok(UploadedFile { id, filename })
}

/// ASSUMPTION — NOT YET VERIFIED against a live instance (unlike the routes
/// documented above, which were captured from this user's running server).
/// Standard Open WebUI shape to start from:
///   `POST /api/v1/audio/transcriptions`, multipart field `file`, Bearer auth
///   -> `{"text": "..."}`. Confirm against a live server and adjust
///   `parse_transcription_response` below if the field name differs — that
///   is the only place this needs to change.
pub async fn transcribe_audio(
    base_url: String,
    api_key: Option<String>,
    audio_bytes: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    let url = format!("{}/api/v1/audio/transcriptions", base_url.trim_end_matches('/'));
    // `mime_type` is `MediaRecorder`'s actual `blob.type`, typically
    // "audio/webm;codecs=opus" — strip the `;codecs=...` parameter before
    // deriving a file extension, or the server rejects the resulting
    // filename (e.g. "recording.webm;codecs=opus") as an invalid extension.
    let base_mime = mime_type.split(';').next().unwrap_or(&mime_type);
    let extension = base_mime.split('/').nth(1).unwrap_or("webm");
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(format!("recording.{extension}"))
        .mime_str(&mime_type)
        .map_err(|e| format!("invalid mime type {mime_type}: {e}"))?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut req = reqwest::Client::new().post(&url).multipart(form);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] transcription request to {url} failed: {status}");
        return Err(format!("transcription failed ({status}): {body}"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    parse_transcription_response(&body)
}

fn parse_transcription_response(body: &Value) -> Result<String, String> {
    body.get("text")
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
        .ok_or_else(|| format!("transcription succeeded but response had no `text` field: {body}"))
}

/// ASSUMPTION — NOT YET VERIFIED against a live instance, and a bigger
/// unknown than the other unverified routes above: Open WebUI's chat storage
/// format is a nested structure mirroring its own frontend's internal chat
/// state (a `history` map of messages keyed by id, with `parentId`/
/// `childrenIds` links, plus a flat `messages` array), not a simple flat
/// list. Standard shape to start from:
///   `POST /api/v1/chats/new`, body `{"chat": {"title","models":[...],
///   "messages":[...],"history":{"messages":{...},"currentId":...}}}` ->
///   response includes the created chat's `id`. Built here as a simple
///   linear chain (no branching, since this app has none) — confirm against
///   a live server and adjust `parse_created_chat`/this body shape if it
///   differs.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatedChat {
    pub id: String,
    // Ordered to match the `messages` list passed in — generated by us (see
    // below), not returned by the server, so this is exact by construction.
    pub message_ids: Vec<String>,
}

pub async fn create_chat(
    base_url: String,
    api_key: Option<String>,
    title: String,
    model: String,
    messages: Vec<ChatMessage>,
    folder_id: Option<String>,
) -> Result<CreatedChat, String> {
    let url = format!("{}/api/v1/chats/new", base_url.trim_end_matches('/'));

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Only need to be unique within this one request's message list — no
    // need to pull in a UUID crate for that.
    let ids: Vec<String> = (0..messages.len()).map(|i| format!("msg-{now}-{i}")).collect();

    let mut history_messages = serde_json::Map::new();
    let mut flat_messages: Vec<Value> = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        let parent_id = if i == 0 {
            Value::Null
        } else {
            Value::String(ids[i - 1].clone())
        };
        let children_ids: Vec<Value> = if i + 1 < ids.len() {
            vec![Value::String(ids[i + 1].clone())]
        } else {
            vec![]
        };
        let entry = serde_json::json!({
            "id": ids[i],
            "parentId": parent_id,
            "childrenIds": children_ids,
            "role": m.role,
            "content": m.content,
            "timestamp": now,
        });
        history_messages.insert(ids[i].clone(), entry.clone());
        flat_messages.push(entry);
    }
    let current_id = ids.last().cloned();

    let mut body = serde_json::json!({
        "chat": {
            "title": title,
            "models": [model],
            "messages": flat_messages,
            "history": {
                "messages": Value::Object(history_messages),
                "currentId": current_id,
            },
        }
    });
    if let Some(folder_id) = folder_id {
        body["folder_id"] = Value::String(folder_id);
    }

    let mut req = reqwest::Client::new().post(&url).json(&body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] create-chat request to {url} failed: {status}");
        return Err(format!("could not create chat ({status}): {body}"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response body: {e}"))?;

    let id = parse_created_chat(&body)?;
    Ok(CreatedChat { id, message_ids: ids })
}

fn parse_created_chat(body: &Value) -> Result<String, String> {
    body.get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("chat created but response had no `id` field: {body}"))
}

/// ASSUMPTION — NOT YET VERIFIED against a live instance. Standard Open WebUI
/// shape to start from:
///   `POST /api/v1/feedbacks/`, body
///   `{"type":"rating","data":{"rating":1|0|-1},
///     "meta":{"chat_id":...,"message_id":...,"model_id":...}}`
/// -> 200 on success. Confirm against a live server and adjust the body
/// shape here if it differs — this is the only place that needs to change.
pub async fn rate_message(
    base_url: String,
    api_key: Option<String>,
    chat_id: String,
    message_id: String,
    model: String,
    rating: i32,
) -> Result<(), String> {
    let url = format!("{}/api/v1/feedbacks/", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "type": "rating",
        "data": { "rating": rating },
        "meta": { "chat_id": chat_id, "message_id": message_id, "model_id": model },
    });

    let mut req = reqwest::Client::new().post(&url).json(&body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] feedback request to {url} failed: {status}");
        return Err(format!("could not send feedback ({status}): {body}"));
    }

    Ok(())
}

/// Per-request cancellation for streaming chats, keyed by a request id the
/// frontend chooses, so stopping one window's reply never stops another's.
#[derive(Default)]
pub struct ChatCancel(std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<CancelToken>>>);

#[derive(Default)]
pub struct CancelToken {
    flag: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl ChatCancel {
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, std::sync::Arc<CancelToken>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn register(&self, id: &str) -> std::sync::Arc<CancelToken> {
        let token = std::sync::Arc::new(CancelToken::default());
        self.lock().insert(id.to_string(), token.clone());
        token
    }

    pub fn unregister(&self, id: &str) {
        self.lock().remove(id);
    }

    /// Returns whether a request with this id was still running.
    pub fn cancel(&self, id: &str) -> bool {
        match self.lock().get(id) {
            Some(token) => {
                token.flag.store(true, std::sync::atomic::Ordering::SeqCst);
                token.notify.notify_waiters();
                true
            }
            None => false,
        }
    }
}

impl CancelToken {
    fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub async fn stream_chat_completion(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    knowledge_ids: Vec<String>,
    channel: Channel<ChatChunk>,
    cancel: std::sync::Arc<CancelToken>,
) -> Result<(), String> {
    let url = format!("{}/api/chat/completions", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": true });
    // Open WebUI's completion pipeline reads file/collection references from
    // the top-level `files` array to inject RAG context — a per-message
    // `files` field (still sent on each serialized `ChatMessage` above) isn't
    // read for this, so attachments need to be merged in here too, the same
    // way knowledge-base collections already are.
    let mut files: Vec<Value> = knowledge_ids
        .iter()
        .map(|id| serde_json::json!({ "type": "collection", "id": id }))
        .collect();
    for m in &messages {
        if let Some(refs) = &m.files {
            for f in refs {
                files.push(serde_json::json!({ "type": f.kind, "id": f.id }));
            }
        }
    }
    if !files.is_empty() {
        body["files"] = Value::Array(files);
    }
    // No overall timeout (replies can legitimately stream for minutes), but
    // an unreachable server must fail fast instead of hanging the composer.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    // Registered before awaiting so a stop pressed while connecting works.
    let notified = cancel.notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    if cancel.is_cancelled() {
        let _ = channel.send(SseParser::default().done_chunk());
        return Ok(());
    }
    let sent = tokio::select! {
        r = req.send() => Some(r),
        _ = &mut notified => None,
    };
    let Some(sent) = sent else {
        let _ = channel.send(SseParser::default().done_chunk());
        return Ok(());
    };
    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            let _ = channel.send(ChatChunk::Error {
                message: format!("could not reach {url}: {e}"),
            });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::error!("[openwebui] chat completion request to {url} failed: {status}");
        let _ = channel.send(ChatChunk::Error {
            message: format!("server responded with status {status}: {body}"),
        });
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::default();

    loop {
        // Enabled before the flag check so a cancel can't slip in between.
        let notified = cancel.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if cancel.is_cancelled() {
            // User pressed Stop: end cleanly, keeping what has streamed so far.
            let _ = channel.send(parser.done_chunk());
            return Ok(());
        }
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = &mut notified => {
                let _ = channel.send(parser.done_chunk());
                return Ok(());
            }
        };
        let Some(chunk) = next else { break };
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = channel.send(ChatChunk::Error {
                    message: format!("stream error: {e}"),
                });
                return Ok(());
            }
        };
        if forward_events(parser.feed(&bytes), &parser, &channel) {
            return Ok(());
        }
    }

    // EOF: a final `data:` line may lack its trailing newline.
    if forward_events(parser.finish(), &parser, &channel) {
        return Ok(());
    }
    if parser.finished_cleanly() {
        let _ = channel.send(parser.done_chunk());
    } else {
        let _ = channel.send(ChatChunk::Error {
            message: "the connection closed before the reply was complete".to_string(),
        });
    }
    Ok(())
}

/// Sends parsed events to the frontend. Returns `true` when the stream is
/// over (`[DONE]`, a server error, or the frontend dropped the channel — in
/// which case we stop pulling a generation nobody is reading).
fn forward_events(events: Vec<SseEvent>, parser: &SseParser, channel: &Channel<ChatChunk>) -> bool {
    for event in events {
        let (chunk, last) = match event {
            SseEvent::Delta(content) => (ChatChunk::Delta { content }, false),
            SseEvent::Error(message) => (ChatChunk::Error { message }, true),
            SseEvent::Done => (parser.done_chunk(), true),
        };
        if channel.send(chunk).is_err() || last {
            return true;
        }
    }
    false
}

enum SseEvent {
    Delta(String),
    Error(String),
    Done,
}

/// Incremental parser for Open WebUI's SSE completion stream. Works on bytes
/// and only decodes complete lines, so a multi-byte character split across
/// two network chunks is never corrupted.
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    saw_finish_reason: bool,
}

impl SseParser {
    fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.handle_line(&line, &mut events);
        }
        events
    }

    /// Processes whatever is left after EOF as a last, unterminated line.
    fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.handle_line(&line, &mut events);
        }
        events
    }

    /// EOF without `[DONE]` is only a normal end if the model reported a
    /// finish reason; otherwise the reply was cut off.
    fn finished_cleanly(&self) -> bool {
        self.saw_finish_reason
    }

    fn done_chunk(&self) -> ChatChunk {
        ChatChunk::Done {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
        }
    }

    fn handle_line(&mut self, raw: &[u8], events: &mut Vec<SseEvent>) {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim_end_matches(['\r', '\n']);
        // SSE allows `data:` with or without a following space.
        let Some(data) = line.strip_prefix("data:") else {
            return;
        };
        let data = data.strip_prefix(' ').unwrap_or(data);
        if data == "[DONE]" {
            events.push(SseEvent::Done);
            return;
        }
        if data.is_empty() {
            return;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(err) = json.get("error") {
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| err.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| err.to_string());
            events.push(SseEvent::Error(message));
            return;
        }
        let choice = json.get("choices").and_then(|c| c.get(0));
        if let Some(content) = choice
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
        {
            if !content.is_empty() {
                events.push(SseEvent::Delta(content.to_string()));
            }
        }
        if choice
            .and_then(|c| c.get("finish_reason"))
            .is_some_and(|f| !f.is_null())
        {
            self.saw_finish_reason = true;
        }
        // llama.cpp-style `timings` on the terminal chunk (see module docs).
        if let Some(timings) = json.get("timings") {
            self.prompt_tokens = timings
                .get("prompt_n")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or(self.prompt_tokens);
            self.completion_tokens = timings
                .get("predicted_n")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or(self.completion_tokens);
        }
        // OpenAI-style `usage` (present on some providers even mid-stream).
        if let Some(usage) = json.get("usage") {
            self.prompt_tokens = usage
                .get("prompt_tokens")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or(self.prompt_tokens);
            self.completion_tokens = usage
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or(self.completion_tokens);
        }
    }
}

#[cfg(test)]
mod folder_tests {
    use super::*;

    #[test]
    fn parses_a_list_entry_without_data() {
        let f = parse_server_folder(&serde_json::json!({
            "id": "f1", "name": "Work", "parent_id": null,
            "meta": {"icon": "briefcase"}, "is_expanded": true
        }))
        .unwrap();
        assert_eq!(f.id, "f1");
        assert_eq!(f.icon.as_deref(), Some("briefcase"));
        assert!(f.is_expanded);
        assert_eq!(f.system_prompt, None);
        assert!(!f.system_prompt_known);
    }

    #[test]
    fn parses_the_system_prompt_from_data() {
        let f = parse_server_folder(&serde_json::json!({
            "id": "f2", "name": "Sub", "parent_id": "f1",
            "data": {"system_prompt": "Be brief"}
        }))
        .unwrap();
        assert_eq!(f.parent_id.as_deref(), Some("f1"));
        assert_eq!(f.system_prompt.as_deref(), Some("Be brief"));
        assert!(f.system_prompt_known);
    }

    #[test]
    fn rejects_a_response_without_an_id() {
        assert!(parse_server_folder(&serde_json::json!({"name": "x"})).is_err());
    }

    #[test]
    fn folder_form_only_includes_given_fields() {
        let form = folder_form(Some("A"), None, Some("star"));
        assert_eq!(form, serde_json::json!({"name": "A", "meta": {"icon": "star"}}));
        assert_eq!(folder_form(None, Some(""), None), serde_json::json!({"data": {"system_prompt": ""}}));
    }
}

#[cfg(test)]
mod profile_image_tests {
    use super::*;

    #[test]
    fn resolves_relative_paths_against_the_server() {
        let url = resolve_same_origin("https://chat.example.com/", "/api/v1/users/1/profile/image").unwrap();
        assert_eq!(url.as_str(), "https://chat.example.com/api/v1/users/1/profile/image");
    }

    #[test]
    fn accepts_absolute_urls_on_the_same_origin() {
        assert!(resolve_same_origin("http://localhost:3000", "http://localhost:3000/user.png").is_ok());
    }

    #[test]
    fn rejects_other_origins() {
        assert!(resolve_same_origin("https://chat.example.com", "https://evil.example.org/a.png").is_err());
        assert!(resolve_same_origin("http://localhost:3000", "http://localhost:3001/a.png").is_err());
    }
}

#[cfg(test)]
mod sse_tests {
    use super::*;

    #[test]
    fn cancel_targets_only_the_given_request() {
        let state = ChatCancel::default();
        let a = state.register("a");
        let b = state.register("b");
        assert!(state.cancel("a"));
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
        state.unregister("a");
        assert!(!state.cancel("a"));
    }

    fn deltas(events: &[SseEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                SseEvent::Delta(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn multibyte_character_split_across_chunks_survives() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"Grüße 🙂\"}}]}\n";
        let bytes = line.as_bytes();
        // Cut inside the two-byte "ü" and inside the four-byte emoji.
        let ue = line.find('ü').unwrap() + 1;
        let emoji = line.find('🙂').unwrap() + 2;
        let mut parser = SseParser::default();
        let mut out = String::new();
        for part in [&bytes[..ue], &bytes[ue..emoji], &bytes[emoji..]] {
            out.push_str(&deltas(&parser.feed(part)));
        }
        assert_eq!(out, "Grüße 🙂");
    }

    #[test]
    fn data_prefix_without_space_and_crlf_are_accepted() {
        let mut parser = SseParser::default();
        let events = parser.feed(b"data:{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n");
        assert_eq!(deltas(&events), "hi");
    }

    #[test]
    fn last_line_without_newline_is_processed_on_finish() {
        let mut parser = SseParser::default();
        assert!(parser
            .feed(b"data: {\"timings\":{\"prompt_n\":3,\"predicted_n\":7}}")
            .is_empty());
        parser.finish();
        match parser.done_chunk() {
            ChatChunk::Done {
                prompt_tokens,
                completion_tokens,
            } => {
                assert_eq!(prompt_tokens, Some(3));
                assert_eq!(completion_tokens, Some(7));
            }
            _ => panic!("expected Done"),
        }
    }

    #[test]
    fn mid_stream_error_object_is_reported() {
        let mut parser = SseParser::default();
        let events = parser.feed(b"data: {\"error\":{\"message\":\"model overloaded\"}}\n");
        assert!(matches!(&events[..], [SseEvent::Error(m)] if m == "model overloaded"));
    }

    #[test]
    fn done_marker_ends_stream_and_eof_without_finish_is_truncation() {
        let mut parser = SseParser::default();
        assert!(matches!(&parser.feed(b"data: [DONE]\n")[..], [SseEvent::Done]));

        let mut cut = SseParser::default();
        cut.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}\n");
        assert!(!cut.finished_cleanly());

        let mut ok = SseParser::default();
        ok.feed(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n");
        assert!(ok.finished_cleanly());
    }
}
