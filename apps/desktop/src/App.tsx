import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ChatView from "./components/ChatView";
import HomeView from "./components/HomeView";
import LoginView from "./components/LoginView";
import SplashScreen from "./components/SplashScreen";
import SettingsView, { SettingsTab } from "./components/SettingsView";
import Sidebar, { View } from "./components/Sidebar";
import { getCurrentUser } from "./lib/openWebUiClient";
import { getAppPrefs, getOpenWebUiConfig, setAppPrefs } from "./lib/settingsStore";
import { applyChatTextSize, applyTheme } from "./lib/theme";
import { classifyAttachment, isRejected, PendingAttachment } from "./lib/attachments";
import { I18nProvider, Language, resolveLanguage } from "./lib/i18n";
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
  const [pendingInitialAttachments, setPendingInitialAttachments] = useState<PendingAttachment[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [language, setLanguage] = useState<Language>("en");

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
          } catch {
            // Non-fatal — keeps whatever displayName was already stored.
          }
        }
        setLanguage(resolveLanguage(prefs?.language, detectedLanguage));
      })
      .finally(() => setCheckingAuth(false));
  }, []);

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

  function handleNewChat() {
    setConversationId(null);
    setAttachments([]);
    setView("home");
  }

  function handleStartChatFromHome(
    text: string,
    model: string,
    knowledgeIds: string[],
    startAttachments: PendingAttachment[],
  ) {
    setConversationId(null);
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
    setSidebarRefreshKey((k) => k + 1);
  }

  if (checkingAuth) {
    return <SplashScreen />;
  }

  if (!signedIn) {
    return <LoginView onSignedIn={() => setSignedIn(true)} />;
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
        onSelectConversation={handleSelectConversation}
        onSelectView={setView}
        refreshKey={sidebarRefreshKey}
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
        {view === "home" && (
          <HomeView
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
            initialMessage={pendingInitialMessage}
            onInitialMessageConsumed={() => setPendingInitialMessage(null)}
            initialModel={pendingInitialModel}
            initialKnowledgeIds={pendingInitialKnowledgeIds}
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
          />
        )}
      </main>
    </div>
    </I18nProvider>
  );
}

export default App;
