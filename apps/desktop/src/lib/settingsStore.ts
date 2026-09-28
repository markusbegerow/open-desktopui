// Persists connection settings (Open WebUI URL/API key, oikb daemon API
// key) via tauri-plugin-store.
//
// The two `apiKey` fields are secrets and are NOT stored in this plain JSON
// file — they're written/read through `secureStore.ts` (Stronghold-backed,
// encrypted). Everything else (baseUrl, accountId, yamlPath, prefs, sources)
// is genuinely fine as plain JSON: none of it is a credential. A record
// carrying a leftover plaintext `apiKey` from before this split is migrated
// into secure storage (and stripped from the plain file) the first time
// it's read — see the migration block in `getOpenWebUiConfig`/
// `getOikbDaemonConfig` below.
import { load, type Store } from "@tauri-apps/plugin-store";
import { deleteSecret, getSecret, setSecret } from "./secureStore";

const OPENWEBUI_APIKEY_SECRET = "openwebui.apiKey";
const OIKB_DAEMON_APIKEY_SECRET = "oikbDaemon.apiKey";

const STORE_FILE = "settings.json";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    // Don't let a failed first load poison every later call: if `load()`
    // rejects, clear the cache so the next call retries instead of reusing
    // the same rejected promise forever.
    storePromise = load(STORE_FILE, { autoSave: true }).catch((err) => {
      storePromise = null;
      throw err;
    });
  }
  return storePromise;
}

export interface OpenWebUiConfig {
  baseUrl: string;
  apiKey: string;
  // Stable per-account key (`${baseUrl}|${openWebUiUserId}`), set at sign-in.
  // Used to scope local chat history/dashboard stats so switching accounts
  // never mixes data (Addendum 9).
  accountId?: string;
}

export interface OikbDaemonConfig {
  apiKey?: string;
  // Path to the `.oikb.yaml` the running daemon actually reads (its CWD's
  // `.oikb.yaml`, unless it was started with `--config <path>`). Needed so
  // the folder-picker in KB Sync knows which file to edit. This is a
  // dev-time convenience ahead of M3's proper sidecar-managed config path.
  yamlPath?: string;
  // Path to the `oikb-main/` checkout the app runs `uv run oikb daemon`
  // from (Addendum 10). Disappears once M4 ships a packaged sidecar binary
  // with no external project folder to locate.
  oikbMainPath?: string;
}

export interface AppPrefs {
  displayName?: string;
  theme?: "light" | "dark" | "system";
  // How the mic button records: "toggle" (click to start, click to stop) or
  // "push-to-talk" (hold to record, release to stop). Defaults to "toggle"
  // since that matches the interaction model users already had.
  micMode?: "toggle" | "push-to-talk";
  sidebarCollapsed?: boolean;
  // Model id new chats start with when set and still present in the
  // server's model list; falls back to the first listed model otherwise.
  defaultModelId?: string;
  // "enter": Enter sends, Shift+Enter newline (today's default behavior).
  // "ctrl-enter": Ctrl+Enter sends, plain Enter is a normal newline.
  sendKey?: "enter" | "ctrl-enter";
  // Desktop notification when an assistant reply finishes while the window
  // isn't focused. Defaults to off.
  notifyOnReply?: boolean;
  chatTextSize?: "small" | "medium" | "large";
  // "auto": detected from Open WebUI's user info, falling back to English.
  language?: "auto" | "en" | "es" | "de";
  // Whether closing the window (X button) hides to tray and keeps the app
  // running (today's only behavior) or actually quits it. Defaults to true.
  keepRunningInTray?: boolean;
}

// A source the user has configured, whether or not it's currently active
// (Addendum 11). `.oikb.yaml` itself only ever contains the *enabled*
// subset — this list is the app's own superset, letting a source be
// disabled without losing its folder/KB configuration.
export interface OikbSource {
  id: string; // local id, stable across renames — never sent to oikb
  name: string;
  folder: string;
  kbId: string;
  kbName?: string;
  enabled: boolean;
  interval: string; // duration ("15m"/"30m"/"1h"/"6h"/"12h"/"1d") for oikb's daemon scheduler
}

const OPENWEBUI_KEY = "openwebui";
const OIKB_DAEMON_KEY = "oikbDaemon";
const APP_PREFS_KEY = "appPrefs";
const OIKB_SOURCES_KEY = "oikbSources";

type StoredOpenWebUiConfig = Omit<OpenWebUiConfig, "apiKey"> & { apiKey?: string };

export async function getOpenWebUiConfig(): Promise<OpenWebUiConfig | null> {
  const store = await getStore();
  const raw = (await store.get<StoredOpenWebUiConfig>(OPENWEBUI_KEY)) ?? null;
  if (!raw) return null;
  let apiKey = await getSecret(OPENWEBUI_APIKEY_SECRET);
  if (!apiKey && raw.apiKey) {
    // One-time migration: a plaintext apiKey left over from before secure
    // storage existed. Move it into the vault, then strip it from the
    // plain file so it doesn't linger there going forward.
    apiKey = raw.apiKey;
    await setSecret(OPENWEBUI_APIKEY_SECRET, apiKey);
    const { apiKey: _drop, ...rest } = raw;
    await store.set(OPENWEBUI_KEY, rest);
  }
  return { ...raw, apiKey: apiKey ?? "" };
}

export async function setOpenWebUiConfig(config: OpenWebUiConfig): Promise<void> {
  const store = await getStore();
  const { apiKey, ...rest } = config;
  await store.set(OPENWEBUI_KEY, rest);
  await setSecret(OPENWEBUI_APIKEY_SECRET, apiKey);
}

// Full reset: clears the connection (server + key) so LoginView starts back
// at the server-URL step — lets the user switch to a different Open WebUI
// instance, not just re-authenticate against the same one. Also clears
// displayName, since it's sourced from the signed-in account (Addendum 7),
// not an independent preference — it shouldn't linger from a previous
// account/server after switching.
export async function signOut(): Promise<void> {
  const store = await getStore();
  await store.delete(OPENWEBUI_KEY);
  const prefs = (await store.get<AppPrefs>(APP_PREFS_KEY)) ?? {};
  const { displayName: _drop, ...rest } = prefs;
  await store.set(APP_PREFS_KEY, rest);
  await deleteSecret(OPENWEBUI_APIKEY_SECRET);
}

export async function getOikbDaemonConfig(): Promise<OikbDaemonConfig | null> {
  const store = await getStore();
  const raw = (await store.get<OikbDaemonConfig>(OIKB_DAEMON_KEY)) ?? null;
  if (!raw) return null;
  let apiKey = (await getSecret(OIKB_DAEMON_APIKEY_SECRET)) ?? undefined;
  if (!apiKey && raw.apiKey) {
    apiKey = raw.apiKey;
    await setSecret(OIKB_DAEMON_APIKEY_SECRET, apiKey);
    const { apiKey: _drop, ...rest } = raw;
    await store.set(OIKB_DAEMON_KEY, rest);
  }
  return { ...raw, apiKey };
}

export async function setOikbDaemonConfig(config: OikbDaemonConfig): Promise<void> {
  const store = await getStore();
  const { apiKey, ...rest } = config;
  await store.set(OIKB_DAEMON_KEY, rest);
  if (apiKey) {
    await setSecret(OIKB_DAEMON_APIKEY_SECRET, apiKey);
  } else {
    await deleteSecret(OIKB_DAEMON_APIKEY_SECRET);
  }
}

export async function getAppPrefs(): Promise<AppPrefs | null> {
  const store = await getStore();
  return (await store.get<AppPrefs>(APP_PREFS_KEY)) ?? null;
}

// Merges rather than replaces — every existing call site only ever passes
// the one or two fields it cares about (e.g. just `displayName`), so a
// plain replace would silently wipe out unrelated prefs (like `theme`)
// set elsewhere.
export async function setAppPrefs(prefs: Partial<AppPrefs>): Promise<void> {
  const store = await getStore();
  const existing = (await store.get<AppPrefs>(APP_PREFS_KEY)) ?? {};
  await store.set(APP_PREFS_KEY, { ...existing, ...prefs });
}

export async function getOikbSources(): Promise<OikbSource[]> {
  const store = await getStore();
  return (await store.get<OikbSource[]>(OIKB_SOURCES_KEY)) ?? [];
}

export async function setOikbSources(sources: OikbSource[]): Promise<void> {
  const store = await getStore();
  await store.set(OIKB_SOURCES_KEY, sources);
}
