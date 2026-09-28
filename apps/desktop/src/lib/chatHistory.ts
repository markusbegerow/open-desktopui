// Local conversation persistence via tauri-plugin-sql (SQLite). Schema is
// defined as a Rust-side migration in `src-tauri/src/lib.rs` (`chat.db`).
//
// Scoped per Open WebUI account (Addendum 9): every read/write here resolves
// the *current* account's id internally, so switching accounts never mixes
// history/dashboard stats, and signing back into the same account restores
// everything. The no-login ("Skip for now") path falls back to a fixed
// "unscoped" bucket, kept internally consistent but separate from any real
// account.
import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage } from "./openWebUiClient";
import type { PendingAttachment } from "./attachments";
import { getOpenWebUiConfig } from "./settingsStore";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:chat.db").catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function currentAccountId(): Promise<string> {
  const config = await getOpenWebUiConfig();
  return config?.accountId ?? "unscoped";
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: number;
  knowledge_ids: string | null; // JSON-encoded string[]; SQLite has no array type
  account_id: string | null;
  pinned: number; // SQLite has no boolean type; 0/1
  unread: number; // personal bookmark/reminder flag, not real unread-tracking (single-user app)
  archived: number;
  group_id: string | null;
  openwebui_chat_id: string | null;
}

export interface Group {
  id: string;
  name: string;
  account_id: string | null;
  created_at: number;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  tokens: number | null;
  attachments: string | null; // JSON-encoded StoredAttachment[]
  vote: number | null; // -1, 0, or 1 — thumbs down/none/up feedback sent to Open WebUI
  openwebui_message_id: string | null; // set once this message's conversation has been shared
}

export interface StoredAttachment {
  filename: string;
  openWebUiFileId: string;
  mimeType: string;
}

function newId(): string {
  return crypto.randomUUID();
}

export async function createConversation(
  model: string,
  title: string,
  knowledgeIds: string[] = [],
): Promise<Conversation> {
  const db = await getDb();
  const conversation: Conversation = {
    id: newId(),
    title,
    model,
    created_at: Date.now(),
    knowledge_ids: knowledgeIds.length > 0 ? JSON.stringify(knowledgeIds) : null,
    account_id: await currentAccountId(),
    pinned: 0,
    unread: 0,
    archived: 0,
    group_id: null,
    openwebui_chat_id: null,
  };
  await db.execute(
    "INSERT INTO conversations (id, title, model, created_at, knowledge_ids, account_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      conversation.id,
      conversation.title,
      conversation.model,
      conversation.created_at,
      conversation.knowledge_ids,
      conversation.account_id,
    ],
  );
  return conversation;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET title = $1 WHERE id = $2", [title, id]);
}

export async function setConversationKnowledge(id: string, knowledgeIds: string[]): Promise<void> {
  const db = await getDb();
  const value = knowledgeIds.length > 0 ? JSON.stringify(knowledgeIds) : null;
  await db.execute("UPDATE conversations SET knowledge_ids = $1 WHERE id = $2", [value, id]);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE conversation_id = $1", [id]);
  await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

export async function setConversationPinned(id: string, pinned: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET pinned = $1 WHERE id = $2", [pinned ? 1 : 0, id]);
}

export async function setConversationUnread(id: string, unread: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET unread = $1 WHERE id = $2", [unread ? 1 : 0, id]);
}

export async function setConversationArchived(id: string, archived: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET archived = $1 WHERE id = $2", [archived ? 1 : 0, id]);
}

export async function setConversationGroup(id: string, groupId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET group_id = $1 WHERE id = $2", [groupId, id]);
}

export async function setConversationOpenWebUiChatId(id: string, chatId: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET openwebui_chat_id = $1 WHERE id = $2", [chatId, id]);
}

export async function listGroups(): Promise<Group[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  return db.select<Group[]>(
    "SELECT * FROM groups WHERE account_id = $1 ORDER BY created_at ASC",
    [accountId],
  );
}

export async function createGroup(name: string): Promise<Group> {
  const db = await getDb();
  const group: Group = {
    id: newId(),
    name,
    account_id: await currentAccountId(),
    created_at: Date.now(),
  };
  await db.execute(
    "INSERT INTO groups (id, name, account_id, created_at) VALUES ($1, $2, $3, $4)",
    [group.id, group.name, group.account_id, group.created_at],
  );
  return group;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET name = $1 WHERE id = $2", [name, id]);
}

export async function deleteGroup(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET group_id = NULL WHERE group_id = $1", [id]);
  await db.execute("DELETE FROM groups WHERE id = $1", [id]);
}

export function parseKnowledgeIds(conversation: Pick<Conversation, "knowledge_ids">): string[] {
  if (!conversation.knowledge_ids) return [];
  try {
    return JSON.parse(conversation.knowledge_ids);
  } catch {
    return [];
  }
}

export function parseAttachments(message: Pick<StoredMessage, "attachments">): StoredAttachment[] {
  if (!message.attachments) return [];
  try {
    return JSON.parse(message.attachments);
  } catch {
    return [];
  }
}

export async function listConversations(limit = 50): Promise<Conversation[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  return db.select<Conversation[]>(
    "SELECT * FROM conversations WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2",
    [accountId, limit],
  );
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.select<Conversation[]>("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getLatestConversation(): Promise<Conversation | null> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const rows = await db.select<Conversation[]>(
    "SELECT * FROM conversations WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
    [accountId],
  );
  return rows[0] ?? null;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  return db.select<StoredMessage[]>(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [conversationId],
  );
}

export async function addMessage(
  conversationId: string,
  message: ChatMessage,
  tokens?: number,
  attachments?: PendingAttachment[],
): Promise<StoredMessage> {
  const db = await getDb();
  const attachmentsJson = attachments?.length
    ? JSON.stringify(
        attachments.map((a) => ({
          filename: a.filename,
          openWebUiFileId: a.uploadedId,
          mimeType: a.mimeType,
        })),
      )
    : null;
  const stored: StoredMessage = {
    id: newId(),
    conversation_id: conversationId,
    role: message.role,
    content: message.content,
    created_at: Date.now(),
    tokens: tokens ?? null,
    attachments: attachmentsJson,
    vote: null,
    openwebui_message_id: null,
  };
  await db.execute(
    "INSERT INTO messages (id, conversation_id, role, content, created_at, tokens, attachments) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      stored.id,
      stored.conversation_id,
      stored.role,
      stored.content,
      stored.created_at,
      stored.tokens,
      stored.attachments,
    ],
  );
  return stored;
}

export async function updateMessageTokens(id: string, tokens: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET tokens = $1 WHERE id = $2", [tokens, id]);
}

export async function updateMessageContent(id: string, content: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET content = $1 WHERE id = $2", [content, id]);
}

export async function updateMessageVote(id: string, vote: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET vote = $1 WHERE id = $2", [vote, id]);
}

export async function setMessageOpenWebUiId(id: string, openWebUiMessageId: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET openwebui_message_id = $1 WHERE id = $2", [
    openWebUiMessageId,
    id,
  ]);
}

// Drops a message and everything after it (by timestamp) — used to discard
// a stale assistant reply before regenerating it, or everything after an
// edited message before resending from that point.
export async function deleteMessagesFrom(conversationId: string, fromCreatedAt: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE conversation_id = $1 AND created_at >= $2", [
    conversationId,
    fromCreatedAt,
  ]);
}

export interface HistoryStats {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  peakHour: number | null;
  favoriteModel: string | null;
}

export async function getStats(): Promise<HistoryStats> {
  const db = await getDb();
  const accountId = await currentAccountId();

  const [{ sessions }] = await db.select<{ sessions: number }[]>(
    "SELECT COUNT(*) as sessions FROM conversations WHERE account_id = $1",
    [accountId],
  );
  const [{ messages }] = await db.select<{ messages: number }[]>(
    `SELECT COUNT(*) as messages FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1`,
    [accountId],
  );
  const [{ totalTokens }] = await db.select<{ totalTokens: number | null }[]>(
    `SELECT SUM(m.tokens) as totalTokens FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1`,
    [accountId],
  );
  const [{ activeDays }] = await db.select<{ activeDays: number }[]>(
    `SELECT COUNT(DISTINCT date(m.created_at / 1000, 'unixepoch')) as activeDays FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1`,
    [accountId],
  );
  const peakHourRows = await db.select<{ hour: string; c: number }[]>(
    `SELECT strftime('%H', m.created_at / 1000, 'unixepoch') as hour, COUNT(*) as c FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1
     GROUP BY hour ORDER BY c DESC LIMIT 1`,
    [accountId],
  );
  const favoriteModelRows = await db.select<{ model: string; c: number }[]>(
    "SELECT model, COUNT(*) as c FROM conversations WHERE account_id = $1 GROUP BY model ORDER BY c DESC LIMIT 1",
    [accountId],
  );

  return {
    sessions,
    messages,
    totalTokens: totalTokens ?? 0,
    activeDays,
    peakHour: peakHourRows[0] ? parseInt(peakHourRows[0].hour, 10) : null,
    favoriteModel: favoriteModelRows[0]?.model ?? null,
  };
}

export interface DailyActivity {
  day: string; // YYYY-MM-DD
  count: number;
  tokens: number;
}

// Clears only the *current* account's conversations/messages — never
// touches other accounts' scoped data (Addendum 9/10).
export async function clearHistory(): Promise<void> {
  const db = await getDb();
  const accountId = await currentAccountId();
  await db.execute(
    "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE account_id = $1)",
    [accountId],
  );
  await db.execute("DELETE FROM conversations WHERE account_id = $1", [accountId]);
}

export async function getDailyActivity(days?: number): Promise<DailyActivity[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const base = `SELECT date(m.created_at / 1000, 'unixepoch') as day, COUNT(*) as count,
                       COALESCE(SUM(m.tokens), 0) as tokens
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.account_id = $1`;
  if (days === undefined) {
    return db.select<DailyActivity[]>(`${base} GROUP BY day ORDER BY day ASC`, [accountId]);
  }
  return db.select<DailyActivity[]>(
    `${base} AND m.created_at >= $2 GROUP BY day ORDER BY day ASC`,
    [accountId, Date.now() - days * 24 * 60 * 60 * 1000],
  );
}

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  messageCount: number;
}

export async function getModelBreakdown(days?: number): Promise<ModelUsage[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const base = `SELECT c.model as model,
                       COALESCE(SUM(CASE WHEN m.role = 'user' THEN m.tokens ELSE 0 END), 0) as promptTokens,
                       COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.tokens ELSE 0 END), 0) as completionTokens,
                       COUNT(*) as messageCount
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.account_id = $1`;
  if (days === undefined) {
    return db.select<ModelUsage[]>(
      `${base} GROUP BY c.model ORDER BY (promptTokens + completionTokens) DESC`,
      [accountId],
    );
  }
  return db.select<ModelUsage[]>(
    `${base} AND m.created_at >= $2 GROUP BY c.model ORDER BY (promptTokens + completionTokens) DESC`,
    [accountId, Date.now() - days * 24 * 60 * 60 * 1000],
  );
}
