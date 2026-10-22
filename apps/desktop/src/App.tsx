import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateQuietly, knownUpdate } from "./lib/updateCheck";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ChatView from "./components/ChatView";
import HomeView from "./components/HomeView";
import LoginView from "./components/LoginView";
import SplashScreen from "./components/SplashScreen";
import SettingsView, { SettingsTab } from "./components/SettingsView";
import Sidebar, { View } from "./components/Sidebar";
import NotesView from "./components/NotesView";
import { getCurrentUser } from "./lib/openWebUiClient";
import { syncServerAvatar } from "./lib/serverAvatar";
import { syncWithServer } from "./lib/chatSync";
import { FOCUS_SEARCH_EVENT, shortcutFor } from "./lib/shortcuts";
import { setPrefill } from "./lib/prefill";
import type { ChatSettings } from "./lib/chatOptions";
import { useDesktopIntegration } from "./lib/useDesktopIntegration";
import { getAppPrefs, getOpenWebUiConfig, setAppPrefs } from "./lib/settingsStore";
import { consumeVaultResetNotice } from "./lib/secureStore";
import { applyChatTextSize, applyTheme } from "./lib/theme";
import { classifyAttachment, isRejected, PendingAttachment } from "./lib/attachments";
import { I18nProvider, Language, resolveLanguage, useTranslation } from "./lib/i18n";
import "highlight.js/styles/github-dark-dimmed.css";
import "./App.css";

function getInitialConversationId(): string | null {
  return new URLSearchParams(window.location.search).get("conversationId");
}

function App() {
  const initialConversationId = getInitialConversationId();
  const [view, setView] = useState<View>(initialConversationId ? "chat" : "home");
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null);
  const [pendingInitialModel, setPendingInitialModel] = useState<string | undefined>(undefined);
  const [pendingInitialKnowledgeIds, setPendingInitialKnowledgeIds] = useState<string[]>([]);
  const [pendingInitialSettings, setPendingInitialSettings] = useState<ChatSettings | undefined>(undefined);
  const [pendingInitialAttachments, setPendingInitialAttachments] = useState<PendingAttachment[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  // Whether the last sync could reach Open WebUI, and when one last succeeded.
  const [online, setOnline] = useState(true);
  // Version of a newer release found by the background check.
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null);
  // Bumped to remount the home view, so its composer takes pending prefill text.
  const [homeKey, setHomeKey] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  // Folder a "new chat here" was started from; the chat created next is filed in it.
  const [newChatFolder, setNewChatFolder] = useState<{ id: string; name: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [language, setLanguage] = useState<Language>("en");
  const [bootNotice, setBootNotice] = useState<string | null>(null);

  useEffect(() => {
    getAppPrefs().then((prefs) => {
      applyTheme(prefs?.theme ?? "light");
      applyChatTextSize(prefs?.chatTextSize ?? "medium");
      invoke("set_keep_running_in_tray", { enabled: prefs?.keepRunningInTray ?? true });
    });
  }, []);

  useEffect(() => {
    getOpenWebUiConfig()
      .then(async (config) => {
        const isSignedIn = !!(config?.baseUrl && config?.apiKey);
        setSignedIn(isSignedIn);
        const prefs = await getAppPrefs();
        let detectedLanguage: string | null = null;
        if (isSignedIn && config) {
          try {
            const user = await getCurrentUser(config.baseUrl, config.apiKey);
            if (user.name) await setAppPrefs({ displayName: user.name });
            detectedLanguage = user.detectedLanguage;
            // Not awaited: the sidebar picks the image up when it lands.
            syncServerAvatar(config.baseUrl, config.apiKey, user).then((changed) => {
              if (changed) setSidebarRefreshKey((k) => k + 1);
            });
          } catch {
            // Non-fatal — keeps whatever displayName was already stored.
          }
        }
        setLanguage(resolveLanguage(prefs?.language, detectedLanguage));
      })
      .catch((err) => {
        setBootNotice(
          `Could not load saved settings: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        // The vault may have been reset while loading the config above; tell
        // the user on the screen they land on (login) why they were signed out.
        if (consumeVaultResetNotice()) {
          setBootNotice(
            "Your stored credentials were unreadable and have been reset — please sign in again.",
          );
        }
        setCheckingAuth(false);
      });
  }, []);

  // Folders and chats are reconciled with Open WebUI right after sign-in, then
  // whenever the window regains focus and once a minute while it is visible.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const sync = () => {
      syncWithServer().then(({ changed, reachable }) => {
        if (cancelled) return;
        setOnline(reachable);
        if (reachable) setLastSyncAt(Date.now());
        if (changed) setSidebarRefreshKey((k) => k + 1);
      });
    };
    sync();
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") sync();
    }, 60_000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [signedIn]);

  // Keyboard shortcuts (Ctrl/Cmd + N new chat, K search, comma settings).
  useEffect(() => {
    if (!signedIn) return;
    function onKeyDown(e: KeyboardEvent) {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action === "new-chat") handleNewChat();
      else if (action === "settings") setView("settings");
      else window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // handleNewChat only sets state, so the first closure is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // A version found earlier shows at once at start; a quiet look for a new one
  // follows shortly after and then every few hours (the check itself only goes
  // out once a day). The user is told once per version; the sidebar keeps
  // showing it until the app is updated.
  useEffect(() => {
    if (!signedIn || getCurrentWindow().label !== "main") return;
    let cancelled = false;
    getVersion()
      .then(knownUpdate)
      .then((known) => {
        if (!cancelled && known) setAvailableUpdate(known);
      })
      .catch(() => {});
    async function look() {
      const found = await checkForUpdateQuietly();
      if (cancelled || !found) return;
      setAvailableUpdate(found.version);
      if (found.isNew) {
        try {
          if (await isPermissionGranted()) {
            sendNotification({ title: "Open DesktopUI", body: `Version ${found.version} is available (Settings → About).` });
          }
        } catch {
          // a missing notification is not worth an error
        }
      }
    }
    const first = window.setTimeout(look, 3_000);
    const again = window.setInterval(look, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, [signedIn]);

  // Global quick-chat shortcut, opendesktopui:// links and requests from other windows.
  useDesktopIntegration({
    enabled: signedIn,
    onOpenConversation: (id) => handleSelectConversation(id),
    onNewChat: (text) => {
      setPrefill(text);
      handleNewChat();
      setHomeKey((k) => k + 1); // a fresh composer picks the text up
    },
    onConversationsChanged: () => handleConversationActivity(),
    onNotice: setAttachmentError,
  });

  // A new message moves its chat to "Today" at once; the push to the server follows.
  function handleConversationActivity() {
    setSidebarRefreshKey((k) => k + 1);
    syncWithServer().then(({ changed, reachable }) => {
      setOnline(reachable);
      if (reachable) setLastSyncAt(Date.now());
      if (changed) setSidebarRefreshKey((k) => k + 1);
    });
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          if (viewRef.current === "home" || viewRef.current === "chat") setDragOver(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        if (event.payload.type !== "drop") return;
        setDragOver(false);
        if (viewRef.current !== "home" && viewRef.current !== "chat") return;
        const results = event.payload.paths.map(classifyAttachment);
        const accepted = results.filter((r): r is PendingAttachment => !isRejected(r));
        const rejected = results.filter(isRejected);
        if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
        if (rejected.length) setAttachmentError(rejected.map((r) => r.rejected).join(" "));
      });
      // If cleanup already ran by the time this promise resolves (React
      // StrictMode's throwaway first mount), unregister immediately instead
      // of leaking a second, permanently-active listener.
      if (cancelled) stop();
      else unlisten = stop;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function handleAddAttachments(newOnes: PendingAttachment[]) {
    setAttachments((prev) => [...prev, ...newOnes]);
  }

  function handleRemoveAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // Notes sit in a panel next to the chat window and are toggled; the chat (or
  // the home screen) underneath stays as it is. Settings has no chat beside it,
  // so opening settings puts the panel away.
  const [notesOpen, setNotesOpen] = useState(false);
  function handleSelectView(next: View) {
    if (next === "notes") {
      setNotesOpen((open) => !open);
      return;
    }
    if (next === "settings") setNotesOpen(false);
    setView(next);
  }

  function handleNewChat() {
    setConversationId(null);
    setAttachments([]);
    setNewChatFolder(null);
    setView("home");
  }

  function handleNewChatInFolder(folder: { id: string; name: string }) {
    setConversationId(null);
    setAttachments([]);
    setNewChatFolder(folder);
    setView("home");
  }

  function handleStartChatFromHome(
    text: string,
    model: string,
    knowledgeIds: string[],
    startAttachments: PendingAttachment[],
    settings: ChatSettings,
  ) {
    setConversationId(null);
    setPendingInitialSettings(settings);
    setPendingInitialMessage(text);
    setPendingInitialModel(model);
    setPendingInitialKnowledgeIds(knowledgeIds);
    setPendingInitialAttachments(startAttachments);
    setAttachments([]);
    setView("chat");
  }

  function handleSelectConversation(id: string) {
    setConversationId(id);
    setView("chat");
  }

  function handleConversationCreated(id: string) {
    setConversationId(id);
    setNewChatFolder(null);
    setSidebarRefreshKey((k) => k + 1);
  }

  if (checkingAuth) {
    return <SplashScreen />;
  }

  if (!signedIn) {
    return <LoginView notice={bootNotice} onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <I18nProvider language={language}>
    <div className="app-shell">
      {dragOver && (view === "home" || view === "chat") && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-message">Drop to attach</div>
        </div>
      )}
      <Sidebar
        view={view}
        activeConversationId={conversationId}
        onNewChat={handleNewChat}
        onNewChatInFolder={handleNewChatInFolder}
        onSelectConversation={handleSelectConversation}
        notesOpen={notesOpen}
        onSelectView={handleSelectView}
        refreshKey={sidebarRefreshKey}
        online={online}
        lastSyncAt={lastSyncAt}
        updateVersion={availableUpdate}
        onShowUpdate={() => {
          setSettingsTab("about");
          setView("settings");
        }}
      />
      <main className="content">
        {attachmentError && (
          <p className="status-error attachment-error">
            {attachmentError}
            <button type="button" className="dismiss-error" onClick={() => setAttachmentError(null)}>
              ×
            </button>
          </p>
        )}
        {view === "home" && newChatFolder && <FolderChatHint name={newChatFolder.name} />}
        {view === "home" && (
          <HomeView
            key={homeKey}
            onSend={handleStartChatFromHome}
            attachments={attachments}
            onAddAttachments={handleAddAttachments}
            onRemoveAttachment={handleRemoveAttachment}
            onAttachmentError={setAttachmentError}
          />
        )}
        {view === "chat" && (
          <ChatView
            conversationId={conversationId}
            onConversationCreated={handleConversationCreated}
            onConversationActivity={handleConversationActivity}
            onChatRead={() => setSidebarRefreshKey((k) => k + 1)}
            initialMessage={pendingInitialMessage}
            onInitialMessageConsumed={() => setPendingInitialMessage(null)}
            initialModel={pendingInitialModel}
            initialGroupId={newChatFolder?.id ?? null}
            initialKnowledgeIds={pendingInitialKnowledgeIds}
            initialSettings={pendingInitialSettings}
            initialAttachments={pendingInitialAttachments}
            onInitialAttachmentsConsumed={() => setPendingInitialAttachments([])}
            attachments={attachments}
            onAddAttachments={handleAddAttachments}
            onRemoveAttachment={handleRemoveAttachment}
            onAttachmentError={setAttachmentError}
            onClearAttachments={() => setAttachments([])}
          />
        )}
        {view === "settings" && (
          <SettingsView
            activeTab={settingsTab}
            onTabChange={setSettingsTab}
            language={language}
            onLanguageChange={setLanguage}
            onProfileChanged={() => setSidebarRefreshKey((k) => k + 1)}
          />
        )}
      </main>
      {notesOpen && view !== "settings" && (
        <aside className="notes-panel">
          <NotesView onClose={() => setNotesOpen(false)} />
        </aside>
      )}
    </div>
    </I18nProvider>
  );
}

function FolderChatHint({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <p className="hint folder-chat-hint">
      {t("folders.newChatIn")}: <strong>{name}</strong>
    </p>
  );
}

export default App;
