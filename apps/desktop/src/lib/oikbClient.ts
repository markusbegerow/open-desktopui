// Typed frontend client for oikb's local daemon, proxied through the Rust
// commands in `src-tauri/src/commands.rs` (which in turn call
// `src-tauri/src/oikb_client.rs`). Route shapes come directly from
// `oikb-main/src/oikb/daemon.py` — see the project plan's "Integration
// contract" section for the source-verified route list.
import { invoke } from "@tauri-apps/api/core";

export type SourceStatus =
  | "idle"
  | "running"
  | "success"
  | "partial"
  | "error"
  | "cancelled";

export interface SourceHealth {
  name: string;
  status: SourceStatus;
  last_sync?: number;
  duration_ms?: number;
  files_added?: number;
  files_modified?: number;
  files_deleted?: number;
  unmodified?: number;
  warnings?: string[];
  errors?: string[];
  error?: string;
}

export interface DaemonHealth {
  status: string;
  version: string;
  sources: Record<string, SourceHealth>;
}

export interface HistoryEntry {
  id: number;
  source: string;
  kb_id: string;
  status: SourceStatus;
  started_at: number;
  finished_at?: number;
  duration_ms?: number;
  files_added?: number;
  files_modified?: number;
  files_deleted?: number;
  unmodified?: number;
  error_message?: string;
  created_at: number;
}

export interface TriggerSyncResult {
  triggered?: boolean;
  dry_run?: boolean;
  name?: string;
  kb_id?: string;
  error?: string;
  result?: {
    added: number;
    modified: number;
    deleted: number;
    unmodified: number;
    warnings: string[];
    errors: string[];
    summary: string;
  };
}

export async function getDaemonStatus(apiKey?: string): Promise<DaemonHealth> {
  return invoke("get_daemon_status", { apiKey });
}

export async function getDaemonReady(): Promise<boolean> {
  return invoke("get_daemon_ready");
}

export async function getSyncHistory(opts?: {
  apiKey?: string;
  limit?: number;
  kbId?: string;
  errorsOnly?: boolean;
}): Promise<{ entries: HistoryEntry[] }> {
  return invoke("get_sync_history", {
    apiKey: opts?.apiKey,
    limit: opts?.limit,
    kbId: opts?.kbId,
    errorsOnly: opts?.errorsOnly,
  });
}

export async function triggerSync(
  identifier: string,
  opts?: { apiKey?: string; dryRun?: boolean },
): Promise<TriggerSyncResult> {
  return invoke("trigger_sync", {
    identifier,
    apiKey: opts?.apiKey,
    dryRun: opts?.dryRun,
  });
}
