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
import { splitThinking } from "./reasoning";
import {
  ChatSettings,
  normalizeParams,
  parseFeatures,
  parseParams,
  serializeFeatures,
  serializeParams,
} from "./chatOptions";
import type { ChatParams } from "./openWebUiClient";

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:chat.db").catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// Closes the SQLite pool so the OS releases `chat.db` (Windows refuses to
// rename a file that's still open) — used before the "Repair local database"
// reset moves it aside. Best-effort: a database too corrupted to even open
// has nothing to close.
export async function closeChatDb(): Promise<void> {
  // Detach the handle first so a concurrent `getDb()` opens a fresh pool
  // instead of receiving the one being closed.
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return; // never opened, so nothing holds the file
  let db: Database;
  try {
    db = await pending;
  } catch {
    return; // the pool never opened, so nothing holds the file
  }
  // A real close failure must surface: the caller is about to move the file.
  await db.close();
}

export async function currentAccountId(): Promise<string> {
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
  // 1 = shown with the unread dot. Derived from the server's `last_read_at` by
  // the sync; it stays read until the server's `updated_at` passes `unread_ack_at`.
  unread: number;
  archived: number;
  group_id: string | null;
  openwebui_chat_id: string | null;
  // Last activity (ms) — what the sidebar's time groups use. Null only for rows
  // from before migration 10 that had no messages to derive it from.
  updated_at: number | null;
  // 1 while a local change (title, messages, pin, archive) hasn't reached the
  // server yet; retried by the next `pullChats()`
  dirty: number;
  // 1 once deleted locally but the server delete still has to be retried
  deleted_pending: number;
  // The server's `updated_at` (ms) when this chat was last pulled
  server_updated_at: number | null;
  // 1 when the server has newer messages than the local copy
  messages_stale: number;
  // The server `updated_at` (ms) up to which the user has seen the chat here;
  // 0 after "mark as unread"
  unread_ack_at: number | null;
  // JSON of the chat's settings (system prompt, temperature …), synced as chat.params
  params: string | null;
  // JSON of the feature switches / tools for the next reply; stays on this device
  features: string | null;
}

// A folder in the sidebar. Mirrors Open WebUI's folder model (nesting, icon,
// system prompt, expanded state); `openwebui_folder_id` links it to the
// server's copy once synced. The table keeps its original name `groups`.
export interface Group {
  id: string;
  name: string;
  account_id: string | null;
  created_at: number;
  parent_id: string | null;
  icon: string | null;
  system_prompt: string | null;
  is_expanded: number; // 0/1
  openwebui_folder_id: string | null;
  updated_at: number | null;
  // 1 while a local change hasn't reached the server yet (retried on the next sync)
  dirty: number;
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
  feedback_id: string | null; // Open WebUI feedback record behind `vote`
  // The model's thinking, kept apart from `content` (the answer only)
  reasoning: string | null;
  reasoning_seconds: number | null;
  // JSON of the retrieved documents, as Open WebUI sends and stores them
  sources: string | null;
}

export interface MessageExtras {
  reasoning?: string;
  reasoningSeconds?: number;
  sources?: unknown[];
}

export function parseSources(message: Pick<StoredMessage, "sources">): unknown[] {
  if (!message.sources) return [];
  try {
    const parsed = JSON.parse(message.sources);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  groupId: string | null = null,
): Promise<Conversation> {
  const db = await getDb();
  const now = Date.now();
  const conversation: Conversation = {
    id: newId(),
    title,
    model,
    created_at: now,
    knowledge_ids: knowledgeIds.length > 0 ? JSON.stringify(knowledgeIds) : null,
    account_id: await currentAccountId(),
    pinned: 0,
    unread: 0,
    archived: 0,
    group_id: groupId,
    openwebui_chat_id: null,
    updated_at: now,
    dirty: 0,
    deleted_pending: 0,
    server_updated_at: null,
    messages_stale: 0,
    unread_ack_at: null,
    params: null,
    features: null,
  };
  await db.execute(
    "INSERT INTO conversations (id, title, model, created_at, knowledge_ids, account_id, group_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      conversation.id,
      conversation.title,
      conversation.model,
      conversation.created_at,
      conversation.knowledge_ids,
      conversation.account_id,
      conversation.group_id,
      conversation.updated_at,
    ],
  );
  return conversation;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3", [title, Date.now(), id]);
}

export async function setConversationDirty(id: string, dirty: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET dirty = $1 WHERE id = $2", [dirty ? 1 : 0, id]);
}

// Hides a conversation whose server copy couldn't be deleted yet; the next
// `pullChats()` retries the delete and then removes the row for good.
export async function markConversationDeletePending(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET deleted_pending = 1 WHERE id = $1", [id]);
}

// Every conversation of the current account including the ones awaiting a
// server delete — what the sync needs; the sidebar uses `listConversations`.
export async function listConversationsForSync(): Promise<Conversation[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  return db.select<Conversation[]>("SELECT * FROM conversations WHERE account_id = $1", [accountId]);
}

export interface ServerChatFields {
  title: string;
  updated_at: number;
  pinned?: boolean; // undefined = the server didn't say, keep the local value
  archived?: boolean;
  // undefined = unknown, keep the local folder; null = unfiled
  group_id?: string | null;
  unread?: boolean; // undefined = the server didn't say, keep the local value
}

// A conversation that so far only exists on the server. Its messages are
// fetched the first time it is opened (`messages_stale = 1`).
export async function createConversationFromServer(
  chatId: string,
  model: string,
  createdAt: number,
  fields: ServerChatFields,
): Promise<Conversation> {
  const db = await getDb();
  const conversation: Conversation = {
    id: newId(),
    title: fields.title,
    model,
    created_at: createdAt || fields.updated_at,
    knowledge_ids: null,
    account_id: await currentAccountId(),
    pinned: fields.pinned ? 1 : 0,
    unread: fields.unread ? 1 : 0,
    archived: fields.archived ? 1 : 0,
    group_id: fields.group_id ?? null,
    openwebui_chat_id: chatId,
    updated_at: fields.updated_at,
    dirty: 0,
    deleted_pending: 0,
    server_updated_at: fields.updated_at,
    messages_stale: 1,
    unread_ack_at: null,
    params: null,
    features: null,
  };
  await db.execute(
    `INSERT INTO conversations (id, title, model, created_at, knowledge_ids, account_id, pinned, archived, group_id,
                                openwebui_chat_id, updated_at, server_updated_at, messages_stale, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      conversation.id,
      conversation.title,
      conversation.model,
      conversation.created_at,
      conversation.knowledge_ids,
      conversation.account_id,
      conversation.pinned,
      conversation.archived,
      conversation.group_id,
      conversation.openwebui_chat_id,
      conversation.updated_at,
      conversation.server_updated_at,
      conversation.messages_stale,
      conversation.unread,
    ],
  );
  return conversation;
}

// Overwrites a conversation's synced fields with the server's (the pull in
// chatSync.ts); does not touch `dirty`. `stale` marks the messages for a refetch.
export async function applyServerChatFields(id: string, fields: ServerChatFields, stale: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE conversations SET title = $1, updated_at = $2, server_updated_at = $2, messages_stale = MAX(messages_stale, $3) WHERE id = $4",
    [fields.title, fields.updated_at, stale ? 1 : 0, id],
  );
  if (fields.pinned !== undefined) {
    await db.execute("UPDATE conversations SET pinned = $1 WHERE id = $2", [fields.pinned ? 1 : 0, id]);
  }
  if (fields.archived !== undefined) {
    await db.execute("UPDATE conversations SET archived = $1 WHERE id = $2", [fields.archived ? 1 : 0, id]);
  }
  if (fields.group_id !== undefined) {
    await db.execute("UPDATE conversations SET group_id = $1 WHERE id = $2", [fields.group_id, id]);
  }
  if (fields.unread !== undefined) {
    await db.execute("UPDATE conversations SET unread = $1 WHERE id = $2", [fields.unread ? 1 : 0, id]);
  }
}

// Records that the server now holds this conversation's current state. With
// `seen` the user is looking at this version (they just wrote it), so it
// doesn't count as unread.
export async function setConversationServerUpdatedAt(
  id: string,
  serverUpdatedAt: number,
  seen = false,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET server_updated_at = $1 WHERE id = $2", [serverUpdatedAt, id]);
  if (seen) {
    await db.execute("UPDATE conversations SET unread = 0, unread_ack_at = $1 WHERE id = $2", [serverUpdatedAt, id]);
  }
}

// The user has opened the chat: clears the unread dot and remembers up to which
// server version. Returns whether anything changed.
export async function acknowledgeConversation(id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<Conversation[]>("SELECT * FROM conversations WHERE id = $1", [id]);
  const c = rows[0];
  if (!c) return false;
  const seenAt = c.server_updated_at ?? c.updated_at ?? 0;
  if (!c.unread && (c.unread_ack_at ?? 0) >= seenAt) return false;
  await db.execute("UPDATE conversations SET unread = 0, unread_ack_at = $1 WHERE id = $2", [seenAt, id]);
  return true;
}

// "Mark as unread" after the server accepted it: unread until the user opens it again.
export async function markConversationUnread(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET unread = 1, unread_ack_at = 0 WHERE id = $1", [id]);
}

export interface ServerMessageRow {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  rating: number | null; // the server's thumbs (1 / -1); null = not rated
  feedbackId: string | null;
  files: { id: string; name: string; mime: string }[];
  sources?: unknown[] | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// The server doesn't always say what kind of file an attachment is.
export function guessMimeType(filename: string, given?: string): string {
  if (given) return given;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function attachmentsFromServer(files: ServerMessageRow["files"]): string | null {
  if (files.length === 0) return null;
  const stored: StoredAttachment[] = files.map((f) => ({
    filename: f.name,
    openWebUiFileId: f.id,
    mimeType: guessMimeType(f.name, f.mime),
  }));
  return JSON.stringify(stored);
}

// Brings a conversation's messages in line with the server's copy and clears
// the stale flag. Messages the server already knows by id keep their local row
// (tokens, attachments, vote); new ones are inserted tagged with their server
// message id, and local ones the server no longer has are dropped.
export async function replaceMessagesFromServer(
  conversationId: string,
  messages: ServerMessageRow[],
  model: string | null,
): Promise<void> {
  const db = await getDb();
  const existing = await db.select<StoredMessage[]>("SELECT * FROM messages WHERE conversation_id = $1", [
    conversationId,
  ]);
  const byServerId = new Map(existing.filter((m) => m.openwebui_message_id).map((m) => [m.openwebui_message_id!, m]));
  const keep = new Set<string>();
  let last = 0;
  for (const m of messages) {
    // Keep created_at strictly increasing: `getMessages` orders by it.
    last = Math.max(m.timestamp || 0, last + 1);
    const match = byServerId.get(m.id);
    // The server decides rating and attachments; without any it leaves a local
    // attachment list alone (the app's own uploads reach the server with the next push).
    const serverAttachments = attachmentsFromServer(m.files);
    // The server keeps the thinking inside the text; here it is a field of its own.
    const split = splitThinking(m.content);
    const reasoning = split.reasoning || null;
    const serverSources = m.sources?.length ? JSON.stringify(m.sources) : null;
    if (match) {
      keep.add(match.id);
      if (match.content !== split.content || match.role !== m.role || (match.reasoning ?? null) !== reasoning) {
        await db.execute(
          "UPDATE messages SET content = $1, role = $2, reasoning = $3, reasoning_seconds = $4 WHERE id = $5",
          [split.content, m.role, reasoning, reasoning ? (split.seconds ?? match.reasoning_seconds ?? null) : null, match.id],
        );
      }
      if (serverSources && serverSources !== match.sources) {
        await db.execute("UPDATE messages SET sources = $1 WHERE id = $2", [serverSources, match.id]);
      }
      if ((match.vote ?? null) !== m.rating || (match.feedback_id ?? null) !== m.feedbackId) {
        await db.execute("UPDATE messages SET vote = $1, feedback_id = $2 WHERE id = $3", [
          m.rating,
          m.feedbackId,
          match.id,
        ]);
      }
      if (serverAttachments && serverAttachments !== match.attachments) {
        await db.execute("UPDATE messages SET attachments = $1 WHERE id = $2", [serverAttachments, match.id]);
      }
      last = Math.max(last, match.created_at);
      continue;
    }
    const id = newId();
    keep.add(id);
    await db.execute(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, openwebui_message_id, vote, feedback_id, attachments,
                             reasoning, reasoning_seconds, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        conversationId,
        m.role,
        split.content,
        last,
        m.id,
        m.rating,
        m.feedbackId,
        serverAttachments,
        reasoning,
        reasoning ? (split.seconds ?? null) : null,
        serverSources,
      ],
    );
  }
  for (const m of existing) {
    if (!keep.has(m.id)) await db.execute("DELETE FROM messages WHERE id = $1", [m.id]);
  }
  await db.execute("UPDATE conversations SET messages_stale = 0 WHERE id = $1", [conversationId]);
  if (model) await db.execute("UPDATE conversations SET model = $1 WHERE id = $2", [model, conversationId]);
}

// A chat's settings. The sampling parameters and system prompt are part of the
// server chat, so a change on a chat that exists there is queued for the next
// push; the feature switches only matter on this device.
export async function setChatSettings(id: string, settings: ChatSettings): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET params = $1, features = $2 WHERE id = $3", [
    serializeParams(settings.params),
    serializeFeatures(settings.features),
    id,
  ]);
  await db.execute("UPDATE conversations SET dirty = 1 WHERE id = $1 AND openwebui_chat_id IS NOT NULL", [id]);
}

export function chatSettingsOf(conversation: Pick<Conversation, "params" | "features">): ChatSettings {
  return { params: parseParams(conversation.params), features: parseFeatures(conversation.features) };
}

// The server's settings for a chat (the pull); the feature switches are left alone.
export async function setConversationParamsFromServer(id: string, params: ChatParams): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET params = $1 WHERE id = $2", [serializeParams(normalizeParams(params)), id]);
}

export async function setConversationKnowledge(id: string, knowledgeIds: string[]): Promise<void> {
  const db = await getDb();
  const value = knowledgeIds.length > 0 ? JSON.stringify(knowledgeIds) : null;
  await db.execute("UPDATE conversations SET knowledge_ids = $1 WHERE id = $2", [value, id]);
  // On the server the knowledge bases live in the chat itself: queue the change.
  await db.execute("UPDATE conversations SET dirty = 1 WHERE id = $1 AND openwebui_chat_id IS NOT NULL", [id]);
}

// The server's knowledge bases for a chat (the pull); does not queue a push.
export async function setConversationKnowledgeFromServer(id: string, knowledgeIds: string[]): Promise<void> {
  const db = await getDb();
  const value = knowledgeIds.length > 0 ? JSON.stringify(knowledgeIds) : null;
  await db.execute("UPDATE conversations SET knowledge_ids = $1 WHERE id = $2", [value, id]);
}

// Tags are kept as Open WebUI's tag ids: lower-case, underscores for spaces.
export function tagId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

export function tagLabel(id: string): string {
  return id.replace(/_/g, " ");
}

export async function listConversationTags(): Promise<Map<string, string[]>> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const rows = await db.select<{ conversation_id: string; tag: string }[]>(
    `SELECT t.conversation_id, t.tag FROM conversation_tags t
     JOIN conversations c ON c.id = t.conversation_id
     WHERE c.account_id = $1 ORDER BY t.tag`,
    [accountId],
  );
  const byConversation = new Map<string, string[]>();
  for (const row of rows) {
    const tags = byConversation.get(row.conversation_id) ?? [];
    tags.push(row.tag);
    byConversation.set(row.conversation_id, tags);
  }
  return byConversation;
}

// Replaces a conversation's tags (the server's list, or the result of a change
// the server accepted).
export async function setConversationTags(id: string, tags: string[]): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM conversation_tags WHERE conversation_id = $1", [id]);
  for (const tag of new Set(tags.map(tagId).filter(Boolean))) {
    await db.execute("INSERT INTO conversation_tags (conversation_id, tag) VALUES ($1, $2)", [id, tag]);
  }
}

export interface MessageHit {
  conversationId: string;
  snippet: string;
}

// Searches message texts of the cloned chats, newest matches first, one hit per
// conversation. Runs on the local copy, so it also works offline. SQLite's
// lower() only folds ASCII letters, so umlaut capitals match case-sensitively.
export async function searchMessages(query: string, limit = 200): Promise<MessageHit[]> {
  const needle = query.trim();
  if (needle.length < 2) return [];
  const db = await getDb();
  const accountId = await currentAccountId();
  const rows = await db.select<{ conversation_id: string; content: string }[]>(
    `SELECT m.conversation_id, m.content FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1 AND c.deleted_pending = 0 AND instr(lower(m.content), lower($2)) > 0
     ORDER BY m.created_at DESC LIMIT $3`,
    [accountId, needle, limit],
  );
  const hits = new Map<string, MessageHit>();
  for (const row of rows) {
    if (hits.has(row.conversation_id)) continue;
    hits.set(row.conversation_id, { conversationId: row.conversation_id, snippet: snippetAround(row.content, needle) });
  }
  return [...hits.values()];
}

// A short excerpt of `text` around the first occurrence of `needle`.
export function snippetAround(text: string, needle: string, radius = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM conversation_tags WHERE conversation_id = $1", [id]);
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

export async function getGroup(id: string): Promise<Group | null> {
  const db = await getDb();
  const rows = await db.select<Group[]>("SELECT * FROM groups WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export interface NewGroupFields {
  parent_id?: string | null;
  icon?: string | null;
  system_prompt?: string | null;
  is_expanded?: boolean;
  openwebui_folder_id?: string | null;
}

export async function createGroup(
  name: string,
  parentId: string | null = null,
  fields: NewGroupFields = {},
): Promise<Group> {
  const db = await getDb();
  const now = Date.now();
  const group: Group = {
    id: newId(),
    name,
    account_id: await currentAccountId(),
    created_at: now,
    parent_id: fields.parent_id ?? parentId,
    icon: fields.icon ?? null,
    system_prompt: fields.system_prompt ?? null,
    is_expanded: fields.is_expanded === false ? 0 : 1,
    openwebui_folder_id: fields.openwebui_folder_id ?? null,
    updated_at: now,
    dirty: 0,
  };
  await db.execute(
    `INSERT INTO groups (id, name, account_id, created_at, parent_id, icon, system_prompt, is_expanded, openwebui_folder_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      group.id,
      group.name,
      group.account_id,
      group.created_at,
      group.parent_id,
      group.icon,
      group.system_prompt,
      group.is_expanded,
      group.openwebui_folder_id,
      group.updated_at,
    ],
  );
  return group;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET name = $1, updated_at = $2 WHERE id = $3", [name, Date.now(), id]);
}

export async function setGroupIcon(id: string, icon: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET icon = $1, updated_at = $2 WHERE id = $3", [icon, Date.now(), id]);
}

export async function setGroupSystemPrompt(id: string, systemPrompt: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET system_prompt = $1, updated_at = $2 WHERE id = $3", [
    systemPrompt,
    Date.now(),
    id,
  ]);
}

export async function setGroupExpanded(id: string, expanded: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET is_expanded = $1 WHERE id = $2", [expanded ? 1 : 0, id]);
}

export async function setGroupParent(id: string, parentId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET parent_id = $1, updated_at = $2 WHERE id = $3", [
    parentId,
    Date.now(),
    id,
  ]);
}

export async function setGroupDirty(id: string, dirty: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET dirty = $1 WHERE id = $2", [dirty ? 1 : 0, id]);
}

// Overwrites a folder's synced fields with the server's values (used by the
// pull in folderSync.ts); does not touch `dirty`.
export async function applyServerGroupFields(
  id: string,
  fields: {
    name: string;
    parent_id: string | null;
    icon: string | null;
    system_prompt?: string | null; // undefined = keep the local prompt
    is_expanded: boolean;
  },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE groups SET name = $1, parent_id = $2, icon = $3, is_expanded = $4 WHERE id = $5",
    [fields.name, fields.parent_id, fields.icon, fields.is_expanded ? 1 : 0, id],
  );
  if (fields.system_prompt !== undefined) {
    await db.execute("UPDATE groups SET system_prompt = $1 WHERE id = $2", [fields.system_prompt, id]);
  }
}

export async function setGroupOpenWebUiFolderId(id: string, folderId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE groups SET openwebui_folder_id = $1 WHERE id = $2", [folderId, id]);
}

// Deleting a folder keeps its contents (matching Open WebUI's default):
// subfolders move up one level and chats become unfiled.
export async function deleteGroup(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ parent_id: string | null }[]>("SELECT parent_id FROM groups WHERE id = $1", [id]);
  const parentId = rows[0]?.parent_id ?? null;
  await db.execute("UPDATE groups SET parent_id = $1 WHERE parent_id = $2", [parentId, id]);
  await db.execute("UPDATE conversations SET group_id = NULL WHERE group_id = $1", [id]);
  await db.execute("DELETE FROM groups WHERE id = $1", [id]);
}

// The system prompt of the folder a conversation is filed in, if it has one.
// A lookup failure just means "no prompt" — it must never block sending.
export async function folderSystemPrompt(conversationId: string): Promise<string | null> {
  try {
    const conversation = await getConversation(conversationId);
    if (!conversation?.group_id) return null;
    const text = (await getGroup(conversation.group_id))?.system_prompt?.trim();
    return text || null;
  } catch {
    return null;
  }
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

// The sidebar shows every chat in time groups, so the default is generous
// rather than a "recent 50" cut-off.
export async function listConversations(limit = 5000): Promise<Conversation[]> {
  const db = await getDb();
  const accountId = await currentAccountId();
  return db.select<Conversation[]>(
    `SELECT * FROM conversations WHERE account_id = $1 AND deleted_pending = 0
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT $2`,
    [accountId, limit],
  );
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.select<Conversation[]>("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// A conversation by its local id or by its Open WebUI chat id (what links carry,
// since that id is the same on every device).
export async function findConversationByAnyId(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const rows = await db.select<Conversation[]>(
    `SELECT * FROM conversations
     WHERE account_id = $1 AND deleted_pending = 0 AND (id = $2 OR openwebui_chat_id = $2) LIMIT 1`,
    [accountId, id],
  );
  return rows[0] ?? null;
}

export async function getLatestConversation(): Promise<Conversation | null> {
  const db = await getDb();
  const accountId = await currentAccountId();
  const rows = await db.select<Conversation[]>(
    "SELECT * FROM conversations WHERE account_id = $1 AND deleted_pending = 0 ORDER BY created_at DESC LIMIT 1",
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
  extras?: MessageExtras,
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
    feedback_id: null,
    reasoning: extras?.reasoning?.trim() ? extras.reasoning : null,
    reasoning_seconds: extras?.reasoning?.trim() ? (extras.reasoningSeconds ?? null) : null,
    sources: extras?.sources?.length ? JSON.stringify(extras.sources) : null,
  };
  await db.execute(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, tokens, attachments, reasoning, reasoning_seconds, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      stored.id,
      stored.conversation_id,
      stored.role,
      stored.content,
      stored.created_at,
      stored.tokens,
      stored.attachments,
      stored.reasoning,
      stored.reasoning_seconds,
      stored.sources,
    ],
  );
  // New activity moves the chat to "Today" and, if it already lives on the
  // server, queues the new message for the next sync.
  await db.execute(
    "UPDATE conversations SET updated_at = $1, dirty = CASE WHEN openwebui_chat_id IS NULL THEN dirty ELSE 1 END WHERE id = $2",
    [stored.created_at, conversationId],
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
  await db.execute(
    `UPDATE conversations SET dirty = 1
     WHERE openwebui_chat_id IS NOT NULL AND id = (SELECT conversation_id FROM messages WHERE id = $1)`,
    [id],
  );
}

export async function updateMessageVote(id: string, vote: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET vote = $1 WHERE id = $2", [vote, id]);
}

export async function setMessageFeedbackId(id: string, feedbackId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET feedback_id = $1 WHERE id = $2", [feedbackId, id]);
}

// Queues a chat's messages / ratings / knowledge for the next push to the server.
export async function markConversationDirty(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE conversations SET dirty = 1 WHERE id = $1 AND openwebui_chat_id IS NOT NULL", [id]);
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
  await db.execute("UPDATE conversations SET dirty = 1 WHERE id = $1 AND openwebui_chat_id IS NOT NULL", [
    conversationId,
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
    "DELETE FROM conversation_tags WHERE conversation_id IN (SELECT id FROM conversations WHERE account_id = $1)",
    [accountId],
  );
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
