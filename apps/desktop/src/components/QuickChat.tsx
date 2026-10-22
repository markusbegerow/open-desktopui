import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ChatView from "./ChatView";
import type { PendingAttachment } from "../lib/attachments";
import { I18nProvider, Language, resolveLanguage, useTranslation } from "../lib/i18n";
import { getAppPrefs, getOpenWebUiConfig } from "../lib/settingsStore";
import { applyChatTextSize, applyTheme } from "../lib/theme";
import "highlight.js/styles/github-dark-dimmed.css";
import "../App.css";

// The small window the global shortcut opens: one chat, no sidebar. Esc closes
// it; "Open in main window" hands the conversation over.
export default function QuickChat() {
  const [language, setLanguage] = useState<Language>("en");
  const [state, setState] = useState<"loading" | "ready" | "signed-out">("loading");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const prefs = await getAppPrefs();
      applyTheme(prefs?.theme ?? "light");
      applyChatTextSize(prefs?.chatTextSize ?? "medium");
      setLanguage(resolveLanguage(prefs?.language, null));
      const config = await getOpenWebUiConfig();
      setState(config?.baseUrl && config.apiKey ? "ready" : "signed-out");
    })().catch(() => setState("signed-out"));
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") void getCurrentWindow().close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <I18nProvider language={language}>
      <div className="quick-shell">
        {state === "ready" ? (
          <>
            <QuickHeader
              canOpen={conversationId !== null}
              onOpen={() => {
                if (!conversationId) return;
                invoke("open_in_main_window", { conversationId }).catch((err) => setError(String(err)));
              }}
            />
            {error && <p className="status-error">{error}</p>}
            <ChatView
              conversationId={conversationId}
              onConversationCreated={setConversationId}
              // The main window syncs and reloads its list when told about the change.
              onConversationActivity={() => void emitTo("main", "conversations-changed")}
              attachments={attachments}
              onAddAttachments={(added) => setAttachments((prev) => [...prev, ...added])}
              onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
              onAttachmentError={setError}
              onClearAttachments={() => setAttachments([])}
            />
          </>
        ) : state === "signed-out" ? (
          <p className="hint quick-note">Sign in to Open DesktopUI first, then use the shortcut again.</p>
        ) : null}
      </div>
    </I18nProvider>
  );
}

function QuickHeader({ canOpen, onOpen }: { canOpen: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="quick-header">
      <span className="quick-title">{t("quick.title")}</span>
      <button type="button" disabled={!canOpen} onClick={onOpen}>
        {t("quick.openInMain")}
      </button>
    </div>
  );
}
