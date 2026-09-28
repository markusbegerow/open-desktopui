//! Thin HTTP client for oikb's local FastAPI daemon.
//!
//! Route shapes are taken directly from `oikb-main/src/oikb/daemon.py`:
//! `/health` and `/health/ready` are unauthenticated; `/history` and
//! `/sync/{identifier}` require `Authorization: Bearer <OIKB_API_KEY>`
//! whenever that env var is set on the daemon process. In M1 the daemon
//! is started by hand with no `OIKB_API_KEY`, so the bearer token is
//! simply omitted when absent.

use serde_json::Value;

/// Where the oikb daemon is reachable. Hardcoded to the default port for
/// M1 (manually-started daemon); becomes configurable once the sidecar
/// (M3) picks a port itself and reports it back to the frontend.
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8080";

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn apply_auth(builder: reqwest::RequestBuilder, api_key: &Option<String>) -> reqwest::RequestBuilder {
    match api_key {
        Some(key) if !key.is_empty() => builder.bearer_auth(key),
        _ => builder,
    }
}

pub async fn get_health(api_key: Option<String>) -> Result<Value, String> {
    let url = format!("{DEFAULT_BASE_URL}/health");
    let req = apply_auth(client().get(&url), &api_key);
    // debug, not error: this is polled every few seconds by the UI, so a
    // transient failure (daemon still starting up, mid-restart) is normal
    // and would otherwise spam the log at default level.
    let resp = req
        .send()
        .await
        .map_err(|e| format!("failed to reach oikb daemon at {url}: {e}"))
        .inspect_err(|e| log::debug!("[oikb] {e}"))?;
    resp.json::<Value>().await.map_err(|e| format!("invalid /health response: {e}"))
}

pub async fn get_health_ready() -> Result<bool, String> {
    let url = format!("{DEFAULT_BASE_URL}/health/ready");
    match client().get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

pub async fn get_history(
    api_key: Option<String>,
    limit: u32,
    kb_id: Option<String>,
    errors_only: bool,
) -> Result<Value, String> {
    let mut url = format!("{DEFAULT_BASE_URL}/history?limit={limit}&errors_only={errors_only}");
    if let Some(kb) = kb_id {
        url.push_str(&format!("&kb_id={}", urlencoding_encode(&kb)));
    }
    let req = apply_auth(client().get(&url), &api_key);
    let resp = req.send().await.map_err(|e| format!("failed to reach oikb daemon at {url}: {e}"))?;
    resp.json::<Value>().await.map_err(|e| format!("invalid /history response: {e}"))
}

pub async fn trigger_sync(
    api_key: Option<String>,
    identifier: String,
    dry_run: bool,
) -> Result<Value, String> {
    let url = format!(
        "{DEFAULT_BASE_URL}/sync/{}?dry_run={dry_run}",
        urlencoding_encode(&identifier)
    );
    let req = apply_auth(client().post(&url), &api_key);
    let resp = req
        .send()
        .await
        .map_err(|e| format!("failed to reach oikb daemon at {url}: {e}"))
        .inspect_err(|e| log::error!("[oikb] {e}"))?;
    resp.json::<Value>().await.map_err(|e| format!("invalid /sync response: {e}"))
}

/// Minimal percent-encoding for path/query segments — avoids pulling in a
/// full `urlencoding` crate dependency for two call sites.
fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
