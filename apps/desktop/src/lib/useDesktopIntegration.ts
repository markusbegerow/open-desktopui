// Things only the main window does for the desktop: the global quick-chat
// shortcut, opendesktopui:// links, and "open this conversation" requests from
// other windows. (Every window runs this bundle, but a shortcut or a link must
// be handled exactly once.)
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { findConversationByAnyId } from "./chatHistory";
import { syncWithServer } from "./chatSync";
import { parseDeepLink } from "./deepLink";
import { applyQuickChatShortcut, configuredShortcut } from "./quickChatShortcut";
import { getAppPrefs } from "./settingsStore";

export interface DesktopIntegrationOptions {
  enabled: boolean;
  onOpenConversation: (id: string) => void;
  onNewChat: (text: string) => void;
  // A conversation was created or changed in another window.
  onConversationsChanged: () => void;
  onNotice: (message: string) => void;
}

export function useDesktopIntegration(options: DesktopIntegrationOptions) {
  // Handlers change with every render; the listeners below are set up once.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.enabled || getCurrentWindow().label !== "main") return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const keep = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    };

    getAppPrefs()
      .then((prefs) => applyQuickChatShortcut(configuredShortcut(prefs?.quickChatShortcut)))
      .catch((err) => {
        latest.current.onNotice(
          `The quick chat shortcut couldn't be registered (another app may use it): ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    async function handleLinks(urls: string[]) {
      for (const raw of urls) {
        const link = parseDeepLink(raw);
        if (!link) continue;
        if (link.kind === "new") {
          latest.current.onNewChat(link.text);
          continue;
        }
        // Not cloned yet (a chat made minutes ago on another device): sync once and look again.
        let conversation = await findConversationByAnyId(link.id);
        if (!conversation) {
          await syncWithServer().catch(() => undefined);
          conversation = await findConversationByAnyId(link.id);
        }
        if (conversation) latest.current.onOpenConversation(conversation.id);
        else latest.current.onNotice(`That chat link doesn't match any of your chats (${link.id}).`);
      }
    }

    getCurrent()
      .then((urls) => {
        if (urls && !cancelled) void handleLinks(urls);
      })
      .catch(() => undefined);
    onOpenUrl((urls) => void handleLinks(urls)).then(keep).catch(() => undefined);
    listen<string>("open-conversation", (e) => latest.current.onOpenConversation(e.payload))
      .then(keep)
      .catch(() => undefined);
    listen("conversations-changed", () => latest.current.onConversationsChanged())
      .then(keep)
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [options.enabled]);
}
