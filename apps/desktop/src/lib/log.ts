// Thin logging wrapper: logs to the console in dev (same as before), and in
// production also forwards to the `frontend_log` Rust command so frontend
// errors land in the same log file `tauri-plugin-log` writes for the Rust
// side (`lib.rs`) — one combined log a user can attach to a bug report,
// instead of a browser console dump nobody can retrieve from a shipped app.
import { invoke } from "@tauri-apps/api/core";

const isDev = import.meta.env.DEV;

function forward(level: "error" | "warn" | "info", message: string) {
  if (isDev) {
    // eslint-disable-next-line no-console
    console[level === "info" ? "log" : level](message);
    return;
  }
  invoke("frontend_log", { level, message }).catch(() => {
    // Nowhere left to report a logging failure itself.
  });
}

export function logError(message: string): void {
  forward("error", message);
}

export function logWarn(message: string): void {
  forward("warn", message);
}

export function logInfo(message: string): void {
  forward("info", message);
}
