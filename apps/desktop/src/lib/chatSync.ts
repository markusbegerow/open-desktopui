// Keeps the sidebar's chats in step with the signed-in Open WebUI account —
// the chat counterpart of folderSync.ts.
//
// The server is the source of truth. Every chat of the account is cloned into
// SQLite, messages included, so everything stays readable when the connection
// drops. Changes that need the server (rename, pin, archive, delete) are sent
// first and only applied locally once the server accepted them; there is no
// offline write queue. The one thing that is pushed after the fact is a chat's
// messages: replies come in through /api/chat/completions, so the finished chat
// is written to the server afterwards (`dirty` = "unsent messages"). If the
// server changed the chat in the meantime, its version wins.
import {
  Conversation,
  acknowledgeConversation,
  applyServerChatFields,
  createConversationFromServer,
  deleteConversation,
  getConversation,
  getMessages,
  listConversationTags,
  listConversationsForSync,
  listGroups,
  markConversationUnread,
  parseAttachments,
  parseKnowledgeIds,
  parseSources,
  renameConversation,
  replaceMessagesFromServer,
  setConversationArchived,
  setConversationDirty,
  setConversationKnowledgeFromServer,
  setConversationParamsFromServer,
  setConversationPinned,
  setConversationServerUpdatedAt,
  setConversationTags,
  setMessageOpenWebUiId,
  tagId,
  tagLabel,
} from "./chatHistory";
import { SyncOutcome, getSession, pullFolders } from "./folderSync";
import * as api from "./openWebUiClient";
import { ensureSharedChat } from "./openWebUiSync";
import { joinForServer } from "./reasoning";
import { parseParams } from "./chatOptions";
import { pullLibrary } from "./librarySync";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `folder_request` reports HTTP failures as "... failed (404 Not Found): ...";
// older Open WebUI versions answer a missing chat with 401 "Not found".
export function isNotFound(err: unknown): boolean {
  return /\b404\b|not found/i.test(errorText(err));
}

// reqwest's "could not reach <url>: ..." — the server can't be contacted at all.
function isUnreachable(err: unknown): boolean {
  return /could not reach/i.test(errorText(err));
}

const NO_SESSION: SyncOutcome = { synced: false, error: "Not signed in to Open WebUI" };

// Runs `push` against the server for a chat that exists there, and `apply` on
// the local copy only once the server accepted it. Chats that never reached the
// server are purely local and just get `apply`.
async function serverFirst(
  conversation: Conversation,
  push: (session: { baseUrl: string; token: string }, chatId: string) => Promise<void>,
  apply: () => Promise<void>,
): Promise<SyncOutcome> {
  const chatId = conversation.openwebui_chat_id;
  if (!chatId) {
    await apply();
    return { synced: true };
  }
  const session = await getSession();
  if (!session) return NO_SESSION;
  try {
    await push(session, chatId);
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
  await apply();
  await recordServerTime(conversation, session);
  return { synced: true };
}

export function renameChat(conversation: Conversation, title: string): Promise<SyncOutcome> {
  return serverFirst(
    conversation,
    (s, chatId) => api.updateChatTitle(s.baseUrl, s.token, chatId, title),
    () => renameConversation(conversation.id, title),
  );
}

export function setChatPinned(conversation: Conversation, pinned: boolean): Promise<SyncOutcome> {
  return serverFirst(
    conversation,
    (s, chatId) => api.setChatFlag(s.baseUrl, s.token, chatId, "pin", pinned),
    () => setConversationPinned(conversation.id, pinned),
  );
}

export function setChatArchived(conversation: Conversation, archived: boolean): Promise<SyncOutcome> {
  return serverFirst(
    conversation,
    (s, chatId) => api.setChatFlag(s.baseUrl, s.token, chatId, "archive", archived),
    () => setConversationArchived(conversation.id, archived),
  );
}

// Tags go to the server first like the other chat changes; what the server
// answers with (the chat's tag list afterwards) becomes the local list. A chat
// that isn't on the server yet just keeps its tags locally.
async function changeTags(
  conversation: Conversation,
  change: (tags: string[]) => string[],
  send: (s: { baseUrl: string; token: string }, chatId: string) => Promise<string[]>,
): Promise<SyncOutcome> {
  const current = (await listConversationTags()).get(conversation.id) ?? [];
  const chatId = conversation.openwebui_chat_id;
  if (!chatId) {
    await setConversationTags(conversation.id, change(current));
    return { synced: true };
  }
  const session = await getSession();
  if (!session) return NO_SESSION;
  let tags: string[];
  try {
    tags = await send(session, chatId);
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
  await setConversationTags(conversation.id, tags);
  return { synced: true };
}

export function addChatTag(conversation: Conversation, name: string): Promise<SyncOutcome> {
  const id = tagId(name);
  if (!id) return Promise.resolve({ synced: true });
  return changeTags(
    conversation,
    (tags) => [...tags, id],
    (s, chatId) => api.addChatTag(s.baseUrl, s.token, chatId, tagLabel(id)),
  );
}

export function removeChatTag(conversation: Conversation, tag: string): Promise<SyncOutcome> {
  return changeTags(
    conversation,
    (tags) => tags.filter((t) => t !== tag),
    (s, chatId) => api.removeChatTag(s.baseUrl, s.token, chatId, tagLabel(tag)),
  );
}

// "Mark as unread" goes to the server first, like the other chat changes.
// "Mark as read" can't be sent (the server only learns about reading through
// its websocket), so it just clears the dot here until the chat changes again.
export async function setChatUnread(conversation: Conversation, unread: boolean): Promise<SyncOutcome> {
  if (!unread) {
    await acknowledgeConversation(conversation.id);
    return { synced: true };
  }
  return serverFirst(
    conversation,
    (s, chatId) => api.markChatUnread(s.baseUrl, s.token, chatId),
    () => markConversationUnread(conversation.id),
  );
}

// The chat the user is looking at counts as read: a pull must not light its dot.
let activeChatId: string | null = null;

export function setActiveChat(conversationId: string | null) {
  activeChatId = conversationId;
}

// The user opened the chat. Returns whether the unread dot went away.
export function markChatRead(conversationId: string): Promise<boolean> {
  return acknowledgeConversation(conversationId).catch(() => false);
}

export async function deleteChat(conversation: Conversation): Promise<SyncOutcome> {
  const chatId = conversation.openwebui_chat_id;
  if (chatId) {
    const session = await getSession();
    if (!session) return NO_SESSION;
    try {
      await api.deleteChat(session.baseUrl, session.token, chatId);
    } catch (err) {
      // Already gone on the server counts as deleted.
      if (!isNotFound(err)) return { synced: false, error: errorText(err) };
    }
  }
  await deleteConversation(conversation.id);
  return { synced: true };
}

// After a push, remember the server's new `updated_at` so the next pull doesn't
// mistake our own change for someone else's and refetch the messages.
async function recordServerTime(
  conversation: Pick<Conversation, "id" | "openwebui_chat_id">,
  session: { baseUrl: string; token: string },
  seen = false,
): Promise<void> {
  if (!conversation.openwebui_chat_id) return;
  try {
    const detail = await api.getChat(session.baseUrl, session.token, conversation.openwebui_chat_id);
    if (detail.chat.updatedAt) await setConversationServerUpdatedAt(conversation.id, detail.chat.updatedAt, seen);
  } catch {
    // Worst case the next pull refetches the messages once.
  }
}

// The chat's knowledge bases with their names (the server shows them in the
// chat); a name that can't be looked up falls back to the id.
async function knowledgeRefs(
  conversation: Conversation,
  session: { baseUrl: string; token: string },
): Promise<api.KnowledgeBase[]> {
  const ids = parseKnowledgeIds(conversation);
  if (ids.length === 0) return [];
  const names = new Map<string, string>();
  try {
    for (const kb of await api.listKnowledgeBases(session.baseUrl, session.token)) names.set(kb.id, kb.name);
  } catch {
    // names are cosmetic
  }
  return ids.map((id) => ({ id, name: names.get(id) ?? id }));
}

// Writes a chat's title, messages (with ratings and attachments) and knowledge
// bases to the server. The server side merges into what it has, so fields this
// app doesn't know survive; a failed push heals itself with the next one.
export async function pushChatMessages(
  conversation: Conversation,
  session: { baseUrl: string; token: string },
): Promise<void> {
  const chatId = conversation.openwebui_chat_id!;
  const stored = await getMessages(conversation.id);
  const messages: api.SyncMessage[] = [];
  for (const m of stored) {
    let serverId = m.openwebui_message_id;
    if (!serverId) {
      serverId = m.id;
      await setMessageOpenWebUiId(m.id, serverId);
    }
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
    const files = parseAttachments(m).map((a) => ({ id: a.openWebUiFileId, name: a.filename, mime: a.mimeType }));
    const sources = parseSources(m);
    messages.push({
      id: serverId,
      role: m.role,
      // The thinking goes in front of the answer the way the web UI keeps it.
      content: joinForServer(m.content, m.reasoning, m.reasoning_seconds),
      sources: sources.length > 0 ? sources : undefined,
      timestamp: m.created_at,
      rating: m.vote ?? undefined,
      feedbackId: m.feedback_id ?? undefined,
      files: files.length > 0 ? files : undefined,
    });
  }
  // A chat with no local messages (not cloned yet) must not wipe the server's.
  if (messages.length > 0) {
    await api.updateChatContent(
      session.baseUrl,
      session.token,
      chatId,
      conversation.title,
      conversation.model,
      messages,
      await knowledgeRefs(conversation, session),
      parseParams(conversation.params),
    );
  } else {
    await api.updateChatTitle(session.baseUrl, session.token, chatId, conversation.title);
  }
  await setConversationDirty(conversation.id, false);
  // The user just wrote this version, so it isn't unread.
  await recordServerTime(conversation, session, true);
}

// Loads a chat's messages on first open when the clone hasn't reached it yet
// (or the server changed it). Never throws; returns true if the local copy changed.
export async function refreshChatMessages(conversationId: string): Promise<boolean> {
  try {
    const conversation = await getConversation(conversationId);
    if (!conversation?.openwebui_chat_id || !conversation.messages_stale) return false;
    // `messages_stale` is only set when the server moved on, and the server's
    // copy wins: unsent local messages of that chat are replaced.
    const session = await getSession();
    if (!session) return false;
    const detail = await api.getChat(session.baseUrl, session.token, conversation.openwebui_chat_id);
    await replaceMessagesFromServer(conversation.id, detail.messages, detail.model);
    await setConversationKnowledgeFromServer(conversation.id, detail.knowledgeIds);
    await setConversationTags(conversation.id, detail.tags);
    await setConversationParamsFromServer(conversation.id, detail.params);
    if (conversation.dirty) await setConversationDirty(conversation.id, false);
    return true;
  } catch {
    return false;
  }
}

export interface SyncResult {
  // something local changed, so the sidebar should reload
  changed: boolean;
  // false when the server couldn't be contacted; the local clone is left as it was
  reachable: boolean;
}

export interface CloneProgress {
  done: number;
  total: number;
}

const progressListeners = new Set<(progress: CloneProgress | null) => void>();

// Reports the initial / catch-up clone ("120 of 340 chats"); null when idle.
export function subscribeCloneProgress(listener: (progress: CloneProgress | null) => void): () => void {
  progressListeners.add(listener);
  return () => void progressListeners.delete(listener);
}

function emitProgress(progress: CloneProgress | null) {
  for (const listener of progressListeners) listener(progress);
}

const CLONE_CONCURRENCY = 4;

// Fetches the messages of every chat the clone is missing or that changed on the
// server. A failing chat stays stale and is retried by the next run; an
// unreachable server ends the run instead of failing chat by chat.
async function cloneMessages(session: { baseUrl: string; token: string }): Promise<void> {
  const queue = (await listConversationsForSync()).filter(
    (c) => c.openwebui_chat_id && c.messages_stale && !c.dirty && !c.deleted_pending,
  );
  if (queue.length === 0) return;

  const total = queue.length;
  let done = 0;
  let aborted = false;
  emitProgress({ done, total });
  const worker = async () => {
    for (let c = queue.shift(); c && !aborted; c = queue.shift()) {
      try {
        const detail = await api.getChat(session.baseUrl, session.token, c.openwebui_chat_id!);
        await replaceMessagesFromServer(c.id, detail.messages, detail.model);
        await setConversationKnowledgeFromServer(c.id, detail.knowledgeIds);
        await setConversationTags(c.id, detail.tags);
        await setConversationParamsFromServer(c.id, detail.params);
      } catch (err) {
        if (isUnreachable(err)) aborted = true;
      }
      done++;
      emitProgress({ done, total });
    }
  };
  try {
    await Promise.all(Array.from({ length: CLONE_CONCURRENCY }, worker));
  } finally {
    emitProgress(null);
  }
}

let syncing: Promise<SyncResult> | null = null;

// Folders first (chats refer to them), then chats. Overlapping calls share one run.
export function syncWithServer(): Promise<SyncResult> {
  if (!syncing) {
    syncing = (async () => {
      const foldersChanged = await pullFolders().catch(() => false);
      const chats = await pullChats().catch((): SyncResult => ({ changed: false, reachable: true }));
      // Prompts, notes and memories are not chat data, but they travel with it.
      const libraryChanged = chats.reachable ? await pullLibrary().catch(() => false) : false;
      return { changed: foldersChanged || chats.changed || libraryChanged, reachable: chats.reachable };
    })().finally(() => {
      syncing = null;
    });
  }
  return syncing;
}

// Reconciles local chats with the server's. Never throws: the server may be
// unreachable or the session expired — then the local clone stays as it is.
export async function pullChats(): Promise<SyncResult> {
  const session = await getSession();
  if (!session) return { changed: false, reachable: true }; // signed out: nothing to sync

  let server: api.ServerChat[];
  try {
    const folderIds = (await listGroups()).map((g) => g.openwebui_folder_id).filter((id): id is string => !!id);
    server = await api.listChats(session.baseUrl, session.token, folderIds);
  } catch (err) {
    return { changed: false, reachable: !isUnreachable(err) };
  }

  let changed = false;
  try {
    const groups = await listGroups();
    const groupByFolder = new Map(groups.filter((g) => g.openwebui_folder_id).map((g) => [g.openwebui_folder_id!, g.id]));
    const serverById = new Map(server.map((c) => [c.id, c]));
    const live = (await listConversationsForSync()).filter((c) => !c.deleted_pending);
    const localByServerId = new Map(live.filter((c) => c.openwebui_chat_id).map((c) => [c.openwebui_chat_id!, c]));

    // 1. Chats deleted on the server disappear locally. The listing can be
    //    incomplete (e.g. the archived lookup failed), so only an explicit
    //    "not found" for the chat itself counts.
    for (const c of live) {
      if (!c.openwebui_chat_id || serverById.has(c.openwebui_chat_id)) continue;
      try {
        await api.getChat(session.baseUrl, session.token, c.openwebui_chat_id);
      } catch (err) {
        if (isNotFound(err)) {
          await deleteConversation(c.id);
          localByServerId.delete(c.openwebui_chat_id);
          changed = true;
        }
      }
    }

    // 2. New and changed chats from the server. The server's version wins; a
    //    chat with unsent local messages is only left alone (and pushed in step
    //    3) while the server hasn't moved since we last synced it. Without a
    //    baseline a dirty chat can't be judged and counts as unmoved.
    for (const remote of server) {
      const existing = localByServerId.get(remote.id);
      // Unread comes from the server's `last_read_at` (unknown = leave it): unread
      // when it was reset or the chat changed after it. It stays read here once the
      // user has seen this version (`unread_ack_at`) — the server only learns about
      // reading through its websocket, which this app doesn't use.
      const viewing = !!existing && existing.id === activeChatId;
      const serverUnread =
        remote.lastReadAt == null ? undefined : remote.lastReadAt === 0 || remote.updatedAt > remote.lastReadAt;
      const fields = {
        title: remote.title,
        updated_at: remote.updatedAt || Date.now(),
        pinned: remote.pinned ?? undefined,
        archived: remote.archived ?? undefined,
        unread:
          serverUnread === undefined
            ? undefined
            : serverUnread && !viewing && remote.updatedAt > (existing?.unread_ack_at ?? 0),
        // A folder this device doesn't know yet leaves the chat where it is.
        group_id: remote.folderKnown
          ? remote.folderId
            ? (groupByFolder.get(remote.folderId) ?? undefined)
            : null
          : undefined,
      };
      if (!existing) {
        await createConversationFromServer(remote.id, "", remote.createdAt, fields);
        changed = true;
        continue;
      }
      const baseline = existing.server_updated_at;
      const serverMoved = existing.dirty
        ? baseline != null && remote.updatedAt > baseline
        : remote.updatedAt > (baseline ?? 0);
      if (existing.dirty && !serverMoved) continue;
      const differs =
        serverMoved ||
        existing.title !== fields.title ||
        (fields.pinned !== undefined && !!existing.pinned !== fields.pinned) ||
        (fields.archived !== undefined && !!existing.archived !== fields.archived) ||
        (fields.group_id !== undefined && existing.group_id !== fields.group_id) ||
        (fields.unread !== undefined && !!existing.unread !== fields.unread);
      if (differs) {
        await applyServerChatFields(existing.id, fields, serverMoved);
        if (existing.dirty) await setConversationDirty(existing.id, false);
        changed = true;
      }
      // Looking at it right now: remember that this version was seen.
      if (viewing && serverUnread) await acknowledgeConversation(existing.id);
    }

    // 3. Local messages the server hasn't seen yet. A chat that never reached the
    //    server is created there; one that did is brought up to date.
    for (const c of await listConversationsForSync()) {
      if (c.deleted_pending) continue;
      try {
        if (!c.openwebui_chat_id) {
          await ensureSharedChat(c);
          const fresh = await getConversation(c.id);
          if (fresh?.openwebui_chat_id) {
            // Creating the chat only carries the text: add ratings, attachments
            // and knowledge bases now rather than a minute later.
            await pushChatMessages(fresh, session);
            // Tags set while the chat was local-only.
            for (const tag of (await listConversationTags()).get(fresh.id) ?? []) {
              await api.addChatTag(session.baseUrl, session.token, fresh.openwebui_chat_id, tagLabel(tag));
            }
            // The new server chat starts unpinned and unarchived.
            if (fresh.pinned) await api.setChatFlag(session.baseUrl, session.token, fresh.openwebui_chat_id, "pin", true);
            if (fresh.archived) {
              await api.setChatFlag(session.baseUrl, session.token, fresh.openwebui_chat_id, "archive", true);
            }
          }
          changed = true;
        } else if (c.dirty && serverById.has(c.openwebui_chat_id)) {
          await pushChatMessages(c, session);
        }
      } catch {
        // No messages yet, or the server said no: stays local / dirty, retried next time.
      }
    }

    // 4. The full clone: messages of everything new or changed on the server.
    await cloneMessages(session);
  } catch {
    // Local database trouble — leave things as they are.
  }
  return { changed, reachable: true };
}
