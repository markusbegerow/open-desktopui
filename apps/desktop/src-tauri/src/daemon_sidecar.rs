//! Dev-mode sidecar: the app spawns and manages the oikb daemon itself
//! (`uv run oikb daemon`), instead of requiring the user to start/restart
//! it by hand in a separate terminal. This is the real M3 sidecar-lifecycle
//! work, done now against the existing `oikb-main` checkout rather than a
//! packaged PyInstaller binary (that packaging step is still M4).
//!
//! Parameters (oikb project folder, `.oikb.yaml` path, optional daemon API
//! key) come from the frontend's settings store on every call — Rust never
//! reads that store directly, matching the pattern already used by every
//! other command in this codebase (e.g. `set_source_folder`).

use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct DaemonState {
    pub child: Mutex<Option<CommandChild>>,
    // Set right before a deliberate `kill_daemon` call so the event loop
    // below can tell "we killed it" apart from "it crashed on its own"
    // when the child's `Terminated` event arrives.
    expected_exit: AtomicBool,
}

impl DaemonState {
    fn mark_expected_exit(&self) {
        self.expected_exit.store(true, Ordering::SeqCst);
    }

    /// Reads and clears the flag in one step. A plain method on
    /// `DaemonState` itself (no `AppHandle` needed) so the crash/expected
    /// decision is unit-testable without spawning a real process.
    fn take_expected_exit(&self) -> bool {
        self.expected_exit.swap(false, Ordering::SeqCst)
    }
}

/// Kills whatever is currently listening on port 8080 — our own previously
/// spawned child, a stale one from a prior session, or a manually-started
/// daemon the user left running. Same proven pattern as
/// `apps/desktop/rebuild-and-run.bat`'s port-1420 cleanup.
fn kill_port_8080() {
    let _ = StdCommand::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }",
        ])
        .output();
}

/// Stops and forgets our own tracked child, if any (separate from
/// `kill_port_8080`, which handles processes we didn't spawn ourselves).
pub fn kill_daemon(app: &AppHandle) {
    let state = app.state::<DaemonState>();
    state.mark_expected_exit();
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
}

/// Packaged builds bundle a real `oikb` binary as a Tauri sidecar (see
/// `packaging/oikb-sidecar/`, wired via `tauri.conf.json`'s
/// `bundle.externalBin`) — no Python/uv checkout needed on the end user's
/// machine. Dev builds don't have that binary sitting next to the app
/// executable, so `spawn_daemon` tries the sidecar first and falls back to
/// the `uv run` dev-mode path (`oikbMainPath` setting) if that spawn fails,
/// rather than needing an explicit "which mode am I in" config flag.
fn build_sidecar_command(
    app: &AppHandle,
    yaml_path: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    app.shell()
        .sidecar("oikb")
        .map(|cmd| cmd.args(["daemon", "--port", "8080", "--config", yaml_path]))
        .map_err(|e| e.to_string())
}

fn build_dev_command(
    app: &AppHandle,
    oikb_main_path: &str,
    yaml_path: &str,
) -> tauri_plugin_shell::process::Command {
    app.shell()
        .command("uv")
        .args(["run", "oikb", "daemon", "--port", "8080", "--config", yaml_path])
        .current_dir(oikb_main_path)
}

pub async fn spawn_daemon(
    app: AppHandle,
    oikb_main_path: String,
    yaml_path: String,
    api_key: Option<String>,
) -> Result<(), String> {
    kill_daemon(&app);
    kill_port_8080();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut used_sidecar = true;
    let mut cmd = match build_sidecar_command(&app, &yaml_path) {
        Ok(cmd) => cmd,
        Err(e) => {
            used_sidecar = false;
            log::info!("[oikb daemon] no bundled sidecar available ({e}); falling back to dev-mode `uv run`");
            if oikb_main_path.trim().is_empty() {
                return Err("oikb project folder not set (and no bundled sidecar binary found)".to_string());
            }
            build_dev_command(&app, &oikb_main_path, &yaml_path)
        }
    };
    cmd = cmd.env("PYTHONUTF8", "1");
    if let Some(key) = api_key.clone().filter(|k| !k.is_empty()) {
        cmd = cmd.env("OIKB_API_KEY", key);
    }

    let (mut rx, child) = match cmd.spawn() {
        Ok(spawned) => spawned,
        Err(e) if used_sidecar => {
            // The sidecar Command builds fine even when the binary is
            // missing (see `Command::new_sidecar`'s doc comment) — the
            // actual "not found" only surfaces here, at OS-level spawn.
            log::info!("[oikb daemon] sidecar spawn failed ({e}); falling back to dev-mode `uv run`");
            if oikb_main_path.trim().is_empty() {
                return Err(format!(
                    "failed to spawn bundled oikb sidecar, and no oikb project folder is set to fall back to: {e}"
                ));
            }
            let mut fallback = build_dev_command(&app, &oikb_main_path, &yaml_path).env("PYTHONUTF8", "1");
            if let Some(key) = api_key.filter(|k| !k.is_empty()) {
                fallback = fallback.env("OIKB_API_KEY", key);
            }
            fallback
                .spawn()
                .map_err(|e| format!("failed to spawn oikb daemon ({oikb_main_path}): {e}"))?
        }
        Err(e) => return Err(format!("failed to spawn oikb daemon: {e}")),
    };

    log::info!(
        "[oikb daemon] spawned ({} --config {yaml_path})",
        if used_sidecar { "bundled sidecar" } else { "uv run" }
    );

    let events_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    log::debug!("[oikb daemon] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Stderr(bytes) => {
                    log::warn!("[oikb daemon] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(err) => {
                    log::error!("[oikb daemon] process error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    let state = events_app.state::<DaemonState>();
                    let expected = state.take_expected_exit();
                    if expected {
                        log::info!("[oikb daemon] terminated (expected): code={:?}", payload.code);
                    } else {
                        log::error!("[oikb daemon] terminated unexpectedly: code={:?}", payload.code);
                        let _ = events_app.emit("daemon-crashed", ());
                        let _ = events_app
                            .notification()
                            .builder()
                            .title("Open DesktopUI")
                            .body("The knowledge base sync daemon stopped unexpectedly. Open Settings > Knowledge to restart it.")
                            .show();
                    }
                }
                _ => {}
            }
        }
    });

    {
        let state = app.state::<DaemonState>();
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
    }

    for _ in 0..20 {
        if crate::oikb_client::get_health_ready().await.unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    log::error!("[oikb daemon] did not become ready within 10s");
    Err("daemon did not become ready within 10s".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_exit_flag_round_trips_and_clears() {
        let state = DaemonState::default();
        // Nothing marked yet: an exit right now would look unexpected.
        assert!(!state.take_expected_exit());

        // After marking, exactly one read reports "expected" ...
        state.mark_expected_exit();
        assert!(state.take_expected_exit());
        // ... and the flag is consumed, not sticky.
        assert!(!state.take_expected_exit());
    }
}
