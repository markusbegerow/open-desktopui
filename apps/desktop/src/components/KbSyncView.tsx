import { FormEvent, useCallback, useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DaemonHealth,
  HistoryEntry,
  getDaemonReady,
  getDaemonStatus,
  getSyncHistory,
  triggerSync,
} from "../lib/oikbClient";
import {
  getOikbDaemonConfig,
  getOikbSources,
  getOpenWebUiConfig,
  OikbSource,
  setOikbDaemonConfig,
  setOikbSources,
} from "../lib/settingsStore";
import { KnowledgeBase, listKnowledgeBases } from "../lib/openWebUiClient";

const POLL_INTERVAL_MS = 5000;
const INTERVAL_OPTIONS = ["15m", "30m", "1h", "6h", "12h", "1d"];

export default function KbSyncView() {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorStreak, setErrorStreak] = useState(0);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [yamlPath, setYamlPath] = useState("");
  const [oikbMainPath, setOikbMainPath] = useState("");
  const [daemonApiKey, setDaemonApiKey] = useState("");
  const [daemonSaved, setDaemonSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);

  const [sources, setSources] = useState<OikbSource[]>([]);
  const [savingSources, setSavingSources] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [newKbId, setNewKbId] = useState("");
  const [newInterval, setNewInterval] = useState("1h");
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function performRestart(mainPath: string, yaml: string, apiKey: string): Promise<boolean> {
    setRestartError(null);
    if (!mainPath.trim()) {
      setRestartError("Set the oikb project folder below first.");
      return false;
    }
    setRestarting(true);
    try {
      await invoke("restart_daemon", {
        oikbMainPath: mainPath.trim(),
        yamlPath: yaml.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      return true;
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setRestarting(false);
    }
  }

  const refresh = useCallback(async () => {
    try {
      const daemonConfig = await getOikbDaemonConfig();
      const [h, hist] = await Promise.all([
        getDaemonStatus(daemonConfig?.apiKey),
        getSyncHistory({ apiKey: daemonConfig?.apiKey, limit: 20 }),
      ]);
      setHealth(h);
      setHistory(hist.entries ?? []);
      setError(null);
      setErrorStreak(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setErrorStreak((n) => n + 1);
    }
  }, []);

  // Writes the *enabled* subset of the local source list to .oikb.yaml,
  // restarts the app-managed daemon so it picks up the change, and
  // refreshes status. Called after every add/edit/toggle/delete.
  async function syncSourcesToYaml(list: OikbSource[], mainPath: string, yaml: string, apiKey: string) {
    setSavingSources(true);
    try {
      await invoke("write_oikb_sources", {
        yamlPath: yaml,
        sources: list
          .filter((s) => s.enabled)
          .map((s) => ({ name: s.name, folder: s.folder, kb_id: s.kbId, interval: s.interval })),
      });
      await performRestart(mainPath, yaml, apiKey);
      await refresh();
    } finally {
      setSavingSources(false);
    }
  }

  useEffect(() => {
    (async () => {
      const [owui, daemonConfig] = await Promise.all([getOpenWebUiConfig(), getOikbDaemonConfig()]);
      const apiKey = daemonConfig?.apiKey ?? "";
      if (apiKey) setDaemonApiKey(apiKey);
      if (daemonConfig?.oikbMainPath) setOikbMainPath(daemonConfig.oikbMainPath);

      let yaml = daemonConfig?.yamlPath ?? "";
      if (yaml) {
        setYamlPath(yaml);
      } else {
        // First run: no path set yet — provision (and own) a default
        // .oikb.yaml under the app's data dir instead of asking for one.
        yaml = await invoke<string>("ensure_default_yaml_path");
        setYamlPath(yaml);
        await setOikbDaemonConfig({ ...daemonConfig, yamlPath: yaml });
      }

      // Seed the local source list from whatever's already in .oikb.yaml,
      // the first time only — after that, the app's local list is the
      // superset of truth (including disabled sources oikb never sees).
      let loadedSources = await getOikbSources();
      if (loadedSources.length === 0 && yaml) {
        try {
          const existing = await invoke<
            { name: string; folder: string; kb_id: string; interval: string }[]
          >("read_oikb_sources", { yamlPath: yaml });
          if (existing.length > 0) {
            loadedSources = existing.map((e) => ({
              id: crypto.randomUUID(),
              name: e.name,
              folder: e.folder,
              kbId: e.kb_id,
              enabled: true,
              interval: e.interval || "1h",
            }));
            await setOikbSources(loadedSources);
          }
        } catch {
          // Non-fatal — starts with an empty source list.
        }
      }
      setSources(loadedSources);

      if (daemonConfig?.oikbMainPath) {
        await performRestart(daemonConfig.oikbMainPath, yaml, apiKey);
        await refresh();
      }

      if (owui?.baseUrl) {
        try {
          setKnowledgeBases(await listKnowledgeBases(owui.baseUrl, owui.apiKey || undefined));
        } catch {
          // Non-fatal — the KB picker just won't populate; sync itself doesn't need this call.
        }
      }

      setConfigLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Nothing to reach until we know a project folder is configured — avoids
    // a doomed request against the daemon on the very first open, before
    // there's anything to manage or before it's had time to start.
    if (!configLoaded || !oikbMainPath.trim()) return;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh, configLoaded, oikbMainPath]);

  // Rust's daemon watchdog (daemon_sidecar.rs) emits this the moment it
  // detects the oikb child process died unexpectedly, rather than waiting
  // for the next POLL_INTERVAL_MS tick to notice via /health.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("daemon-crashed", () => {
      refresh();
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  async function handleSaveDaemonConfig(e: FormEvent) {
    e.preventDefault();
    await setOikbDaemonConfig({
      apiKey: daemonApiKey.trim() || undefined,
      yamlPath: yamlPath.trim() || undefined,
      oikbMainPath: oikbMainPath.trim() || undefined,
    });
    setDaemonSaved(true);
    setTimeout(() => setDaemonSaved(false), 2000);
    await performRestart(oikbMainPath, yamlPath, daemonApiKey);
    await refresh();
  }

  async function handleChooseYamlFile() {
    const selected = await open({
      filters: [{ name: "oikb config", extensions: ["yaml", "yml"] }],
      multiple: false,
    });
    if (!selected || Array.isArray(selected)) return;
    setYamlPath(selected);
    await setOikbDaemonConfig({
      apiKey: daemonApiKey.trim() || undefined,
      yamlPath: selected,
      oikbMainPath: oikbMainPath.trim() || undefined,
    });
    await performRestart(oikbMainPath, selected, daemonApiKey);
    await refresh();
  }

  async function handleChooseOikbMainFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setOikbMainPath(selected);
    await setOikbDaemonConfig({
      apiKey: daemonApiKey.trim() || undefined,
      yamlPath: yamlPath.trim() || undefined,
      oikbMainPath: selected,
    });
    await performRestart(selected, yamlPath, daemonApiKey);
    await refresh();
  }

  async function handleSyncNow(name: string) {
    setSyncing(name);
    try {
      const daemonConfig = await getOikbDaemonConfig();
      await triggerSync(name, { apiKey: daemonConfig?.apiKey });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }

  async function updateSources(next: OikbSource[]) {
    setSources(next);
    await setOikbSources(next);
    await syncSourcesToYaml(next, oikbMainPath, yamlPath, daemonApiKey);
  }

  async function handlePickNewFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setNewFolder(selected);
    if (!newName.trim()) {
      setNewName(selected.split(/[\\/]/).pop() ?? "source");
    }
  }

  async function handleAddSource(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newFolder.trim() || !newKbId) return;
    const kb = knowledgeBases.find((k) => k.id === newKbId);
    const source: OikbSource = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      folder: newFolder.trim(),
      kbId: newKbId,
      kbName: kb?.name,
      enabled: true,
      interval: newInterval,
    };
    await updateSources([...sources, source]);
    setNewName("");
    setNewFolder("");
    setNewKbId("");
    setNewInterval("1h");
  }

  async function handleToggleSource(id: string) {
    await updateSources(sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }

  async function handleChangeSourceInterval(id: string, interval: string) {
    await updateSources(sources.map((s) => (s.id === id ? { ...s, interval } : s)));
  }

  async function handleChangeSourceFolder(id: string) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    await updateSources(sources.map((s) => (s.id === id ? { ...s, folder: selected } : s)));
  }

  async function handleChangeSourceKb(id: string, kbId: string) {
    if (!kbId) return;
    const kb = knowledgeBases.find((k) => k.id === kbId);
    await updateSources(sources.map((s) => (s.id === id ? { ...s, kbId, kbName: kb?.name } : s)));
  }

  async function handleDeleteSource(id: string) {
    const ok = await confirm("Remove this source? Its folder/KB configuration will be lost.", {
      title: "Remove source",
      kind: "warning",
    });
    if (!ok) return;
    await updateSources(sources.filter((s) => s.id !== id));
  }

  async function handleClearSyncHistory() {
    const ok = await confirm("Clear the sync history log? This can't be undone.", {
      title: "Clear history",
      kind: "warning",
    });
    if (!ok) return;
    setClearingHistory(true);
    try {
      await invoke("clear_sync_history");
      await refresh();
    } finally {
      setClearingHistory(false);
    }
  }

  async function handleCopyStartCommand() {
    if (!yamlPath) return;
    await navigator.clipboard.writeText(`oikb daemon --config "${yamlPath}"`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="view">
      <h2>Knowledge Base Sync</h2>

      {configLoaded && !oikbMainPath.trim() && (
        <p className="hint">Set the oikb project folder below to start the sync daemon.</p>
      )}
      {configLoaded && oikbMainPath.trim() && error && errorStreak >= 2 && (
        <p className="status-error">
          {error} — the app manages the sync daemon automatically; check the oikb project folder
          below is set correctly.
        </p>
      )}
      {restartError && <p className="status-error">Daemon restart failed: {restartError}</p>}

      <fieldset>
        <legend>Sources</legend>
        {sources.length === 0 && <p className="hint">No sources yet — add one below.</p>}

        {sources.length > 0 && (
          <div className="source-list">
            {sources.map((s) => {
              const live = s.enabled ? health?.sources[s.name] : undefined;
              return (
                <div className="source-card" key={s.id}>
                  <div className="source-card-header">
                    <label className="source-card-toggle">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={savingSources}
                        onChange={() => handleToggleSource(s.id)}
                      />
                      <span className="source-card-name">{s.name}</span>
                    </label>
                    <div className="source-card-actions">
                      <button
                        onClick={() => handleSyncNow(s.name)}
                        disabled={!s.enabled || syncing === s.name}
                      >
                        {syncing === s.name ? "Syncing..." : "Sync now"}
                      </button>
                      <button type="button" onClick={() => handleDeleteSource(s.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="source-card-body">
                    <div className="source-card-field">
                      <span className="source-card-label">Folder</span>
                      <span className="source-folder-path" title={s.folder}>{s.folder}</span>
                      <button type="button" onClick={() => handleChangeSourceFolder(s.id)}>
                        Change...
                      </button>
                    </div>
                    <div className="source-card-field">
                      <span className="source-card-label">Knowledge Base</span>
                      {knowledgeBases.length > 0 ? (
                        <select
                          value={s.kbId}
                          onChange={(e) => handleChangeSourceKb(s.id, e.target.value)}
                        >
                          {!knowledgeBases.some((kb) => kb.id === s.kbId) && (
                            <option value={s.kbId}>{s.kbName ?? s.kbId}</option>
                          )}
                          {knowledgeBases.map((kb) => (
                            <option key={kb.id} value={kb.id}>
                              {kb.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{s.kbName ?? s.kbId}</span>
                      )}
                    </div>
                    <div className="source-card-field">
                      <span className="source-card-label">Sync every</span>
                      <select
                        value={s.interval}
                        onChange={(e) => handleChangeSourceInterval(s.id, e.target.value)}
                      >
                        {INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="source-card-field">
                      <span className="source-card-label">Status</span>
                      {!s.enabled ? (
                        <span className="hint">disabled</span>
                      ) : live ? (
                        <StatusBadge status={live.status} />
                      ) : (
                        <span className="hint">pending</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <form onSubmit={handleAddSource} className="row">
          <input
            type="text"
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="button" onClick={handlePickNewFolder}>
            {newFolder ? "Change folder..." : "Choose folder..."}
          </button>
          {newFolder && <span className="hint">{newFolder}</span>}
          <select value={newKbId} onChange={(e) => setNewKbId(e.target.value)}>
            <option value="">Pick Knowledge Base...</option>
            {knowledgeBases.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>
          <select value={newInterval} onChange={(e) => setNewInterval(e.target.value)}>
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!newName.trim() || !newFolder.trim() || !newKbId}>
            Add source
          </button>
        </form>
      </fieldset>

      <button
        type="button"
        className="advanced-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? "▾" : "▸"} Advanced: daemon connection
      </button>

      {showAdvanced && (
      <form onSubmit={handleSaveDaemonConfig} className="settings-form daemon-config-form">
        <fieldset>
          <legend>Daemon connection</legend>
          <p className="hint">
            The app runs <code>oikb daemon</code> itself from this folder and restarts it
            automatically whenever a source changes above.
          </p>
          <label>
            oikb project folder (the <code>oikb-main</code> checkout — not a sync source)
            <div className="row">
              <input
                type="text"
                placeholder="e.g. C:\path\to\oikb-main"
                value={oikbMainPath}
                onChange={(e) => setOikbMainPath(e.target.value)}
              />
              <button type="button" onClick={handleChooseOikbMainFolder}>
                Choose folder...
              </button>
            </div>
          </label>
          <label>
            .oikb.yaml path
            <div className="row">
              <input
                type="text"
                placeholder="e.g. C:\path\to\oikb-main\.oikb.yaml"
                value={yamlPath}
                onChange={(e) => setYamlPath(e.target.value)}
              />
              <button type="button" onClick={handleChooseYamlFile}>
                Choose file...
              </button>
            </div>
          </label>
          <label>
            Daemon API key
            <input
              type="password"
              placeholder="Only needed if you want the daemon to require it"
              value={daemonApiKey}
              onChange={(e) => setDaemonApiKey(e.target.value)}
            />
          </label>
          <div className="row">
            <button type="submit">Save</button>
            {daemonSaved && <span className="status-ok">Saved</span>}
            <button type="button" onClick={handleCopyStartCommand} disabled={!yamlPath.trim()}>
              {copied ? "Copied!" : "Copy start command"}
            </button>
            <button
              type="button"
              onClick={() => performRestart(oikbMainPath, yamlPath, daemonApiKey).then(refresh)}
              disabled={restarting}
            >
              {restarting ? "Restarting..." : "Restart daemon"}
            </button>
          </div>
          <DaemonReadyBadge />
        </fieldset>
      </form>
      )}

      <div className="row">
        <h3>Recent history</h3>
        <button type="button" onClick={handleClearSyncHistory} disabled={clearingHistory}>
          {clearingHistory ? "Clearing..." : "Clear history"}
        </button>
      </div>
      {history.length === 0 ? (
        <p className="hint">No sync history yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="sources-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {latestHistoryBySource(history).map((h) => (
              <tr key={h.id}>
                <td>
                  <span className="source-folder-path" title={h.source}>{h.source}</span>
                </td>
                <td>
                  <StatusBadge status={h.status} />
                </td>
                <td>{new Date(h.started_at * 1000).toLocaleString()}</td>
                <td>{h.duration_ms ? `${Math.round(h.duration_ms / 1000)}s` : "-"}</td>
                <td className="status-error">{h.error_message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function DaemonReadyBadge() {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDaemonReady()
      .then((r) => !cancelled && setReady(r))
      .catch(() => !cancelled && setReady(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p className="hint">
      oikb daemon (localhost:8080):{" "}
      {ready === null ? (
        "checking..."
      ) : ready ? (
        <span className="status-ok">reachable</span>
      ) : (
        <span className="status-error">not reachable</span>
      )}
    </p>
  );
}

// "Recent history" shows one line per source (its most recent run), not the
// full log — /history returns newest-first, so the first entry seen per
// source is its latest.
function latestHistoryBySource(history: HistoryEntry[]): HistoryEntry[] {
  const latest = new Map<string, HistoryEntry>();
  for (const h of history) {
    if (!latest.has(h.source)) latest.set(h.source, h);
  }
  return [...latest.values()];
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "error" ? "status-error" : status === "success" ? "status-ok" : "";
  return <span className={cls}>{status}</span>;
}
