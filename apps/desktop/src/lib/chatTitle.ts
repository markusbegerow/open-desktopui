// Titles for new chats. A chat starts out titled with the beginning of its
// first message; after the first reply the server's own title generation (the
// one the web UI uses) gives it a proper one, so both places show the same title.
import { getConversation, getMessages } from "./chatHistory";
import { renameChat } from "./chatSync";
import { getSession } from "./folderSync";
import * as api from "./openWebUiClient";
import { getAppPrefs } from "./settingsStore";

const AUTO_TITLE_LENGTH = 48;

// The placeholder title: the start of the first message.
export function autoTitle(text: string): string {
  return text.length > AUTO_TITLE_LENGTH ? `${text.slice(0, AUTO_TITLE_LENGTH)}…` : text;
}

// Asks the server for a title for the chat's first exchange and applies it
// (renaming on the server too). Never throws; returns whether the title changed.
// A server with title generation switched off leaves the placeholder.
export async function generateChatTitle(conversationId: string): Promise<boolean> {
  try {
    if ((await getAppPrefs())?.aiTitles === false) return false;
    const session = await getSession();
    if (!session) return false;
    const conversation = await getConversation(conversationId);
    if (!conversation?.model) return false;

    const exchange = (await getMessages(conversationId))
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(0, 2)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    if (exchange.length < 2) return false;

    const title = await api.generateTitle(
      session.baseUrl,
      session.token,
      conversation.model,
      exchange,
      conversation.openwebui_chat_id,
    );
    if (!title) return false;

    // Read again: syncing may have given the chat a server id while the model was thinking.
    const current = await getConversation(conversationId);
    if (!current || current.title === title) return false;
    return (await renameChat(current, title)).synced;
  } catch {
    return false;
  }
}
