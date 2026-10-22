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
    /// Text of a model's reasoning, streamed separately from the answer
    /// (`delta.reasoning_content` / `reasoning` / `thinking`). Reasoning that
    /// arrives inside the answer as `<think>…</think>` stays in `Delta` and is
    /// split out by the frontend.
    #[serde(rename_all = "camelCase")]
    Reasoning { content: String },
    /// Documents Open WebUI retrieved for the answer (knowledge bases, web
    /// search): the `sources` array it sends as a data line before the text.
    /// Kept as raw JSON; the frontend normalizes it for display.
    #[serde(rename_all = "camelCase")]
    Sources { sources: Vec<Value> },
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

/// What a model can do, from its `info.meta.capabilities`. Open WebUI treats a
/// capability the model doesn't mention as available, so absent means true.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub vision: bool,
    pub web_search: bool,
    pub image_generation: bool,
    pub code_interpreter: bool,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self { vision: true, web_search: true, image_generation: true, code_interpreter: true }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenWebUiModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub capabilities: ModelCapabilities,
    /// A model set up in the server's workspace (a preset), as opposed to a
    /// raw model of a connection.
    pub workspace: bool,
}

fn parse_model(m: &Value) -> Option<OpenWebUiModel> {
    let id = m.get("id")?.as_str()?.to_string();
    let name = m.get("name").and_then(|n| n.as_str()).unwrap_or(&id).to_string();
    let info = m.get("info").filter(|i| i.is_object());
    let meta = info.and_then(|i| i.get("meta"));
    let flag = |key: &str| {
        meta.and_then(|m| m.get("capabilities"))
            .and_then(|c| c.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };
    let tags = meta
        .and_then(|m| m.get("tags"))
        .and_then(|t| t.as_array())
        .map(|tags| {
            tags.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).or_else(|| t.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(OpenWebUiModel {
        id,
        name,
        description: meta
            .and_then(|m| m.get("description"))
            .and_then(|d| d.as_str())
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string),
        tags,
        capabilities: ModelCapabilities {
            vision: flag("vision"),
            web_search: flag("web_search"),
            image_generation: flag("image_generation"),
            code_interpreter: flag("code_interpreter"),
        },
        workspace: info.is_some(),
    })
}

/// Which optional features the server itself has switched on (`/api/config`).
/// `None` = the config doesn't say, so the feature is offered and the server
/// decides.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFeatures {
    pub web_search: Option<bool>,
    pub image_generation: Option<bool>,
    pub code_interpreter: Option<bool>,
    pub memory: Option<bool>,
}

fn parse_server_features(config: &Value) -> ServerFeatures {
    let features = config.get("features");
    let flag = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| features.and_then(|f| f.get(*k)).and_then(|v| v.as_bool()))
    };
    ServerFeatures {
        web_search: flag(&["enable_web_search"]),
        image_generation: flag(&["enable_image_generation"]),
        code_interpreter: flag(&["enable_code_interpreter", "enable_code_execution"]),
        memory: flag(&["enable_memories"]),
    }
}

/// `GET /api/config` (public). Best effort: an unreachable or odd answer means
/// "unknown", never an error the user has to deal with.
pub async fn get_server_features(base_url: String) -> ServerFeatures {
    let url = format!("{}/api/config", base_url.trim_end_matches('/'));
    let Ok(resp) = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    else {
        return ServerFeatures::default();
    };
    match resp.json::<Value>().await {
        Ok(config) => parse_server_features(&config),
        Err(_) => ServerFeatures::default(),
    }
}

/// A tool (function) the user may let the model call.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ServerTool {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// `GET /api/v1/tools/`.
pub async fn list_tools(base_url: String, token: String) -> Result<Vec<ServerTool>, String> {
    let list = folder_request(reqwest::Method::GET, &base_url, "/api/v1/tools/", &token, None).await?;
    Ok(list
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| {
                    let id = t.get("id")?.as_str()?.to_string();
                    Some(ServerTool {
                        name: t.get("name").and_then(|n| n.as_str()).unwrap_or(&id).to_string(),
                        description: t
                            .get("meta")
                            .and_then(|m| m.get("description"))
                            .and_then(|d| d.as_str())
                            .filter(|d| !d.trim().is_empty())
                            .map(str::to_string),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
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
        .filter_map(parse_model)
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
    /// Server-side last change (ms); 0 when the server didn't send one.
    pub updated_at: i64,
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
        updated_at: epoch_ms(body.get("updated_at")),
    })
}

async fn folder_request(
    method: reqwest::Method,
    base_url: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    folder_request_timeout(method, base_url, path, token, body, 15).await
}

/// Same as `folder_request` with a custom timeout, for routes where the server
/// runs a model (title generation) and may take a while.
async fn folder_request_timeout(
    method: reqwest::Method,
    base_url: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
    timeout_secs: u64,
) -> Result<Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = reqwest::Client::new()
        .request(method, &url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(timeout_secs));
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

/// Open WebUI reports times in seconds; accept milliseconds too and always
/// return milliseconds (what the local database uses).
fn epoch_ms(v: Option<&Value>) -> i64 {
    let n = v
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0);
    if n > 0 && n < 100_000_000_000 {
        n * 1000 // seconds
    } else if n >= 100_000_000_000_000_000 {
        n / 1_000_000 // nanoseconds (notes)
    } else {
        n
    }
}

/// A prompt from the server's library (`/command` templates).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerPrompt {
    pub id: String,
    /// Without the leading slash.
    pub command: String,
    pub name: String,
    pub content: String,
}

fn parse_prompt(p: &Value) -> Option<ServerPrompt> {
    if p.get("is_active").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }
    let command = p.get("command")?.as_str()?.trim().trim_start_matches('/').to_string();
    let content = p.get("content")?.as_str()?.to_string();
    if command.is_empty() || content.trim().is_empty() {
        return None;
    }
    let name = p
        .get("name")
        .or_else(|| p.get("title"))
        .and_then(|v| v.as_str())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(&command)
        .to_string();
    let id = p.get("id").and_then(|v| v.as_str()).unwrap_or(&command).to_string();
    Some(ServerPrompt { id, command, name, content })
}

/// `GET /api/v1/prompts/` — every prompt the account can use.
pub async fn list_prompts(base_url: String, token: String) -> Result<Vec<ServerPrompt>, String> {
    let list = folder_request(reqwest::Method::GET, &base_url, "/api/v1/prompts/", &token, None).await?;
    Ok(list.as_array().map(|items| items.iter().filter_map(parse_prompt).collect()).unwrap_or_default())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerNote {
    pub id: String,
    pub title: String,
    pub markdown: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn parse_note(n: &Value) -> Option<ServerNote> {
    Some(ServerNote {
        id: n.get("id")?.as_str()?.to_string(),
        title: n.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        markdown: n
            .get("data")
            .and_then(|d| d.get("content"))
            .and_then(|c| c.get("md"))
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string(),
        pinned: n.get("is_pinned").and_then(|v| v.as_bool()).unwrap_or(false),
        created_at: epoch_ms(n.get("created_at")),
        updated_at: epoch_ms(n.get("updated_at")),
    })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
}

/// `GET /api/v1/files/` — the files already uploaded to the server.
pub async fn list_files(base_url: String, token: String) -> Result<Vec<ServerFile>, String> {
    let list = folder_request(reqwest::Method::GET, &base_url, "/api/v1/files/", &token, None).await?;
    let items = list.as_array().ok_or_else(|| format!("unexpected files response: {list}"))?;
    Ok(items
        .iter()
        .filter_map(|f| {
            let id = f.get("id")?.as_str()?.to_string();
            let filename = f
                .get("filename")
                .or_else(|| f.get("meta").and_then(|m| m.get("name")))
                .and_then(|v| v.as_str())
                .unwrap_or("file")
                .to_string();
            let mime_type = f
                .get("meta")
                .and_then(|m| m.get("content_type"))
                .and_then(|v| v.as_str())
                .unwrap_or("application/octet-stream")
                .to_string();
            Some(ServerFile { id, filename, mime_type })
        })
        .collect())
}

/// Downloads a web page for "attach a web page": http(s) only, 2 MB at most.
pub async fn fetch_web_page(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("not a valid address: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("only http and https addresses can be attached".to_string());
    }
    let resp = reqwest::Client::new()
        .get(parsed.clone())
        .header("User-Agent", "Mozilla/5.0 OpenDesktopUI")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("could not reach {parsed}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{parsed} answered {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("could not read the page: {e}"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("the page is larger than 2 MB".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `GET /api/v1/notes/?page=N` (60 per page) until a page adds nothing.
pub async fn list_notes(base_url: String, token: String) -> Result<Vec<ServerNote>, String> {
    let mut out: Vec<ServerNote> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for page in 1..=100 {
        let list = match folder_request(
            reqwest::Method::GET,
            &base_url,
            &format!("/api/v1/notes/?page={page}"),
            &token,
            None,
        )
        .await
        {
            Ok(v) => v,
            Err(e) if page == 1 => return Err(e),
            Err(_) => break,
        };
        let items = list.as_array().ok_or_else(|| format!("unexpected notes response: {list}"))?;
        let mut added = 0;
        for note in items.iter().filter_map(parse_note) {
            if seen.insert(note.id.clone()) {
                out.push(note);
                added += 1;
            }
        }
        if added == 0 {
            break;
        }
    }
    Ok(out)
}

/// The body for creating or updating a note: the title and the markdown text.
fn note_form(title: &str, markdown: &str) -> Value {
    serde_json::json!({ "title": title, "data": { "content": { "md": markdown } } })
}

/// `POST /api/v1/notes/create` -> the new note.
pub async fn create_note(base_url: String, token: String, title: String, markdown: String) -> Result<ServerNote, String> {
    let created = folder_request(
        reqwest::Method::POST,
        &base_url,
        "/api/v1/notes/create",
        &token,
        Some(note_form(&title, &markdown)),
    )
    .await?;
    parse_note(&created).ok_or_else(|| format!("the server's answer had no note: {created}"))
}

/// `POST /api/v1/notes/{id}/update` -> the note as stored.
pub async fn update_note(
    base_url: String,
    token: String,
    id: String,
    title: String,
    markdown: String,
) -> Result<ServerNote, String> {
    let updated = folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/notes/{id}/update"),
        &token,
        Some(note_form(&title, &markdown)),
    )
    .await?;
    parse_note(&updated).ok_or_else(|| format!("the server's answer had no note: {updated}"))
}

/// `DELETE /api/v1/notes/{id}/delete`.
pub async fn delete_note(base_url: String, token: String, id: String) -> Result<(), String> {
    folder_request(
        reqwest::Method::DELETE,
        &base_url,
        &format!("/api/v1/notes/{id}/delete"),
        &token,
        None,
    )
    .await
    .map(|_| ())
}

/// One thing the server remembers about the user across chats.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerMemory {
    pub id: String,
    pub content: String,
    pub updated_at: i64,
}

fn parse_memory(m: &Value) -> Option<ServerMemory> {
    Some(ServerMemory {
        id: m.get("id")?.as_str()?.to_string(),
        content: m.get("content")?.as_str()?.to_string(),
        updated_at: epoch_ms(m.get("updated_at")),
    })
}

/// `GET /api/v1/memories/`.
pub async fn list_memories(base_url: String, token: String) -> Result<Vec<ServerMemory>, String> {
    let list = folder_request(reqwest::Method::GET, &base_url, "/api/v1/memories/", &token, None).await?;
    Ok(list.as_array().map(|items| items.iter().filter_map(parse_memory).collect()).unwrap_or_default())
}

/// `POST /api/v1/memories/add` `{"content": ...}`.
pub async fn add_memory(base_url: String, token: String, content: String) -> Result<ServerMemory, String> {
    let created = folder_request(
        reqwest::Method::POST,
        &base_url,
        "/api/v1/memories/add",
        &token,
        Some(serde_json::json!({ "content": content })),
    )
    .await?;
    parse_memory(&created).ok_or_else(|| format!("the server's answer had no memory: {created}"))
}

/// `POST /api/v1/memories/{id}/update` `{"content": ...}`.
pub async fn update_memory(base_url: String, token: String, id: String, content: String) -> Result<ServerMemory, String> {
    let updated = folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/memories/{id}/update"),
        &token,
        Some(serde_json::json!({ "content": content })),
    )
    .await?;
    parse_memory(&updated).ok_or_else(|| format!("the server's answer had no memory: {updated}"))
}

/// `DELETE /api/v1/memories/{id}`.
pub async fn delete_memory(base_url: String, token: String, id: String) -> Result<(), String> {
    folder_request(reqwest::Method::DELETE, &base_url, &format!("/api/v1/memories/{id}"), &token, None)
        .await
        .map(|_| ())
}

/// A chat as listed by Open WebUI. The list routes only carry id / title /
/// times, so `pinned`, `archived` and the folder come from the dedicated
/// routes (see `list_chats`). `None` / `folder_known = false` mean "the server
/// did not say" and callers must keep their local value.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerChat {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub folder_id: Option<String>,
    pub folder_known: bool,
    /// When the account last read the chat (ms); 0 after "mark as unread".
    /// `None` when the server didn't send the field. A chat counts as unread
    /// when this is 0 or older than `updated_at`.
    pub last_read_at: Option<i64>,
}

fn parse_server_chat(body: &Value) -> Result<ServerChat, String> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("chat response had no `id`: {body}"))?
        .to_string();
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("chat").and_then(|c| c.get("title")).and_then(|v| v.as_str()))
        .unwrap_or("New Chat")
        .to_string();
    Ok(ServerChat {
        id,
        title,
        created_at: epoch_ms(body.get("created_at")),
        updated_at: epoch_ms(body.get("updated_at")),
        pinned: body.get("pinned").and_then(|v| v.as_bool()),
        archived: body.get("archived").and_then(|v| v.as_bool()),
        folder_id: body
            .get("folder_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        folder_known: body.get("folder_id").is_some(),
        last_read_at: body
            .get("last_read_at")
            .filter(|v| !v.is_null())
            .map(|v| epoch_ms(Some(v))),
    })
}

/// Fetches every page of a chat-list route until it runs dry. Stops early when
/// a page adds nothing new (servers that ignore `page` would repeat forever).
async fn collect_chat_pages(
    base_url: &str,
    token: &str,
    path: &str,
    paged: bool,
) -> Result<Vec<ServerChat>, String> {
    let mut out: Vec<ServerChat> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for page in 1..=200 {
        let sep = if path.contains('?') { '&' } else { '?' };
        let full = if paged { format!("{path}{sep}page={page}") } else { path.to_string() };
        let list = match folder_request(reqwest::Method::GET, base_url, &full, token, None).await {
            Ok(v) => v,
            Err(e) if page == 1 => return Err(e),
            Err(_) => break,
        };
        let items = list
            .as_array()
            .ok_or_else(|| format!("unexpected chats response: {list}"))?;
        let mut added = 0;
        for item in items {
            let chat = parse_server_chat(item)?;
            if seen.insert(chat.id.clone()) {
                out.push(chat);
                added += 1;
            }
        }
        if !paged || added == 0 {
            break;
        }
    }
    Ok(out)
}

/// Every chat of the signed-in account: the main list (`GET /api/v1/chats/`,
/// paged), merged with the pinned list, the archived list and — for each of
/// `folder_ids` — the chats filed in that folder. The secondary lookups are
/// best-effort; a failed one leaves the matching field unknown rather than
/// guessing. Shapes are taken from Open WebUI's `routers/chats.py` and are not
/// yet exercised against this user's server.
pub async fn list_chats(
    base_url: String,
    token: String,
    folder_ids: Vec<String>,
) -> Result<Vec<ServerChat>, String> {
    let mut chats = collect_chat_pages(
        &base_url,
        &token,
        "/api/v1/chats/?include_pinned=true&include_folders=true",
        true,
    )
    .await?;
    let mut index: std::collections::HashMap<String, usize> =
        chats.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();

    // Merges `found` into `chats`, applying `mark` to each (adding unseen chats).
    fn merge(
        chats: &mut Vec<ServerChat>,
        index: &mut std::collections::HashMap<String, usize>,
        found: Vec<ServerChat>,
        mark: &dyn Fn(&mut ServerChat),
    ) {
        for chat in found {
            let slot = *index.entry(chat.id.clone()).or_insert_with(|| {
                chats.push(chat.clone());
                chats.len() - 1
            });
            mark(&mut chats[slot]);
        }
    }

    if let Ok(pinned) = collect_chat_pages(&base_url, &token, "/api/v1/chats/pinned", false).await {
        for c in chats.iter_mut() {
            c.pinned = Some(false);
        }
        merge(&mut chats, &mut index, pinned, &|c| c.pinned = Some(true));
    }

    if let Ok(archived) = collect_chat_pages(&base_url, &token, "/api/v1/chats/archived", true).await {
        for c in chats.iter_mut() {
            c.archived = Some(false);
        }
        merge(&mut chats, &mut index, archived, &|c| c.archived = Some(true));
    }

    let mut folders_ok = true;
    for folder_id in &folder_ids {
        match collect_chat_pages(&base_url, &token, &format!("/api/v1/chats/folder/{folder_id}"), false).await {
            Ok(found) => {
                let fid = folder_id.clone();
                merge(&mut chats, &mut index, found, &move |c| {
                    c.folder_id = Some(fid.clone());
                    c.folder_known = true;
                });
            }
            Err(e) => {
                log::warn!("[openwebui] could not list chats of folder {folder_id}: {e}");
                folders_ok = false;
            }
        }
    }
    if folders_ok {
        // Every folder was checked: whatever is in none of them is unfiled.
        for c in chats.iter_mut() {
            c.folder_known = true;
        }
    }
    Ok(chats)
}

/// A file attached to a message (`message.files` entries of type `file`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub name: String,
    /// May be empty when the server doesn't say.
    #[serde(default)]
    pub mime: String,
}

/// One message of a server chat, flattened out of the `history` tree.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    /// Thumbs rating from `annotation.rating` (1 / -1); `None` = not rated.
    pub rating: Option<i32>,
    /// The Open WebUI feedback record behind the rating.
    pub feedback_id: Option<String>,
    pub files: Vec<FileRef>,
    /// The retrieved documents behind the answer, as the server stores them.
    pub sources: Option<Vec<Value>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerChatDetail {
    pub chat: ServerChat,
    pub model: Option<String>,
    pub messages: Vec<ServerMessage>,
    /// Knowledge bases attached to the chat (`chat.files` entries of type `collection`).
    pub knowledge_ids: Vec<String>,
    /// Tag ids from the chat's `meta.tags`.
    pub tags: Vec<String>,
    /// The chat's own settings (`chat.params`).
    pub params: ChatParams,
}

fn parse_file_ref(f: &Value) -> Option<FileRef> {
    if f.get("type").and_then(|t| t.as_str()) != Some("file") {
        return None;
    }
    let inner = f.get("file");
    let id = f
        .get("id")
        .or_else(|| inner.and_then(|i| i.get("id")))
        .and_then(|v| v.as_str())?
        .to_string();
    let name = f
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| inner.and_then(|i| i.get("filename")).and_then(|v| v.as_str()))
        .or_else(|| {
            inner
                .and_then(|i| i.get("meta"))
                .and_then(|m| m.get("name"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or(&id)
        .to_string();
    let mime = inner
        .and_then(|i| i.get("meta"))
        .and_then(|m| m.get("content_type"))
        .and_then(|v| v.as_str())
        .or_else(|| f.get("content_type").and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();
    Some(FileRef { id, name, mime })
}

fn parse_knowledge_ids(chat: &Value) -> Vec<String> {
    chat.get("files")
        .and_then(|f| f.as_array())
        .map(|files| {
            files
                .iter()
                .filter(|f| f.get("type").and_then(|t| t.as_str()) == Some("collection"))
                .filter_map(|f| f.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        // Multimodal content: keep the text parts.
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn parse_server_message(m: &Value, fallback_id: String) -> Option<ServerMessage> {
    let role = m.get("role").and_then(|v| v.as_str())?;
    if role != "user" && role != "assistant" && role != "system" {
        return None;
    }
    Some(ServerMessage {
        id: m
            .get("id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .unwrap_or(fallback_id),
        role: role.to_string(),
        content: m.get("content").map(message_text).unwrap_or_default(),
        timestamp: epoch_ms(m.get("timestamp")),
        rating: m
            .get("annotation")
            .and_then(|a| a.get("rating"))
            .and_then(|r| r.as_i64().or_else(|| r.as_f64().map(|f| f as i64)))
            .map(|r| r.clamp(-1, 1) as i32),
        feedback_id: m
            .get("feedbackId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        files: m
            .get("files")
            .and_then(|f| f.as_array())
            .map(|files| files.iter().filter_map(parse_file_ref).collect())
            .unwrap_or_default(),
        sources: m
            .get("sources")
            .and_then(|s| s.as_array())
            .filter(|s| !s.is_empty())
            .cloned(),
    })
}

/// Follows `history.currentId` back through `parentId` to the active branch;
/// falls back to the flat `messages` list for chats without a history tree.
fn parse_chat_detail(body: &Value) -> Result<ServerChatDetail, String> {
    let chat = parse_server_chat(body)?;
    let inner = body.get("chat").cloned().unwrap_or(Value::Null);
    let model = inner
        .get("models")
        .and_then(|m| m.as_array())
        .and_then(|m| m.first())
        .and_then(|m| m.as_str())
        .map(|m| m.to_string());

    let mut messages: Vec<ServerMessage> = Vec::new();
    let tree = inner.get("history").and_then(|h| h.get("messages")).and_then(|m| m.as_object());
    let current = inner
        .get("history")
        .and_then(|h| h.get("currentId"))
        .and_then(|v| v.as_str());
    if let (Some(tree), Some(mut cursor)) = (tree, current) {
        let mut guard = 0;
        while let Some(node) = tree.get(cursor) {
            if let Some(m) = parse_server_message(node, cursor.to_string()) {
                messages.push(m);
            }
            guard += 1;
            match node.get("parentId").and_then(|v| v.as_str()) {
                Some(parent) if guard < 10_000 => cursor = parent,
                _ => break,
            }
        }
        messages.reverse();
    } else if let Some(flat) = inner.get("messages").and_then(|m| m.as_array()) {
        for (i, m) in flat.iter().enumerate() {
            if let Some(m) = parse_server_message(m, format!("msg-{i}")) {
                messages.push(m);
            }
        }
    }
    let knowledge_ids = parse_knowledge_ids(&inner);
    let tags = body
        .get("meta")
        .and_then(|m| m.get("tags"))
        .and_then(|t| t.as_array())
        .map(|tags| tags.iter().filter_map(|t| t.as_str()).map(tag_id).collect())
        .unwrap_or_default();
    let params = parse_chat_params(&inner);
    Ok(ServerChatDetail { chat, model, messages, knowledge_ids, tags, params })
}

/// Open WebUI identifies a tag by its lower-cased name with spaces turned into
/// underscores; this app stores tags in that form too.
fn tag_id(name: &str) -> String {
    name.trim().to_lowercase().replace(' ', "_")
}

/// Tag ids out of a list of `TagModel`s (`id`, falling back to the name).
fn parse_tag_ids(list: &Value) -> Vec<String> {
    list.as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(|t| {
                    t.get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| t.get("name").and_then(|v| v.as_str()))
                        .map(tag_id)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `POST /api/v1/chats/{id}/tags` `{"name": ...}`; returns the chat's tag ids.
pub async fn add_chat_tag(base_url: String, token: String, id: String, name: String) -> Result<Vec<String>, String> {
    let list = folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/chats/{id}/tags"),
        &token,
        Some(serde_json::json!({ "name": name })),
    )
    .await?;
    Ok(parse_tag_ids(&list))
}

/// `DELETE /api/v1/chats/{id}/tags` `{"name": ...}`; returns the chat's tag ids.
pub async fn remove_chat_tag(base_url: String, token: String, id: String, name: String) -> Result<Vec<String>, String> {
    let list = folder_request(
        reqwest::Method::DELETE,
        &base_url,
        &format!("/api/v1/chats/{id}/tags"),
        &token,
        Some(serde_json::json!({ "name": name })),
    )
    .await?;
    Ok(parse_tag_ids(&list))
}

/// Pulls the title out of a task completion. The server's default template asks
/// the model for `{ "title": "…" }`, but models answer in many shapes: bare
/// text, quoted text, JSON inside prose, or with a leading `<think>` block.
fn parse_generated_title(body: &Value) -> Option<String> {
    let content = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    let content = content.rsplit("</think>").next().unwrap_or(content).trim();
    if let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) {
        if start < end {
            if let Ok(v) = serde_json::from_str::<Value>(&content[start..=end]) {
                if let Some(title) = v.get("title").and_then(|t| t.as_str()) {
                    return clean_title(title);
                }
            }
        }
    }
    clean_title(content)
}

fn clean_title(raw: &str) -> Option<String> {
    let title = raw
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '„' | '`'))
        .trim();
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(80).collect())
}

/// `POST /api/v1/tasks/title/completions` — the server's own title generation,
/// so titles match the web UI. `None` when the feature is switched off on the
/// server (it answers 200 with a `detail` message and no completion) or the
/// model produced nothing usable.
pub async fn generate_title(
    base_url: String,
    token: String,
    model: String,
    messages: Vec<ChatMessage>,
    chat_id: Option<String>,
) -> Result<Option<String>, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(|m| serde_json::json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
        "chat_id": chat_id,
    });
    let reply = folder_request_timeout(
        reqwest::Method::POST,
        &base_url,
        "/api/v1/tasks/title/completions",
        &token,
        Some(body),
        90,
    )
    .await?;
    Ok(parse_generated_title(&reply))
}

/// `GET /api/v1/chats/{id}`.
pub async fn get_chat(base_url: String, token: String, id: String) -> Result<ServerChatDetail, String> {
    let body = folder_request(
        reqwest::Method::GET,
        &base_url,
        &format!("/api/v1/chats/{id}"),
        &token,
        None,
    )
    .await?;
    parse_chat_detail(&body)
}

/// `POST /api/v1/chats/{id}` with `{"chat": {"title": ...}}`; the server merges
/// the `chat` object into the stored one.
pub async fn update_chat_title(base_url: String, token: String, id: String, title: String) -> Result<(), String> {
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/chats/{id}"),
        &token,
        Some(serde_json::json!({ "chat": { "title": title } })),
    )
    .await
    .map(|_| ())
}

/// A locally stored message to push: `id` is the server-side message id (a
/// fresh one is made up when the message has none yet), `timestamp` in ms.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    /// Local thumbs vote: `Some(0)` clears the server's rating, `None` leaves it alone.
    #[serde(default)]
    pub rating: Option<i32>,
    #[serde(default)]
    pub feedback_id: Option<String>,
    #[serde(default)]
    pub files: Vec<FileRef>,
    /// Retrieved documents of an answer made here; written only when the stored
    /// message has none yet.
    #[serde(default)]
    pub sources: Option<Vec<Value>>,
}

/// A knowledge base attached to a chat.
#[derive(Deserialize, Clone, Debug)]
pub struct KnowledgeRef {
    pub id: String,
    pub name: String,
}

fn object_of(v: Option<&Value>) -> serde_json::Map<String, Value> {
    v.and_then(|v| v.as_object()).cloned().unwrap_or_default()
}

/// Builds the `chat` object to store, starting from what the server already
/// has so nothing this app doesn't model is lost: unknown chat fields
/// (`params`, `tags`, …), unknown message fields (`sources`, `annotation`
/// details, …), files other clients attached, and branches (regenerated
/// replies stay as siblings). The local linear chain, ratings, attachments and
/// knowledge bases are laid over it. `base_url` builds attachment links.
fn merge_chat_value(
    existing: &Value,
    base_url: &str,
    title: &str,
    model: &str,
    messages: &[SyncMessage],
    knowledge: &[KnowledgeRef],
) -> Value {
    let mut chat = object_of(Some(existing));
    let mut tree = object_of(existing.get("history").and_then(|h| h.get("messages")));
    // Legacy chats may only have the flat list.
    if tree.is_empty() {
        if let Some(flat) = existing.get("messages").and_then(|m| m.as_array()) {
            for m in flat {
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    tree.insert(id.to_string(), m.clone());
                }
            }
        }
    }

    let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let mut flat: Vec<Value> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        let is_new = !tree.contains_key(&m.id);
        let mut node = object_of(tree.get(&m.id));

        node.insert("id".into(), Value::String(m.id.clone()));
        node.insert(
            "parentId".into(),
            if i == 0 { Value::Null } else { Value::String(ids[i - 1].to_string()) },
        );
        // Keep other children (branches the server knows) next to the next message.
        let mut children: Vec<Value> = node
            .get("childrenIds")
            .and_then(|c| c.as_array())
            .map(|c| c.iter().filter(|id| id.as_str().map_or(false, |s| tree.contains_key(s))).cloned().collect())
            .unwrap_or_default();
        if let Some(next) = ids.get(i + 1) {
            if !children.iter().any(|c| c.as_str() == Some(next)) {
                children.push(Value::String((*next).to_string()));
            }
        }
        node.insert("childrenIds".into(), Value::Array(children));
        node.insert("role".into(), Value::String(m.role.clone()));
        node.insert("content".into(), Value::String(m.content.clone()));
        if is_new || !node.contains_key("timestamp") {
            node.insert("timestamp".into(), Value::from((m.timestamp.max(0) / 1000) as u64));
        }
        if is_new && m.role == "assistant" {
            node.entry("model").or_insert_with(|| Value::String(model.to_string()));
            node.entry("done").or_insert(Value::Bool(true));
        }
        if is_new && m.role == "user" {
            node.entry("models").or_insert_with(|| serde_json::json!([model]));
        }

        // Thumbs: the rating lives in `annotation`, the feedback record id next to it.
        if let Some(rating) = m.rating {
            let mut annotation = object_of(node.get("annotation"));
            if rating == 0 {
                annotation.remove("rating");
            } else {
                annotation.insert("rating".into(), Value::from(rating.clamp(-1, 1)));
            }
            if annotation.is_empty() {
                node.remove("annotation");
            } else {
                node.insert("annotation".into(), Value::Object(annotation));
            }
            if rating == 0 {
                node.remove("feedbackId");
            }
        }
        if let (Some(feedback_id), Some(rating)) = (&m.feedback_id, m.rating) {
            if rating != 0 {
                node.insert("feedbackId".into(), Value::String(feedback_id.clone()));
            }
        }

        // Sources: the server's own copy wins; ours fill in an answer it never saw.
        if let Some(sources) = &m.sources {
            if !sources.is_empty() && !node.contains_key("sources") {
                node.insert("sources".into(), Value::Array(sources.clone()));
            }
        }

        // Attachments: keep what is there, add what only the app knows.
        if !m.files.is_empty() {
            let mut files: Vec<Value> = node.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            for f in &m.files {
                let known = files.iter().any(|e| {
                    e.get("id").and_then(|v| v.as_str()) == Some(f.id.as_str())
                        || e.get("file").and_then(|x| x.get("id")).and_then(|v| v.as_str()) == Some(f.id.as_str())
                });
                if !known {
                    files.push(serde_json::json!({
                        "type": "file",
                        "id": f.id,
                        "name": f.name,
                        "url": format!("{}/api/v1/files/{}", base_url.trim_end_matches('/'), f.id),
                        "status": "uploaded",
                        "file": { "id": f.id, "filename": f.name, "meta": { "name": f.name, "content_type": f.mime } },
                    }));
                }
            }
            node.insert("files".into(), Value::Array(files));
        }

        let node = Value::Object(node);
        tree.insert(m.id.clone(), node.clone());
        flat.push(node);
    }

    // Knowledge bases: replace only the `collection` entries of `chat.files`.
    let old_files: Vec<Value> = existing.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let mut files: Vec<Value> = old_files
        .iter()
        .filter(|f| f.get("type").and_then(|t| t.as_str()) != Some("collection"))
        .cloned()
        .collect();
    for k in knowledge {
        let previous = old_files.iter().find(|f| {
            f.get("type").and_then(|t| t.as_str()) == Some("collection")
                && f.get("id").and_then(|v| v.as_str()) == Some(k.id.as_str())
        });
        files.push(previous.cloned().unwrap_or_else(|| {
            serde_json::json!({ "type": "collection", "id": k.id, "name": k.name, "status": "processed" })
        }));
    }

    chat.insert("title".into(), Value::String(title.to_string()));
    if !model.is_empty() {
        chat.insert("models".into(), serde_json::json!([model]));
    }
    chat.insert("messages".into(), Value::Array(flat));
    chat.insert(
        "history".into(),
        serde_json::json!({ "messages": Value::Object(tree), "currentId": ids.last() }),
    );
    chat.insert("files".into(), Value::Array(files));
    Value::Object(chat)
}

/// The per-chat settings Open WebUI keeps in `chat.params` (the ones this app
/// edits; the server's other keys are left alone). Names are the server's.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct ChatParams {
    pub system: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    pub seed: Option<i64>,
    pub stop: Vec<String>,
}

fn parse_chat_params(chat: &Value) -> ChatParams {
    let params = chat.get("params");
    let get = |key: &str| params.and_then(|p| p.get(key));
    ChatParams {
        system: get("system").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        temperature: get("temperature").and_then(|v| v.as_f64()),
        top_p: get("top_p").and_then(|v| v.as_f64()),
        max_tokens: get("max_tokens").and_then(|v| v.as_u64()).map(|v| v as u32),
        seed: get("seed").and_then(|v| v.as_i64()),
        // Stored as a list, or as one comma-separated string.
        stop: match get("stop") {
            Some(Value::Array(items)) => items.iter().filter_map(|s| s.as_str()).map(str::to_string).collect(),
            Some(Value::String(s)) => s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
            _ => Vec::new(),
        },
    }
}

/// Lays the local settings over `chat.params`: a value that is set is written,
/// one that is not set is removed, unrelated keys stay.
fn apply_params(chat: &mut Value, params: &ChatParams) {
    let mut stored = object_of(chat.get("params"));
    let mut put = |key: &str, value: Option<Value>| match value {
        Some(v) => {
            stored.insert(key.to_string(), v);
        }
        None => {
            stored.remove(key);
        }
    };
    put("system", params.system.as_ref().filter(|s| !s.trim().is_empty()).map(|s| Value::String(s.clone())));
    put("temperature", params.temperature.map(Value::from));
    put("top_p", params.top_p.map(Value::from));
    put("max_tokens", params.max_tokens.map(Value::from));
    put("seed", params.seed.map(Value::from));
    put("stop", (!params.stop.is_empty()).then(|| serde_json::json!(params.stop)));
    if let Some(obj) = chat.as_object_mut() {
        obj.insert("params".to_string(), Value::Object(stored));
    }
}

/// Writes the local title, messages, ratings, attachments, knowledge bases and
/// settings to a server chat. Read-modify-write (see `merge_chat_value`): if the
/// current chat can't be read nothing is written.
#[allow(clippy::too_many_arguments)]
pub async fn update_chat_content(
    base_url: String,
    token: String,
    id: String,
    title: String,
    model: String,
    messages: Vec<SyncMessage>,
    knowledge: Vec<KnowledgeRef>,
    params: Option<ChatParams>,
) -> Result<(), String> {
    let path = format!("/api/v1/chats/{id}");
    let current = folder_request(reqwest::Method::GET, &base_url, &path, &token, None).await?;
    let existing = current.get("chat").cloned().unwrap_or(Value::Null);
    let mut chat = merge_chat_value(&existing, &base_url, &title, &model, &messages, &knowledge);
    if let Some(params) = &params {
        apply_params(&mut chat, params);
    }
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &path,
        &token,
        Some(serde_json::json!({ "chat": chat })),
    )
    .await
    .map(|_| ())
}

/// `POST /api/v1/chats/{id}/unread` — the server forgets that the chat was read.
pub async fn mark_chat_unread(base_url: String, token: String, id: String) -> Result<(), String> {
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/chats/{id}/unread"),
        &token,
        None,
    )
    .await
    .map(|_| ())
}

/// `DELETE /api/v1/chats/{id}`.
pub async fn delete_chat(base_url: String, token: String, id: String) -> Result<(), String> {
    folder_request(
        reqwest::Method::DELETE,
        &base_url,
        &format!("/api/v1/chats/{id}"),
        &token,
        None,
    )
    .await
    .map(|_| ())
}

/// Sets a chat's `pinned` / `archived` flag. The server routes
/// (`POST /chats/{id}/pin` and `/archive`) only *toggle*, so the current state
/// is read first and the toggle is sent only when it differs.
pub async fn set_chat_flag(
    base_url: String,
    token: String,
    id: String,
    flag: String,
    value: bool,
) -> Result<(), String> {
    let (route, field) = match flag.as_str() {
        "pin" => ("pin", "pinned"),
        "archive" => ("archive", "archived"),
        other => return Err(format!("unknown chat flag `{other}`")),
    };
    let current = folder_request(
        reqwest::Method::GET,
        &base_url,
        &format!("/api/v1/chats/{id}"),
        &token,
        None,
    )
    .await?;
    let now = current.get(field).and_then(|v| v.as_bool()).unwrap_or(false);
    if now == value {
        return Ok(());
    }
    folder_request(
        reqwest::Method::POST,
        &base_url,
        &format!("/api/v1/chats/{id}/{route}"),
        &token,
        None,
    )
    .await
    .map(|_| ())
}

/// Downloads a file the server holds (`GET /api/v1/files/{id}/content`) into a
/// scratch folder and returns its path, so it can be opened with the system's
/// own viewer. The file keeps its name so that app associations work.
pub async fn download_file(
    base_url: &str,
    token: &str,
    file_id: &str,
    filename: &str,
) -> Result<std::path::PathBuf, String> {
    let url = format!(
        "{}/api/v1/files/{}/content",
        base_url.trim_end_matches('/'),
        crate::paste::safe_id(file_id)
    );
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("could not download the file ({})", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("download interrupted: {e}"))?;

    // Sweep first: it also removes empty sub-folders, which would take the
    // folder created below with it.
    crate::paste::sweep(&crate::paste::opened_files_dir(), std::time::Duration::from_secs(24 * 60 * 60));
    let dir = crate::paste::opened_files_dir().join(crate::paste::safe_id(file_id));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(crate::paste::safe_file_name(filename));
    std::fs::write(&path, &bytes).map_err(|e| format!("could not save the file: {e}"))?;
    Ok(path)
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

    let items: Vec<(&str, &str, u64)> = messages
        .iter()
        .map(|m| (m.role.as_str(), m.content.as_str(), now))
        .collect();
    let mut body = serde_json::json!({ "chat": chat_value(&title, &model, &ids, &items) });
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

/// The `chat` object Open WebUI stores: a flat `messages` list plus the linked
/// `history` map, built as a simple linear chain (this app has no branching).
/// `items` are `(role, content, timestamp in seconds)`, parallel to `ids`.
fn chat_value(title: &str, model: &str, ids: &[String], items: &[(&str, &str, u64)]) -> Value {
    let mut history_messages = serde_json::Map::new();
    let mut flat_messages: Vec<Value> = Vec::new();
    for (i, (role, content, timestamp)) in items.iter().enumerate() {
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
            "role": role,
            "content": content,
            "timestamp": timestamp,
        });
        history_messages.insert(ids[i].clone(), entry.clone());
        flat_messages.push(entry);
    }
    serde_json::json!({
        "title": title,
        "models": [model],
        "messages": flat_messages,
        "history": {
            "messages": Value::Object(history_messages),
            "currentId": ids.last().cloned(),
        },
    })
}

fn parse_created_chat(body: &Value) -> Result<String, String> {
    body.get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("chat created but response had no `id` field: {body}"))
}

/// Thumbs up / down through Open WebUI's evaluations API (shapes from its
/// `routers/evaluations.py`; not yet exercised against this user's server):
///   create  `POST /api/v1/evaluations/feedback` -> `{id, ...}`
///   update  `POST /api/v1/evaluations/feedback/{id}`
///   remove  `DELETE /api/v1/evaluations/feedback/{id}`
/// with body `{"type":"rating","data":{"rating":1|-1,"model_id":...},
/// "meta":{"chat_id":...,"message_id":...}}`. Returns the feedback record's id
/// (`None` when the rating was cleared) so later changes update that record.
pub async fn rate_message(
    base_url: String,
    token: String,
    chat_id: String,
    message_id: String,
    model: String,
    rating: i32,
    feedback_id: Option<String>,
) -> Result<Option<String>, String> {
    let collection = "/api/v1/evaluations/feedback";
    if rating == 0 {
        if let Some(fid) = feedback_id {
            match folder_request(
                reqwest::Method::DELETE,
                &base_url,
                &format!("{collection}/{fid}"),
                &token,
                None,
            )
            .await
            {
                Ok(_) => {}
                // Already gone: that is what was wanted.
                Err(e) if e.contains("404") => {}
                Err(e) => return Err(e),
            }
        }
        return Ok(None);
    }

    let body = serde_json::json!({
        "type": "rating",
        "data": { "rating": rating, "model_id": model },
        "meta": { "chat_id": chat_id, "message_id": message_id },
    });
    if let Some(fid) = feedback_id {
        match folder_request(
            reqwest::Method::POST,
            &base_url,
            &format!("{collection}/{fid}"),
            &token,
            Some(body.clone()),
        )
        .await
        {
            Ok(_) => return Ok(Some(fid)),
            // The record was deleted elsewhere: create a fresh one below.
            Err(e) if e.contains("404") => {}
            Err(e) => return Err(e),
        }
    }
    let created = folder_request(reqwest::Method::POST, &base_url, collection, &token, Some(body)).await?;
    Ok(created.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
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

/// Developer aid for learning what a server really streams (sources, reasoning,
/// status events …): in a debug build, when `OPENDESKTOPUI_DUMP_STREAM` names a
/// file, the request body and every raw response chunk are appended to it. The
/// API key is never written. Does nothing in release builds.
struct StreamDump(Option<std::fs::File>);

impl StreamDump {
    fn open(request: &Value) -> Self {
        use std::io::Write;
        if !cfg!(debug_assertions) {
            return Self(None);
        }
        let Some(path) = std::env::var_os("OPENDESKTOPUI_DUMP_STREAM") else {
            return Self(None);
        };
        let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
            return Self(None);
        };
        let _ = writeln!(file, "### REQUEST\n{request}\n### RESPONSE");
        Self(Some(file))
    }

    fn raw(&mut self, bytes: &[u8]) {
        use std::io::Write;
        if let Some(file) = &mut self.0 {
            let _ = file.write_all(bytes);
        }
    }
}

/// Optional switches for one completion: sampling parameters, the server
/// features the user turned on, and the tools the model may call. Anything left
/// unset is simply not sent, so the model's own defaults apply.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CompletionOptions {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    pub seed: Option<i64>,
    pub stop: Vec<String>,
    pub web_search: bool,
    pub image_generation: bool,
    pub code_interpreter: bool,
    pub memory: bool,
    pub tool_ids: Vec<String>,
}

/// The JSON body of `POST /api/chat/completions`.
fn completion_body(
    model: &str,
    messages: &[ChatMessage],
    knowledge_ids: &[String],
    options: &CompletionOptions,
) -> Value {
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
    for m in messages {
        if let Some(refs) = &m.files {
            for f in refs {
                files.push(serde_json::json!({ "type": f.kind, "id": f.id }));
            }
        }
    }
    if !files.is_empty() {
        body["files"] = Value::Array(files);
    }

    // OpenAI-style sampling parameters sit at the top level of the body.
    if let Some(v) = options.temperature {
        body["temperature"] = Value::from(v);
    }
    if let Some(v) = options.top_p {
        body["top_p"] = Value::from(v);
    }
    if let Some(v) = options.max_tokens {
        body["max_tokens"] = Value::from(v);
    }
    if let Some(v) = options.seed {
        body["seed"] = Value::from(v);
    }
    if !options.stop.is_empty() {
        body["stop"] = serde_json::json!(options.stop);
    }

    // Only the features that are on, so a server that doesn't know a key never sees it.
    let mut features = serde_json::Map::new();
    for (key, on) in [
        ("web_search", options.web_search),
        ("image_generation", options.image_generation),
        ("code_interpreter", options.code_interpreter),
        ("memory", options.memory),
    ] {
        if on {
            features.insert(key.to_string(), Value::Bool(true));
        }
    }
    if !features.is_empty() {
        body["features"] = Value::Object(features);
    }
    if !options.tool_ids.is_empty() {
        body["tool_ids"] = serde_json::json!(options.tool_ids);
    }
    body
}

pub async fn stream_chat_completion(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    knowledge_ids: Vec<String>,
    options: CompletionOptions,
    channel: Channel<ChatChunk>,
    cancel: std::sync::Arc<CancelToken>,
) -> Result<(), String> {
    let url = format!("{}/api/chat/completions", base_url.trim_end_matches('/'));
    let body = completion_body(&model, &messages, &knowledge_ids, &options);
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
    let mut dump = StreamDump::open(&body);

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
        dump.raw(&bytes);
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
            SseEvent::Reasoning(content) => (ChatChunk::Reasoning { content }, false),
            SseEvent::Sources(sources) => (ChatChunk::Sources { sources }, false),
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
    Reasoning(String),
    Sources(Vec<Value>),
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
        // Retrieved documents come as their own data line (`{"sources": [...]}`),
        // typically before the first text.
        if let Some(sources) = json.get("sources").and_then(|s| s.as_array()) {
            if !sources.is_empty() {
                events.push(SseEvent::Sources(sources.clone()));
            }
        }
        let choice = json.get("choices").and_then(|c| c.get(0));
        // Models that report their reasoning separately: OpenAI-compatible
        // `reasoning_content` (llama.cpp, DeepSeek), `reasoning` (OpenRouter),
        // `thinking` (Ollama).
        if let Some(reasoning) = choice.and_then(|c| c.get("delta")).and_then(|d| {
            ["reasoning_content", "reasoning", "thinking"]
                .iter()
                .find_map(|key| d.get(*key).and_then(|v| v.as_str()))
        }) {
            if !reasoning.is_empty() {
                events.push(SseEvent::Reasoning(reasoning.to_string()));
            }
        }
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
mod chat_sync_tests {
    use super::*;

    #[test]
    fn converts_seconds_to_milliseconds() {
        assert_eq!(epoch_ms(Some(&serde_json::json!(1_700_000_000))), 1_700_000_000_000);
        assert_eq!(epoch_ms(Some(&serde_json::json!(1_700_000_000_000_i64))), 1_700_000_000_000);
        assert_eq!(epoch_ms(None), 0);
    }

    #[test]
    fn parses_a_list_entry() {
        let c = parse_server_chat(&serde_json::json!({
            "id": "c1", "title": "Hello", "updated_at": 1_700_000_100, "created_at": 1_700_000_000
        }))
        .unwrap();
        assert_eq!(c.title, "Hello");
        assert_eq!(c.updated_at, 1_700_000_100_000);
        assert_eq!(c.pinned, None);
        assert!(!c.folder_known);
    }

    #[test]
    fn reads_flags_and_folder_from_a_full_chat() {
        let c = parse_server_chat(&serde_json::json!({
            "id": "c2", "pinned": true, "archived": false, "folder_id": null,
            "chat": {"title": "Inner"}
        }))
        .unwrap();
        assert_eq!(c.title, "Inner");
        assert_eq!(c.pinned, Some(true));
        assert_eq!(c.archived, Some(false));
        assert!(c.folder_known);
        assert_eq!(c.folder_id, None);
    }

    #[test]
    fn rejects_a_chat_without_an_id() {
        assert!(parse_server_chat(&serde_json::json!({"title": "x"})).is_err());
    }

    #[test]
    fn walks_the_active_branch_of_the_history() {
        let detail = parse_chat_detail(&serde_json::json!({
            "id": "c3", "updated_at": 10,
            "chat": {
                "title": "T", "models": ["gpt"],
                "history": {
                    "currentId": "b2",
                    "messages": {
                        "a": {"id": "a", "parentId": null, "role": "user", "content": "hi", "timestamp": 1},
                        "b1": {"id": "b1", "parentId": "a", "role": "assistant", "content": "old", "timestamp": 2},
                        "b2": {"id": "b2", "parentId": "a", "role": "assistant", "content": "new", "timestamp": 3}
                    }
                }
            }
        }))
        .unwrap();
        assert_eq!(detail.model.as_deref(), Some("gpt"));
        let contents: Vec<&str> = detail.messages.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, vec!["hi", "new"]);
    }

    #[test]
    fn falls_back_to_the_flat_message_list() {
        let detail = parse_chat_detail(&serde_json::json!({
            "id": "c4",
            "chat": {"messages": [
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [{"type": "text", "text": "a"}]}
            ]}
        }))
        .unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].content, "a");
    }

    #[test]
    fn extracts_the_title_from_the_shapes_models_answer_in() {
        let reply = |content: &str| serde_json::json!({"choices": [{"message": {"content": content}}]});
        assert_eq!(parse_generated_title(&reply(r#"{"title": "Trip planning"}"#)).as_deref(), Some("Trip planning"));
        assert_eq!(
            parse_generated_title(&reply("Here you go:\n{ \"title\": \"Mietrecht Fragen\" }\nbye")).as_deref(),
            Some("Mietrecht Fragen")
        );
        assert_eq!(parse_generated_title(&reply("\"Quoted title\"")).as_deref(), Some("Quoted title"));
        assert_eq!(
            parse_generated_title(&reply("<think>hmm</think>{\"title\":\"After thinking\"}")).as_deref(),
            Some("After thinking")
        );
        assert_eq!(parse_generated_title(&reply("   ")), None);
        // feature disabled on the server: 200 with only a `detail`
        assert_eq!(parse_generated_title(&serde_json::json!({"detail": "Title generation is disabled"})), None);
    }

    #[test]
    fn tags_are_stored_by_id_and_read_from_chat_meta() {
        assert_eq!(tag_id("  My Tag "), "my_tag");
        assert_eq!(
            parse_tag_ids(&serde_json::json!([{"id": "work", "name": "Work"}, {"name": "Side Project"}])),
            vec!["work", "side_project"]
        );
        let detail = parse_chat_detail(&serde_json::json!({
            "id": "c", "meta": {"tags": ["Work", "side_project"]}, "chat": {}
        }))
        .unwrap();
        assert_eq!(detail.tags, vec!["work", "side_project"]);
    }

    #[test]
    fn timestamps_in_seconds_milliseconds_and_nanoseconds_all_become_milliseconds() {
        assert_eq!(epoch_ms(Some(&serde_json::json!(1_700_000_000))), 1_700_000_000_000);
        assert_eq!(epoch_ms(Some(&serde_json::json!(1_700_000_000_000_i64))), 1_700_000_000_000);
        // notes use time.time_ns()
        assert_eq!(epoch_ms(Some(&serde_json::json!(1_700_000_000_123_456_789_i64))), 1_700_000_000_123);
    }

    #[test]
    fn reads_prompts_by_command_and_skips_inactive_or_empty_ones() {
        let p = parse_prompt(&serde_json::json!({
            "id": "p1", "command": "/summarize", "name": "Summarize", "content": "Summarize: {{text}}"
        }))
        .unwrap();
        assert_eq!((p.command.as_str(), p.name.as_str()), ("summarize", "Summarize"));
        // older servers call the name `title`
        let old = parse_prompt(&serde_json::json!({"command": "/x", "title": "Old", "content": "c"})).unwrap();
        assert_eq!((old.name.as_str(), old.id.as_str()), ("Old", "x"));
        assert!(parse_prompt(&serde_json::json!({"command": "/off", "content": "c", "is_active": false})).is_none());
        assert!(parse_prompt(&serde_json::json!({"command": "/empty", "content": "  "})).is_none());
        assert!(parse_prompt(&serde_json::json!({"content": "no command"})).is_none());
    }

    #[test]
    fn reads_notes_with_their_markdown() {
        let n = parse_note(&serde_json::json!({
            "id": "n1", "title": "Plan", "is_pinned": true,
            "data": {"content": {"md": "# Plan\n- one"}},
            "created_at": 1_700_000_000_000_000_000_i64, "updated_at": 1_700_000_100_000_000_000_i64
        }))
        .unwrap();
        assert_eq!(n.markdown, "# Plan\n- one");
        assert!(n.pinned);
        assert_eq!(n.updated_at, 1_700_000_100_000);
        // a note without data is just empty
        assert_eq!(parse_note(&serde_json::json!({"id": "n2", "title": "T", "data": null})).unwrap().markdown, "");
        assert_eq!(note_form("T", "body"), serde_json::json!({"title": "T", "data": {"content": {"md": "body"}}}));
    }

    #[test]
    fn reads_memories() {
        let m = parse_memory(&serde_json::json!({"id": "m1", "content": "Prefers metric units", "updated_at": 1_700_000_000})).unwrap();
        assert_eq!((m.content.as_str(), m.updated_at), ("Prefers metric units", 1_700_000_000_000));
        assert!(parse_memory(&serde_json::json!({"id": "m2"})).is_none());
    }

    fn user_message(content: &str) -> ChatMessage {
        ChatMessage { role: "user".into(), content: content.into(), files: None }
    }

    #[test]
    fn completion_body_sends_only_what_was_set() {
        let plain = completion_body("gpt", &[user_message("hi")], &[], &CompletionOptions::default());
        assert_eq!(plain["model"], "gpt");
        assert_eq!(plain["stream"], true);
        for key in ["temperature", "top_p", "max_tokens", "seed", "stop", "features", "tool_ids", "files"] {
            assert!(plain.get(key).is_none(), "{key} must not be sent when unset");
        }
    }

    #[test]
    fn completion_body_carries_parameters_features_tools_and_knowledge() {
        let options = CompletionOptions {
            temperature: Some(0.2),
            top_p: Some(0.9),
            max_tokens: Some(512),
            seed: Some(7),
            stop: vec!["END".into()],
            web_search: true,
            memory: true,
            tool_ids: vec!["calc".into()],
            ..Default::default()
        };
        let body = completion_body("gpt", &[user_message("hi")], &["kb1".to_string()], &options);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["seed"], 7);
        assert_eq!(body["stop"], serde_json::json!(["END"]));
        assert_eq!(body["features"], serde_json::json!({"web_search": true, "memory": true}));
        assert_eq!(body["tool_ids"], serde_json::json!(["calc"]));
        assert_eq!(body["files"], serde_json::json!([{"type": "collection", "id": "kb1"}]));
    }

    #[test]
    fn reads_model_details_and_defaults_missing_capabilities_to_available() {
        let preset = parse_model(&serde_json::json!({
            "id": "my-model", "name": "My model",
            "info": {"meta": {
                "description": "  Good at law  ",
                "tags": [{"name": "legal"}, "de"],
                "capabilities": {"vision": false, "web_search": true}
            }}
        }))
        .unwrap();
        assert_eq!(preset.description.as_deref(), Some("Good at law"));
        assert_eq!(preset.tags, vec!["legal", "de"]);
        assert!(preset.workspace);
        assert!(!preset.capabilities.vision);
        assert!(preset.capabilities.web_search);
        assert!(preset.capabilities.image_generation, "unmentioned means available");

        let raw = parse_model(&serde_json::json!({"id": "llama", "name": "llama"})).unwrap();
        assert!(!raw.workspace);
        assert_eq!(raw.description, None);
        assert_eq!(raw.capabilities, ModelCapabilities::default());
    }

    #[test]
    fn reads_which_features_the_server_switched_on() {
        let f = parse_server_features(&serde_json::json!({
            "features": {"enable_web_search": false, "enable_code_execution": true}
        }));
        assert_eq!(f.web_search, Some(false));
        assert_eq!(f.code_interpreter, Some(true));
        assert_eq!(f.image_generation, None);
        assert_eq!(parse_server_features(&serde_json::json!({})), ServerFeatures::default());
    }

    #[test]
    fn chat_params_round_trip_and_keep_the_servers_other_keys() {
        let mut chat = serde_json::json!({
            "params": {"system": "Be brief", "temperature": 0.5, "top_k": 40, "stop": "A, B"}
        });
        let read = parse_chat_params(&chat);
        assert_eq!(read.system.as_deref(), Some("Be brief"));
        assert_eq!(read.temperature, Some(0.5));
        assert_eq!(read.stop, vec!["A", "B"]);

        let local = ChatParams { temperature: Some(0.9), max_tokens: Some(100), ..Default::default() };
        apply_params(&mut chat, &local);
        assert_eq!(chat["params"]["temperature"], 0.9);
        assert_eq!(chat["params"]["max_tokens"], 100);
        assert_eq!(chat["params"]["top_k"], 40, "keys this app does not edit stay");
        assert!(chat["params"].get("system").is_none(), "an unset value is removed");
        assert!(chat["params"].get("stop").is_none());
    }

    fn sync_msg(id: &str, role: &str, content: &str) -> SyncMessage {
        SyncMessage {
            id: id.into(),
            role: role.into(),
            content: content.into(),
            timestamp: 5000,
            rating: None,
            feedback_id: None,
            files: vec![],
            sources: None,
        }
    }

    #[test]
    fn merge_keeps_the_servers_sources_and_adds_ours_only_where_it_has_none() {
        let existing = serde_json::json!({"history": {"currentId": "a", "messages": {
            "u": {"id": "u", "parentId": null, "childrenIds": ["a"], "role": "user", "content": "q"},
            "a": {"id": "a", "parentId": "u", "childrenIds": [], "role": "assistant", "content": "x",
                  "sources": [{"source": {"name": "server.pdf"}}]}
        }}});
        let ours = vec![serde_json::json!({"source": {"name": "local.pdf"}})];
        let mut u = sync_msg("u", "user", "q");
        u.sources = Some(ours.clone());
        let mut a = sync_msg("a", "assistant", "x");
        a.sources = Some(ours);
        let chat = merge_chat_value(&existing, "http://s", "T", "m", &[u, a], &[]);
        let tree = &chat["history"]["messages"];
        assert_eq!(tree["a"]["sources"][0]["source"]["name"], "server.pdf");
        assert_eq!(tree["u"]["sources"][0]["source"]["name"], "local.pdf");
    }

    #[test]
    fn parses_sources_of_a_stored_message() {
        let detail = parse_chat_detail(&serde_json::json!({
            "id": "c", "chat": {"history": {"currentId": "a", "messages": {
                "a": {"id": "a", "parentId": null, "role": "assistant", "content": "x",
                      "sources": [{"source": {"name": "handbook.pdf"}}]},
            }}}
        }))
        .unwrap();
        assert_eq!(detail.messages[0].sources.as_ref().unwrap()[0]["source"]["name"], "handbook.pdf");
    }

    #[test]
    fn parses_rating_feedback_id_and_files_of_a_message() {
        let detail = parse_chat_detail(&serde_json::json!({
            "id": "c", "last_read_at": 0, "updated_at": 10,
            "chat": {
                "files": [
                    {"type": "collection", "id": "kb1", "name": "Docs"},
                    {"type": "file", "id": "ignored-chat-file"}
                ],
                "history": {"currentId": "m", "messages": {
                    "m": {"id": "m", "parentId": null, "role": "user", "content": "hi",
                          "annotation": {"rating": -1, "comment": "x"}, "feedbackId": "fb1",
                          "files": [
                              {"type": "file", "id": "f1", "name": "a.pdf",
                               "file": {"meta": {"content_type": "application/pdf"}}},
                              {"type": "image", "url": "data:image/png;base64,AA"}
                          ]}
                }}
            }
        }))
        .unwrap();
        assert_eq!(detail.knowledge_ids, vec!["kb1"]);
        assert_eq!(detail.chat.last_read_at, Some(0));
        let m = &detail.messages[0];
        assert_eq!(m.rating, Some(-1));
        assert_eq!(m.feedback_id.as_deref(), Some("fb1"));
        assert_eq!(
            m.files,
            vec![FileRef { id: "f1".into(), name: "a.pdf".into(), mime: "application/pdf".into() }]
        );
    }

    #[test]
    fn missing_last_read_at_is_unknown() {
        let c = parse_server_chat(&serde_json::json!({"id": "c", "last_read_at": null})).unwrap();
        assert_eq!(c.last_read_at, None);
        let c = parse_server_chat(&serde_json::json!({"id": "c", "last_read_at": 1_700_000_000})).unwrap();
        assert_eq!(c.last_read_at, Some(1_700_000_000_000));
    }

    #[test]
    fn merge_keeps_server_only_fields_and_branches() {
        let existing = serde_json::json!({
            "title": "Old", "params": {"temperature": 0.2}, "tags": ["t"],
            "files": [{"type": "file", "id": "chatfile"}, {"type": "collection", "id": "oldkb", "name": "Old KB"}],
            "history": {"currentId": "a2", "messages": {
                "a1": {"id": "a1", "parentId": null, "childrenIds": ["a2", "a2b"], "role": "user", "content": "q",
                       "timestamp": 1, "sources": [{"x": 1}]},
                "a2": {"id": "a2", "parentId": "a1", "childrenIds": [], "role": "assistant", "content": "old",
                       "timestamp": 2, "annotation": {"rating": 1, "comment": "nice"}, "feedbackId": "fb"},
                "a2b": {"id": "a2b", "parentId": "a1", "childrenIds": [], "role": "assistant", "content": "branch",
                        "timestamp": 3}
            }}
        });
        let mut m1 = sync_msg("a1", "user", "q");
        m1.files = vec![FileRef { id: "f9".into(), name: "n.txt".into(), mime: "text/plain".into() }];
        let m2 = sync_msg("a2", "assistant", "edited");
        let chat = merge_chat_value(&existing, "http://srv/", "T", "gpt", &[m1, m2], &[]);

        assert_eq!(chat["title"], "T");
        assert_eq!(chat["params"]["temperature"], 0.2);
        assert_eq!(chat["tags"], serde_json::json!(["t"]));
        let tree = &chat["history"]["messages"];
        assert_eq!(tree["a1"]["sources"], serde_json::json!([{"x": 1}]));
        assert_eq!(tree["a2"]["content"], "edited");
        // rating None leaves the server's annotation and feedback record alone
        assert_eq!(tree["a2"]["annotation"]["rating"], 1);
        assert_eq!(tree["a2"]["feedbackId"], "fb");
        // the sibling branch survives and stays a child of its parent
        assert_eq!(tree["a2b"]["content"], "branch");
        assert_eq!(tree["a1"]["childrenIds"], serde_json::json!(["a2", "a2b"]));
        assert_eq!(chat["history"]["currentId"], "a2");
        // attachment added once, with a link; other chat files kept, collections replaced
        assert_eq!(tree["a1"]["files"].as_array().unwrap().len(), 1);
        assert_eq!(tree["a1"]["files"][0]["url"], "http://srv/api/v1/files/f9");
        assert_eq!(chat["files"], serde_json::json!([{"type": "file", "id": "chatfile"}]));
    }

    #[test]
    fn merge_sets_and_clears_ratings_without_dropping_other_annotation_fields() {
        let existing = serde_json::json!({"history": {"currentId": "a", "messages": {
            "a": {"id": "a", "parentId": null, "childrenIds": [], "role": "assistant", "content": "x",
                  "annotation": {"rating": 1, "comment": "keep"}, "feedbackId": "fb"}
        }}});
        let mut down = sync_msg("a", "assistant", "x");
        down.rating = Some(-1);
        down.feedback_id = Some("fb2".into());
        let chat = merge_chat_value(&existing, "http://s", "T", "m", &[down], &[]);
        assert_eq!(chat["history"]["messages"]["a"]["annotation"]["rating"], -1);
        assert_eq!(chat["history"]["messages"]["a"]["annotation"]["comment"], "keep");
        assert_eq!(chat["history"]["messages"]["a"]["feedbackId"], "fb2");

        let mut cleared = sync_msg("a", "assistant", "x");
        cleared.rating = Some(0);
        let chat = merge_chat_value(&existing, "http://s", "T", "m", &[cleared], &[]);
        let node = &chat["history"]["messages"]["a"];
        assert!(node["annotation"].get("rating").is_none());
        assert_eq!(node["annotation"]["comment"], "keep");
        assert!(node.get("feedbackId").is_none());
    }

    #[test]
    fn merge_writes_knowledge_collections_once_and_reuses_existing_entries() {
        let existing = serde_json::json!({
            "files": [{"type": "collection", "id": "kb1", "name": "Docs", "extra": true}]
        });
        let knowledge = vec![
            KnowledgeRef { id: "kb1".into(), name: "Docs".into() },
            KnowledgeRef { id: "kb2".into(), name: "More".into() },
        ];
        let chat = merge_chat_value(&existing, "http://s", "T", "m", &[], &knowledge);
        let files = chat["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["extra"], true);
        assert_eq!(files[1]["id"], "kb2");
        assert_eq!(files[1]["type"], "collection");
    }

    #[test]
    fn merge_into_an_empty_chat_builds_a_linear_chain() {
        let chat = merge_chat_value(
            &Value::Null,
            "http://s",
            "T",
            "m",
            &[sync_msg("u", "user", "q"), sync_msg("a", "assistant", "r")],
            &[],
        );
        assert_eq!(chat["history"]["currentId"], "a");
        assert_eq!(chat["history"]["messages"]["a"]["parentId"], "u");
        assert_eq!(chat["history"]["messages"]["u"]["childrenIds"], serde_json::json!(["a"]));
        assert_eq!(chat["history"]["messages"]["a"]["done"], true);
        assert_eq!(chat["messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn chat_value_links_messages_in_a_chain() {
        let ids = vec!["m1".to_string(), "m2".to_string()];
        let v = chat_value("T", "gpt", &ids, &[("user", "q", 5), ("assistant", "a", 6)]);
        assert_eq!(v["history"]["currentId"], "m2");
        assert_eq!(v["history"]["messages"]["m2"]["parentId"], "m1");
        assert_eq!(v["history"]["messages"]["m1"]["childrenIds"], serde_json::json!(["m2"]));
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

    fn reasoning(events: &[SseEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                SseEvent::Reasoning(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn reads_reasoning_from_the_field_names_servers_use() {
        for key in ["reasoning_content", "reasoning", "thinking"] {
            let mut parser = SseParser::default();
            let line = format!("data: {{\"choices\":[{{\"delta\":{{\"{key}\":\"Let me see\",\"content\":\"\"}}}}]}}\n");
            let events = parser.feed(line.as_bytes());
            assert_eq!(reasoning(&events), "Let me see", "field {key}");
            assert_eq!(deltas(&events), "", "an empty content delta is not an event");
        }
    }

    #[test]
    fn think_tags_in_the_text_stay_ordinary_text_for_the_frontend_to_split() {
        let mut parser = SseParser::default();
        let events = parser.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"<think>hmm</think>Answer\"}}]}\n");
        assert_eq!(deltas(&events), "<think>hmm</think>Answer");
        assert_eq!(reasoning(&events), "");
    }

    #[test]
    fn forwards_the_sources_line_open_webui_sends_before_the_text() {
        let mut parser = SseParser::default();
        let events = parser.feed(
            b"data: {\"sources\":[{\"source\":{\"id\":\"f1\",\"name\":\"handbook.pdf\"},\"document\":[\"text\"],\"metadata\":[{\"source\":\"handbook.pdf\"}]}]}\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n",
        );
        let sources: Vec<&Vec<Value>> = events
            .iter()
            .filter_map(|e| match e {
                SseEvent::Sources(s) => Some(s),
                _ => None,
            })
            .collect();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0][0]["source"]["name"], "handbook.pdf");
        assert_eq!(deltas(&events), "Hi");
        // an empty list is not worth an event
        assert!(parser.feed(b"data: {\"sources\":[]}\n").is_empty());
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
