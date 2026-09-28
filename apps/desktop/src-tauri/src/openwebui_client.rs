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
    })
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

    let body = serde_json::json!({
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

pub async fn stream_chat_completion(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    knowledge_ids: Vec<String>,
    channel: Channel<ChatChunk>,
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
    let mut req = reqwest::Client::new().post(&url).json(&body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = match req.send().await {
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
    let mut buf = String::new();
    let mut last_prompt_tokens: Option<u32> = None;
    let mut last_completion_tokens: Option<u32> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = channel.send(ChatChunk::Error {
                    message: format!("stream error: {e}"),
                });
                return Ok(());
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);

            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                let _ = channel.send(ChatChunk::Done {
                    prompt_tokens: last_prompt_tokens,
                    completion_tokens: last_completion_tokens,
                });
                return Ok(());
            }
            if data.is_empty() {
                continue;
            }

            match serde_json::from_str::<Value>(data) {
                Ok(json) => {
                    if let Some(content) = json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        if !content.is_empty() {
                            let _ = channel.send(ChatChunk::Delta {
                                content: content.to_string(),
                            });
                        }
                    }
                    // llama.cpp-style `timings` on the terminal chunk (see module docs).
                    if let Some(timings) = json.get("timings") {
                        last_prompt_tokens = timings
                            .get("prompt_n")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32)
                            .or(last_prompt_tokens);
                        last_completion_tokens = timings
                            .get("predicted_n")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32)
                            .or(last_completion_tokens);
                    }
                    // OpenAI-style `usage` (present on some providers even mid-stream).
                    if let Some(usage) = json.get("usage") {
                        last_prompt_tokens = usage
                            .get("prompt_tokens")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32)
                            .or(last_prompt_tokens);
                        last_completion_tokens = usage
                            .get("completion_tokens")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32)
                            .or(last_completion_tokens);
                    }
                }
                Err(_) => continue,
            }
        }
    }

    let _ = channel.send(ChatChunk::Done {
        prompt_tokens: last_prompt_tokens,
        completion_tokens: last_completion_tokens,
    });
    Ok(())
}
