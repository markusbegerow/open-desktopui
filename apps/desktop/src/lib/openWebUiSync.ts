// Shared logic for pushing a locally-stored conversation into the user's
// Open WebUI account as a real chat — used by both the sidebar's "Open in
// Open WebUI"/"Share Link" actions and the per-message vote buttons (voting
// needs a real chat_id/message_id pair on the server, so it shares this same
// "ensure it's been shared" step).
import type { Conversation } from "./chatHistory";
import { getMessages, setConversationOpenWebUiChatId, setMessageOpenWebUiId } from "./chatHistory";
import { createOpenWebUiChat } from "./openWebUiClient";
import { getOpenWebUiConfig } from "./settingsStore";

export interface SharedChat {
  chatId: string;
  url: string;
}

export async function ensureSharedChat(conversation: Conversation): Promise<SharedChat> {
  const config = await getOpenWebUiConfig();
  if (!config?.baseUrl) throw new Error("Configure your Open WebUI server in Settings first.");
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  if (conversation.openwebui_chat_id) {
    return { chatId: conversation.openwebui_chat_id, url: `${baseUrl}/c/${conversation.openwebui_chat_id}` };
  }

  const stored = await getMessages(conversation.id);
  if (stored.length === 0) throw new Error("This conversation has no messages yet.");

  const created = await createOpenWebUiChat(
    config.baseUrl,
    config.apiKey || undefined,
    conversation.title || "New conversation",
    conversation.model,
    stored.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
  );

  await setConversationOpenWebUiChatId(conversation.id, created.id);
  await Promise.all(
    stored.map((m, i) => (created.messageIds[i] ? setMessageOpenWebUiId(m.id, created.messageIds[i]) : null)),
  );

  return { chatId: created.id, url: `${baseUrl}/c/${created.id}` };
}
