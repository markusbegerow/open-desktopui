import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import {
  getAppPrefs,
  getOpenWebUiConfig,
  setAppPrefs,
  setOpenWebUiConfig,
  signOut,
} from "../lib/settingsStore";
import { clearHistory, closeChatDb, getMessages, listConversations } from "../lib/chatHistory";
import { applyChatTextSize, applyTheme, Theme } from "../lib/theme";
import type { AppPrefs } from "../lib/settingsStore";
import { consumeVaultResetNotice } from "../lib/secureStore";
import { getCurrentUser, listModels, OpenWebUiModel } from "../lib/openWebUiClient";
import { Language, resolveLanguage, useTranslation } from "../lib/i18n";
import { logError } from "../lib/log";
import AboutTab from "./AboutTab";
import KbSyncView from "./KbSyncView";

export type SettingsTab = "general" | "account" | "knowledge" | "system" | "privacy" | "about";

const TAB_IDS: SettingsTab[] = ["general", "account", "knowledge", "system", "privacy", "about"];

export interface SettingsViewProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  language: Language;
  onLanguageChange: (lang: Language) => void;
}

export default function SettingsView({ activeTab, onTabChange, language, onLanguageChange }: SettingsViewProps) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [historyCleared, setHistoryCleared] = useState(false);
  const [repairingDb, setRepairingDb] = useState(false);
  const [dbRepaired, setDbRepaired] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("system");
  const [micMode, setMicMode] = useState<NonNullable<AppPrefs["micMode"]>>("toggle");
  const [chatTextSize, setChatTextSize] = useState<NonNullable<AppPrefs["chatTextSize"]>>("medium");
  const [sendKey, setSendKey] = useState<NonNullable<AppPrefs["sendKey"]>>("enter");
  const [notifyOnReply, setNotifyOnReply] = useState(false);
  const [notifyWarning, setNotifyWarning] = useState<string | null>(null);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [models, setModels] = useState<OpenWebUiModel[]>([]);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportAllStatus, setExportAllStatus] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [languagePref, setLanguagePref] = useState<"auto" | Language>(language);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [keepRunningInTray, setKeepRunningInTray] = useState(true);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = TAB_IDS.map((id) => ({ id, label: t(`settings.tabs.${id}`) }));

  useEffect(() => {
    (async () => {
      try {
        const owui = await getOpenWebUiConfig();
        if (consumeVaultResetNotice()) {
          setLoadError(
            "the stored credentials were unreadable and have been reset — please sign in again",
          );
        }
        if (owui) {
          setBaseUrl(owui.baseUrl);
          setApiKey(owui.apiKey);
        }
        const prefs = await getAppPrefs();
        if (prefs?.displayName) setDisplayName(prefs.displayName);
        setTheme(prefs?.theme ?? "light");
        setMicMode(prefs?.micMode ?? "toggle");
        setChatTextSize(prefs?.chatTextSize ?? "medium");
        setSendKey(prefs?.sendKey ?? "enter");
        setNotifyOnReply(prefs?.notifyOnReply ?? false);
        setDefaultModelId(prefs?.defaultModelId ?? "");
        setLanguagePref(prefs?.language ?? "auto");
        setKeepRunningInTray(prefs?.keepRunningInTray ?? true);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    appDataDir().then(setDataDir).catch(() => {});
    isAutostartEnabled()
      .then(setAutostartEnabled)
      .catch(() => {
        // Non-fatal — the autostart plugin may not be available on this platform.
      });
  }, []);

  useEffect(() => {
    if (!baseUrl.trim() || !apiKey.trim()) return;
    listModels(baseUrl.trim(), apiKey.trim())
      .then(setModels)
      .catch(() => {
        // Non-fatal — the default-model picker just won't populate.
      });
  }, [baseUrl, apiKey]);

  const hasSession = !!(baseUrl.trim() && apiKey.trim());

  async function handleDisplayNameBlur() {
    try {
      await setAppPrefs({ displayName: displayName.trim() || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConnectionBlur() {
    // Server URL/API key are read-only once a session exists (Sign out is
    // the only way to change them) — nothing to save for that pair here.
    if (hasSession) return;
    setSaveError(null);
    try {
      await setOpenWebUiConfig({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
      if (baseUrl.trim()) {
        await invoke("set_oikb_global_config", {
          url: baseUrl.trim(),
          token: apiKey.trim() || undefined,
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleThemeChange(next: Theme) {
    setTheme(next);
    applyTheme(next);
    await setAppPrefs({ theme: next });
  }

  async function handleChatTextSizeChange(next: NonNullable<AppPrefs["chatTextSize"]>) {
    setChatTextSize(next);
    applyChatTextSize(next);
    await setAppPrefs({ chatTextSize: next });
  }

  async function handleLanguageChange(next: "auto" | Language) {
    setLanguagePref(next);
    await setAppPrefs({ language: next });
    if (next !== "auto") {
      onLanguageChange(next);
      return;
    }
    let detected: string | null = null;
    if (hasSession) {
      try {
        const user = await getCurrentUser(baseUrl.trim(), apiKey.trim());
        detected = user.detectedLanguage;
      } catch {
        // Non-fatal — resolveLanguage below falls back to English.
      }
    }
    onLanguageChange(resolveLanguage("auto", detected));
  }

  async function handleMicModeChange(next: NonNullable<AppPrefs["micMode"]>) {
    setMicMode(next);
    await setAppPrefs({ micMode: next });
  }

  async function handleSendKeyChange(next: NonNullable<AppPrefs["sendKey"]>) {
    setSendKey(next);
    await setAppPrefs({ sendKey: next });
  }

  async function handleDefaultModelChange(next: string) {
    setDefaultModelId(next);
    await setAppPrefs({ defaultModelId: next || undefined });
  }

  async function handleNotifyToggle(next: boolean) {
    setNotifyOnReply(next);
    setNotifyWarning(null);
    await setAppPrefs({ notifyOnReply: next });
    if (!next) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) setNotifyWarning("Notification permission wasn't granted — check your OS settings.");
    } catch (err) {
      setNotifyWarning(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAutostartToggle(next: boolean) {
    setAutostartEnabled(next);
    setSystemError(null);
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
    } catch (err) {
      setAutostartEnabled(!next);
      setSystemError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeepRunningInTrayChange(next: boolean) {
    setKeepRunningInTray(next);
    await setAppPrefs({ keepRunningInTray: next });
    await invoke("set_keep_running_in_tray", { enabled: next });
  }

  async function handleClearHistory() {
    const ok = await confirm("Clear all local chat history for this account? This can't be undone.", {
      title: "Clear chat history",
      kind: "warning",
    });
    if (!ok) return;
    setClearingHistory(true);
    try {
      await clearHistory();
      setHistoryCleared(true);
      setTimeout(() => setHistoryCleared(false), 2000);
    } finally {
      setClearingHistory(false);
    }
  }

  // Last-resort recovery when `chat.db` itself is too corrupted to open or
  // query (disk full mid-write, an interrupted migration, etc.) — moves the
  // file aside rather than deleting it outright, and only takes effect after
  // a restart (the sql plugin opens its pool once at startup).
  async function handleRepairChatDb() {
    const ok = await confirm(
      "This deletes all local chat history and restarts the app. Conversations already shared to Open WebUI remain there. Only do this if the app is failing to load your chats. Continue?",
      { title: "Repair local database", kind: "warning" },
    );
    if (!ok) return;
    setRepairingDb(true);
    setRepairError(null);
    try {
      // Normally doesn't return — the command restarts the whole app process
      // once the corrupted file is moved aside (see `reset_chat_db` in
      // commands.rs for why a plain webview reload isn't enough here).
      await closeChatDb();
      await invoke("reset_chat_db");
      setDbRepaired(true);
    } catch (err) {
      setRepairingDb(false);
      setRepairError(err instanceof Error ? err.message : String(err));
    }
  }

  // Manual counterpart to the automatic recovery in `secureStore.ts`: moves
  // the encrypted credential vault aside, then reloads the webview so the
  // cached (unreadable) vault handle is dropped and a fresh one is created.
  async function handleResetVault() {
    const ok = await confirm(
      "This deletes the saved credentials (Open WebUI sign-in, API keys) and you will have to sign in again. Chat history is not affected. Continue?",
      { title: "Reset saved credentials", kind: "warning" },
    );
    if (!ok) return;
    setRepairError(null);
    try {
      await invoke("reset_vault");
      window.location.reload();
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleExportAll() {
    setExportingAll(true);
    setExportAllStatus(null);
    try {
      const conversations = await listConversations(100000);
      const data = [];
      for (const conversation of conversations) {
        const messages = await getMessages(conversation.id);
        data.push({ conversation, messages });
      }
      const saved = await invoke<boolean>("save_text_file", {
        defaultName: "chat-history-export.json",
        filterName: "JSON",
        extension: "json",
        content: JSON.stringify(data, null, 2),
      });
      if (!saved) return;
      setExportAllStatus("Exported");
    } catch (err) {
      setExportAllStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingAll(false);
      setTimeout(() => setExportAllStatus(null), 4000);
    }
  }

  async function handleShowDataFolder() {
    if (!dataDir) return;
    await revealItemInDir(dataDir);
  }

  async function handleCopyDataPath() {
    if (!dataDir) return;
    await navigator.clipboard.writeText(dataDir);
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1500);
  }

  async function handleSignOut() {
    setSignOutError(null);
    try {
      await signOut();
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Sign out failed: ${message}`);
      setSignOutError(message);
    }
  }

  async function handleTestConnection() {
    setStatus("testing");
    setStatusMessage("");
    try {
      const url = baseUrl.trim().replace(/\/+$/, "");
      if (!url) throw new Error("Enter a server URL first");
      await invoke("test_openwebui_connection", { baseUrl: url, apiKey: apiKey.trim() || undefined });
      setStatus("ok");
      setStatusMessage("Connected");
    } catch (err) {
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function handleTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = tabs[nextIndex];
    onTabChange(next.id);
    requestAnimationFrame(() => tabRefs.current[nextIndex!]?.focus());
  }

  return (
    <div className="view settings-view">
      <h2>{t("settings.title")}</h2>

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={handleTabKeyDown}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`settings-panel-${activeTab}`} aria-labelledby={`settings-tab-${activeTab}`}>
        {activeTab === "knowledge" && <KbSyncView />}
        {activeTab === "about" && <AboutTab />}

        {activeTab === "general" && (
          <>
            <fieldset>
              <legend>{t("settings.appearance")}</legend>
              <label>
                {t("settings.theme")}
                <select value={theme} onChange={(e) => handleThemeChange(e.target.value as Theme)}>
                  <option value="system">{t("settings.themeSystem")}</option>
                  <option value="light">{t("settings.themeLight")}</option>
                  <option value="dark">{t("settings.themeDark")}</option>
                </select>
              </label>
              <label>
                {t("settings.chatTextSize")}
                <select
                  value={chatTextSize}
                  onChange={(e) =>
                    handleChatTextSizeChange(e.target.value as NonNullable<AppPrefs["chatTextSize"]>)
                  }
                >
                  <option value="small">{t("settings.sizeSmall")}</option>
                  <option value="medium">{t("settings.sizeMedium")}</option>
                  <option value="large">{t("settings.sizeLarge")}</option>
                </select>
              </label>
              <label>
                {t("settings.language")}
                <select
                  value={languagePref}
                  onChange={(e) => handleLanguageChange(e.target.value as "auto" | Language)}
                >
                  <option value="auto">{t("settings.languageAuto")}</option>
                  <option value="en">{t("settings.languageEnglish")}</option>
                  <option value="es">{t("settings.languageSpanish")}</option>
                  <option value="de">{t("settings.languageGerman")}</option>
                </select>
              </label>
            </fieldset>

            <fieldset>
              <legend>{t("settings.chatBehavior")}</legend>
              <label>
                {t("settings.defaultModel")}
                <select
                  value={defaultModelId}
                  onChange={(e) => handleDefaultModelChange(e.target.value)}
                  disabled={models.length === 0}
                >
                  <option value="">{t("settings.defaultModelFirst")}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {models.length === 0 && (
                <p className="hint">Connect to Open WebUI (Account tab) to pick a default model.</p>
              )}
              <label>
                {t("settings.sendKey")}
                <select
                  value={sendKey}
                  onChange={(e) => handleSendKeyChange(e.target.value as NonNullable<AppPrefs["sendKey"]>)}
                >
                  <option value="enter">{t("settings.sendKeyEnter")}</option>
                  <option value="ctrl-enter">{t("settings.sendKeyCtrlEnter")}</option>
                </select>
              </label>
            </fieldset>

            <fieldset>
              <legend>{t("settings.speechToText")}</legend>
              <label>
                {t("settings.micBehavior")}
                <select
                  value={micMode}
                  onChange={(e) => handleMicModeChange(e.target.value as NonNullable<AppPrefs["micMode"]>)}
                >
                  <option value="toggle">{t("settings.micToggle")}</option>
                  <option value="push-to-talk">{t("settings.micPushToTalk")}</option>
                </select>
              </label>
            </fieldset>

            <fieldset>
              <legend>{t("settings.notifications")}</legend>
              <label className="row">
                <input
                  type="checkbox"
                  checked={notifyOnReply}
                  onChange={(e) => handleNotifyToggle(e.target.checked)}
                />
                {t("settings.notifyOnReply")}
              </label>
              {notifyWarning && <p className="status-error">{notifyWarning}</p>}
            </fieldset>
          </>
        )}

        {activeTab === "account" && (
          <>
            <div className="settings-form">
              <fieldset>
                <legend>{t("settings.profile")}</legend>
                {hasSession && displayName ? (
                  <>
                    <span className="hint">{t("settings.displayName")}</span>
                    <div>{displayName}</div>
                  </>
                ) : (
                  <label>
                    {t("settings.displayName")}
                    <input
                      type="text"
                      placeholder="Your name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onBlur={handleDisplayNameBlur}
                    />
                  </label>
                )}
                {saved && <span className="status-ok">{t("common.saved")}</span>}
                {saveError && <span className="status-error">Save failed: {saveError}</span>}
              </fieldset>

              <fieldset>
                <legend>{t("settings.connection")}</legend>
                {hasSession ? (
                  <>
                    <p className="hint">Signed in. Sign out to switch servers or accounts.</p>
                    <div className="connection-display">
                      <div>
                        <span className="hint">Server</span>
                        <div>{baseUrl}</div>
                      </div>
                      <div>
                        <span className="hint">API key</span>
                        <div>••••••••{apiKey.slice(-4)}</div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="hint">
                      Normally set via the sign-in screen. Edit here only to paste a static API key
                      instead of signing in (e.g. for SSO-only servers).
                    </p>
                    <label>
                      Server URL
                      <input
                        type="text"
                        placeholder="http://localhost:3000"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        onBlur={handleConnectionBlur}
                      />
                    </label>
                    <label>
                      API key
                      <input
                        type="password"
                        placeholder="sk-..."
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        onBlur={handleConnectionBlur}
                      />
                    </label>
                  </>
                )}
                <div className="row">
                  <button type="button" onClick={handleTestConnection} disabled={status === "testing"}>
                    {status === "testing" ? "Testing..." : t("settings.testConnection")}
                  </button>
                  {status === "ok" && <span className="status-ok">{statusMessage}</span>}
                  {status === "error" && <span className="status-error">{statusMessage}</span>}
                </div>
                <div className="row">
                  <button type="button" onClick={handleSignOut}>
                    {t("settings.signOut")}
                  </button>
                  {signOutError && <span className="status-error">Sign out failed: {signOutError}</span>}
                </div>
              </fieldset>
            </div>
          </>
        )}

        {activeTab === "system" && (
          <fieldset>
            <legend>{t("settings.system")}</legend>
            <label className="row">
              <input
                type="checkbox"
                checked={autostartEnabled}
                onChange={(e) => handleAutostartToggle(e.target.checked)}
              />
              {t("settings.runAtStartup")}
            </label>
            <p className="hint">{t("settings.runAtStartupHint")}</p>
            <label className="row">
              <input
                type="checkbox"
                checked={keepRunningInTray}
                onChange={(e) => handleKeepRunningInTrayChange(e.target.checked)}
              />
              {t("settings.keepRunningInTray")}
            </label>
            {systemError && <p className="status-error">{systemError}</p>}
          </fieldset>
        )}

        {activeTab === "privacy" && (
          <fieldset>
            <legend>{t("settings.data")}</legend>
            <p className="hint">Clears local chat history for the current account only.</p>
            <div className="row">
              <button type="button" onClick={handleClearHistory} disabled={clearingHistory}>
                {clearingHistory ? "Clearing..." : t("settings.clearHistory")}
              </button>
              {historyCleared && <span className="status-ok">Cleared</span>}
            </div>
            <div className="row">
              <button type="button" onClick={handleExportAll} disabled={exportingAll}>
                {exportingAll ? "Exporting..." : t("settings.exportAll")}
              </button>
              {exportAllStatus && <span className="status-ok">{exportAllStatus}</span>}
            </div>
            <p className="hint">
              {t("settings.dataLocation")}
              <br />
              <code>{dataDir ?? "..."}</code>
            </p>
            <div className="row">
              <button type="button" onClick={handleRepairChatDb} disabled={repairingDb}>
                {repairingDb ? "Repairing..." : "Repair local database"}
              </button>
              {dbRepaired && <span className="status-ok">Repaired — restarting...</span>}
            </div>
            <p className="hint">
              Only use this if the app is failing to load your chat history. It deletes all local
              chat history and restarts the app. It does not fix unreadable saved credentials —
              use the button below for that.
            </p>
            <div className="row">
              <button type="button" onClick={handleResetVault}>
                Reset saved credentials
              </button>
              {repairError && <span className="status-error">{repairError}</span>}
            </div>
            <div className="row">
              <button type="button" onClick={handleShowDataFolder} disabled={!dataDir}>
                {t("settings.showInFolder")}
              </button>
              <button type="button" onClick={handleCopyDataPath} disabled={!dataDir}>
                {pathCopied ? "Copied!" : t("settings.copyPath")}
              </button>
            </div>
          </fieldset>
        )}

        {loadError && <p className="status-error">Could not load saved settings: {loadError}</p>}
      </div>
    </div>
  );
}
