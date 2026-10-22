import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "./chatHistory";

// --- in-memory stand-in for the conversations table ------------------------
let convs: Conversation[] = [];
let nextId = 1;

function find(id: string) {
  return convs.find((c) => c.id === id)!;
}

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: `L${nextId++}`,
    title: "Chat",
    model: "gpt",
    created_at: 1000,
    knowledge_ids: null,
    account_id: "acct",
    pinned: 0,
    unread: 0,
    archived: 0,
    group_id: null,
    openwebui_chat_id: null,
    updated_at: 1000,
    dirty: 0,
    deleted_pending: 0,
    server_updated_at: null,
    messages_stale: 0,
    unread_ack_at: null,
    params: null,
    features: null,
    ...over,
  };
}

const messageIds: string[] = [];
let tagStore: Record<string, string[]> = {};
const store = {
  listConversationsForSync: vi.fn(async () => convs.map((c) => ({ ...c }))),
  getConversation: vi.fn(async (id: string) => {
    const c = convs.find((x) => x.id === id);
    return c ? { ...c } : null;
  }),
  getMessages: vi.fn(async () => [] as unknown[]),
  listGroups: vi.fn(async () => [{ id: "G1", openwebui_folder_id: "F1" }]),
  createConversationFromServer: vi.fn(async (chatId: string, model: string, createdAt: number, f: Record<string, unknown>) => {
    const c = conv({
      title: f.title as string,
      model,
      created_at: createdAt,
      openwebui_chat_id: chatId,
      updated_at: f.updated_at as number,
      server_updated_at: f.updated_at as number,
      messages_stale: 1,
      pinned: f.pinned ? 1 : 0,
      archived: f.archived ? 1 : 0,
      group_id: (f.group_id as string | null | undefined) ?? null,
      unread: f.unread ? 1 : 0,
    });
    convs.push(c);
    return { ...c };
  }),
  applyServerChatFields: vi.fn(async (id: string, f: Record<string, unknown>, stale: boolean) => {
    const c = find(id);
    c.title = f.title as string;
    c.updated_at = c.server_updated_at = f.updated_at as number;
    if (stale) c.messages_stale = 1;
    if (f.pinned !== undefined) c.pinned = f.pinned ? 1 : 0;
    if (f.archived !== undefined) c.archived = f.archived ? 1 : 0;
    if (f.group_id !== undefined) c.group_id = f.group_id as string | null;
    if (f.unread !== undefined) c.unread = f.unread ? 1 : 0;
  }),
  acknowledgeConversation: vi.fn(async (id: string) => {
    const c = find(id);
    const seen = c.server_updated_at ?? c.updated_at ?? 0;
    if (!c.unread && (c.unread_ack_at ?? 0) >= seen) return false;
    c.unread = 0;
    c.unread_ack_at = seen;
    return true;
  }),
  markConversationUnread: vi.fn(async (id: string) => {
    find(id).unread = 1;
    find(id).unread_ack_at = 0;
  }),
  parseAttachments: (m: { attachments?: string | null }) => (m.attachments ? JSON.parse(m.attachments) : []),
  parseSources: (m: { sources?: string | null }) => (m.sources ? JSON.parse(m.sources) : []),
  parseKnowledgeIds: (c: { knowledge_ids: string | null }) => (c.knowledge_ids ? JSON.parse(c.knowledge_ids) : []),
  tagId: (name: string) => name.trim().toLowerCase().replace(/\s+/g, "_"),
  tagLabel: (id: string) => id.replace(/_/g, " "),
  listConversationTags: vi.fn(async () => new Map(Object.entries(tagStore).map(([k, v]) => [k, [...v]]))),
  setConversationTags: vi.fn(async (id: string, tags: string[]) => {
    tagStore[id] = [...tags];
  }),
  setConversationParamsFromServer: vi.fn(async (id: string, params: Record<string, unknown>) => {
    find(id).params = JSON.stringify(params);
  }),
  setConversationKnowledgeFromServer: vi.fn(async (id: string, ids: string[]) => {
    find(id).knowledge_ids = ids.length ? JSON.stringify(ids) : null;
  }),
  deleteConversation: vi.fn(async (id: string) => void (convs = convs.filter((c) => c.id !== id))),
  markConversationDeletePending: vi.fn(async (id: string) => void (find(id).deleted_pending = 1)),
  setConversationDirty: vi.fn(async (id: string, d: boolean) => void (find(id).dirty = d ? 1 : 0)),
  renameConversation: vi.fn(async (id: string, title: string) => void (find(id).title = title)),
  setConversationPinned: vi.fn(async (id: string, p: boolean) => void (find(id).pinned = p ? 1 : 0)),
  setConversationArchived: vi.fn(async (id: string, a: boolean) => void (find(id).archived = a ? 1 : 0)),
  setConversationServerUpdatedAt: vi.fn(async (id: string, t: number, seen = false) => {
    find(id).server_updated_at = t;
    if (seen) {
      find(id).unread = 0;
      find(id).unread_ack_at = t;
    }
  }),
  setMessageOpenWebUiId: vi.fn(async (id: string) => void messageIds.push(id)),
  replaceMessagesFromServer: vi.fn(async (id: string) => void (find(id).messages_stale = 0)),
};
vi.mock("./chatHistory", () => store);

vi.mock("./librarySync", () => ({ pullLibrary: vi.fn(async () => false) }));

// --- fake folder sync / sharing -------------------------------------------
const pullFolders = vi.fn(async () => false);
let session: { baseUrl: string; token: string } | null = { baseUrl: "http://srv", token: "t" };
vi.mock("./folderSync", () => ({
  getSession: vi.fn(async () => session),
  pullFolders: () => pullFolders(),
  serverFolderIdFor: vi.fn(async (gid: string | null) => (gid === "G1" ? "F1" : null)),
}));
const ensureSharedChat = vi.fn(async (c: Conversation) => {
  find(c.id).openwebui_chat_id = "S-new";
  return { chatId: "S-new", url: "" };
});
vi.mock("./openWebUiSync", () => ({ ensureSharedChat: (c: Conversation) => ensureSharedChat(c) }));

// --- fake Open WebUI chats API --------------------------------------------
type Remote = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean | null;
  archived: boolean | null;
  folderId: string | null;
  folderKnown: boolean;
  lastReadAt: number | null;
};
let remote: Remote[] = [];
let remoteKnowledge: string[] = [];
let remoteTags: string[] = [];
let remoteParams: Record<string, unknown> = { system: null, temperature: null, top_p: null, max_tokens: null, seed: null, stop: [] };
let listShouldFail = false;
let listError: Error | null = null;
let getChatError: Error | null = null;
// per-chat failures for the clone step
const getChatErrors = new Map<string, Error>();
const api = {
  listChats: vi.fn(async () => {
    if (listError) throw listError;
    if (listShouldFail) throw new Error("offline");
    return remote.map((r) => ({ ...r }));
  }),
  getChat: vi.fn(async (_b: string, _t: string, id: string) => {
    if (getChatError) throw getChatError;
    if (getChatErrors.has(id)) throw getChatErrors.get(id)!;
    const r = remote.find((x) => x.id === id);
    if (!r) throw new Error("folder request failed (404 Not Found): {}");
    return {
      chat: { ...r },
      model: "gpt",
      messages: [],
      knowledgeIds: remoteKnowledge,
      tags: remoteTags,
      params: remoteParams,
    };
  }),
  addChatTag: vi.fn(async (_b: string, _t: string, _id: string, name: string) => [
    ...remoteTags,
    name.trim().toLowerCase().replace(/\s+/g, "_"),
  ]),
  removeChatTag: vi.fn(async (_b: string, _t: string, _id: string, name: string) =>
    remoteTags.filter((t) => t !== name.trim().toLowerCase().replace(/\s+/g, "_")),
  ),
  markChatUnread: vi.fn(async () => {}),
  listKnowledgeBases: vi.fn(async () => [{ id: "kb1", name: "Docs" }]),
  updateChatTitle: vi.fn(async () => {}),
  updateChatContent: vi.fn(async () => {}),
  deleteChat: vi.fn(async () => {}),
  setChatFlag: vi.fn(async () => {}),
  moveChatToFolder: vi.fn(async () => {}),
};
vi.mock("./openWebUiClient", () => api);

// Imported after the fakes above exist: the mock factories read them directly.
const {
  addChatTag,
  deleteChat,
  pullChats,
  removeChatTag,
  refreshChatMessages,
  renameChat,
  setActiveChat,
  setChatArchived,
  setChatPinned,
  setChatUnread,
  subscribeCloneProgress,
  syncWithServer,
} = await import("./chatSync");

function server(over: Partial<Remote> = {}): Remote {
  return {
    id: "S1",
    title: "From server",
    createdAt: 500,
    updatedAt: 2000,
    pinned: false,
    archived: false,
    folderId: null,
    folderKnown: true,
    lastReadAt: null,
    ...over,
  };
}

beforeEach(() => {
  convs = [];
  remote = [];
  remoteKnowledge = [];
  remoteTags = [];
  remoteParams = { system: null, temperature: null, top_p: null, max_tokens: null, seed: null, stop: [] };
  tagStore = {};
  setActiveChat(null);
  nextId = 1;
  messageIds.length = 0;
  listShouldFail = false;
  getChatError = null;
  getChatErrors.clear();
  listError = null;
  session = { baseUrl: "http://srv", token: "t" };
  vi.clearAllMocks();
});


describe("pullChats", () => {
  it("does nothing without a session", async () => {
    session = null;
    expect(await pullChats()).toEqual({ changed: false, reachable: true });
  });

  it("reports an unreachable server and leaves the local clone untouched", async () => {
    convs = [conv({ openwebui_chat_id: "S1", messages_stale: 1 })];
    listError = new Error("could not reach http://srv: connection refused");
    expect(await pullChats()).toEqual({ changed: false, reachable: false });
    expect(convs).toHaveLength(1);
    expect(store.replaceMessagesFromServer).not.toHaveBeenCalled();
  });

  it("does not call an ordinary server error offline", async () => {
    listShouldFail = true;
    expect(await pullChats()).toEqual({ changed: false, reachable: true });
  });

  it("clones new server chats with their messages, mapping the folder", async () => {
    remote = [server({ pinned: true, folderId: "F1" })];
    expect((await pullChats()).changed).toBe(true);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      title: "From server",
      openwebui_chat_id: "S1",
      pinned: 1,
      group_id: "G1",
      messages_stale: 0,
    });
    expect(store.replaceMessagesFromServer).toHaveBeenCalledTimes(1);
  });

  it("keeps the local folder when the server did not report one", async () => {
    convs = [conv({ openwebui_chat_id: "S1", group_id: "G1", server_updated_at: 2000, title: "From server" })];
    remote = [server({ folderKnown: false })];
    await pullChats();
    expect(convs[0].group_id).toBe("G1");
  });

  it("takes changed title and flags from the server and refetches the messages", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "Old", server_updated_at: 1000 })];
    remote = [server({ title: "Renamed", archived: true, updatedAt: 3000 })];
    expect((await pullChats()).changed).toBe(true);
    expect(convs[0]).toMatchObject({ title: "Renamed", archived: 1, messages_stale: 0, server_updated_at: 3000 });
    expect(store.replaceMessagesFromServer).toHaveBeenCalledTimes(1);
  });

  it("leaves an unchanged chat alone", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "From server", server_updated_at: 2000 })];
    remote = [server()];
    expect((await pullChats()).changed).toBe(false);
    expect(store.applyServerChatFields).not.toHaveBeenCalled();
    expect(store.replaceMessagesFromServer).not.toHaveBeenCalled();
  });

  it("pushes unsent messages when the server has not moved since the last sync", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "Local", dirty: 1, server_updated_at: 2000 })];
    remote = [server({ updatedAt: 2000 })];
    await pullChats();
    expect(store.applyServerChatFields).not.toHaveBeenCalled();
    expect(api.updateChatTitle).toHaveBeenCalledWith("http://srv", "t", "S1", "Local");
    expect(convs[0].dirty).toBe(0);
  });

  it("lets the server win a conflict: its version replaces unsent local messages", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "Local", dirty: 1, server_updated_at: 1000 })];
    remote = [server({ title: "Server title", updatedAt: 3000 })];
    await pullChats();
    expect(convs[0]).toMatchObject({ title: "Server title", dirty: 0, messages_stale: 0 });
    expect(api.updateChatTitle).not.toHaveBeenCalled();
    expect(api.updateChatContent).not.toHaveBeenCalled();
    expect(store.replaceMessagesFromServer).toHaveBeenCalledTimes(1);
  });

  it("treats a dirty chat without a baseline as unmoved and pushes it", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "Local", dirty: 1, server_updated_at: null })];
    remote = [server({ updatedAt: 3000 })];
    await pullChats();
    expect(api.updateChatTitle).toHaveBeenCalled();
  });

  it("removes chats the server confirms are gone, but not on a transient error", async () => {
    convs = [conv({ openwebui_chat_id: "S-gone" }), conv({ openwebui_chat_id: "S-kept" })];
    remote = [];
    getChatError = new Error("could not reach http://srv");
    await pullChats();
    expect(convs).toHaveLength(2);

    getChatError = null;
    await pullChats();
    expect(convs).toHaveLength(0);
  });

  it("creates local-only chats on the server and pins them there if needed", async () => {
    convs = [conv({ pinned: 1 })];
    await pullChats();
    expect(ensureSharedChat).toHaveBeenCalledTimes(1);
    expect(convs[0].openwebui_chat_id).toBe("S-new");
    expect(api.setChatFlag).toHaveBeenCalledWith("http://srv", "t", "S-new", "pin", true);
  });
});

describe("clone", () => {
  it("fetches the messages of every stale chat and reports progress", async () => {
    remote = ["S1", "S2", "S3", "S4", "S5", "S6"].map((id) => server({ id }));
    const progress: Array<{ done: number; total: number } | null> = [];
    const unsubscribe = subscribeCloneProgress((p) => progress.push(p));
    await pullChats();
    unsubscribe();
    expect(convs).toHaveLength(6);
    expect(convs.every((c) => c.messages_stale === 0)).toBe(true);
    expect(progress[0]).toEqual({ done: 0, total: 6 });
    expect(progress[progress.length - 2]).toEqual({ done: 6, total: 6 });
    expect(progress[progress.length - 1]).toBeNull();
  });

  it("leaves a failing chat stale for the next run and still clones the rest", async () => {
    remote = [server({ id: "S1" }), server({ id: "S2" })];
    getChatErrors.set("S1", new Error("server error (500)"));
    await pullChats();
    const byId = new Map(convs.map((c) => [c.openwebui_chat_id, c]));
    expect(byId.get("S1")!.messages_stale).toBe(1);
    expect(byId.get("S2")!.messages_stale).toBe(0);

    getChatErrors.clear();
    await pullChats();
    expect(byId.get("S1")!.messages_stale).toBe(0);
  });

  it("stops when the server becomes unreachable instead of failing chat by chat", async () => {
    remote = Array.from({ length: 12 }, (_, i) => server({ id: `S${i}` }));
    getChatError = new Error("could not reach http://srv");
    await pullChats();
    expect(api.getChat.mock.calls.length).toBeLessThanOrEqual(4);
    expect(convs.every((c) => c.messages_stale === 1)).toBe(true);
  });

  it("does not overwrite chats with unsent messages", async () => {
    convs = [conv({ openwebui_chat_id: "S1", messages_stale: 1, dirty: 1, server_updated_at: 2000 })];
    remote = [server({ updatedAt: 2000 })];
    api.updateChatTitle.mockRejectedValueOnce(new Error("500"));
    await pullChats();
    expect(store.replaceMessagesFromServer).not.toHaveBeenCalled();
    expect(convs[0].dirty).toBe(1);
  });
});

describe("unread state", () => {
  it("is unread when the server reset last_read_at or the chat changed after it", async () => {
    remote = [
      server({ id: "S0", lastReadAt: 0 }),
      server({ id: "S1", updatedAt: 3000, lastReadAt: 2000 }),
      server({ id: "S2", updatedAt: 2000, lastReadAt: 2000 }),
    ];
    await pullChats();
    const unread = (id: string) => convs.find((c) => c.openwebui_chat_id === id)!.unread;
    expect(unread("S0")).toBe(1);
    expect(unread("S1")).toBe(1);
    expect(unread("S2")).toBe(0);
  });

  it("leaves the local state alone when the server sends no last_read_at", async () => {
    convs = [conv({ openwebui_chat_id: "S1", unread: 1, server_updated_at: 2000, title: "From server" })];
    remote = [server({ lastReadAt: null })];
    await pullChats();
    expect(convs[0].unread).toBe(1);
  });

  it("stays read here once the user saw that version, even though the server never learns of it", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "From server", server_updated_at: 2000, unread_ack_at: 2000 })];
    remote = [server({ lastReadAt: 0 })];
    await pullChats();
    expect(convs[0].unread).toBe(0);

    // a newer server version lights the dot again
    remote = [server({ lastReadAt: 0, updatedAt: 3000 })];
    await pullChats();
    expect(convs[0].unread).toBe(1);
  });

  it("does not light the dot of the chat that is open", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "From server", server_updated_at: 1000 })];
    setActiveChat(convs[0].id);
    remote = [server({ lastReadAt: 0, updatedAt: 3000 })];
    await pullChats();
    expect(convs[0].unread).toBe(0);
    expect(convs[0].unread_ack_at).toBe(3000);
  });

  it("mark as unread goes to the server first and only then lights the dot", async () => {
    const c = conv({ openwebui_chat_id: "S1" });
    convs = [c];
    api.markChatUnread.mockRejectedValueOnce(new Error("500"));
    expect((await setChatUnread(c, true)).synced).toBe(false);
    expect(convs[0].unread).toBe(0);

    expect(await setChatUnread(c, true)).toEqual({ synced: true });
    expect(api.markChatUnread).toHaveBeenLastCalledWith("http://srv", "t", "S1");
    expect(convs[0]).toMatchObject({ unread: 1, unread_ack_at: 0 });
  });

  it("mark as read only clears the dot locally", async () => {
    const c = conv({ openwebui_chat_id: "S1", unread: 1, server_updated_at: 2000, unread_ack_at: 0 });
    convs = [c];
    expect(await setChatUnread(c, false)).toEqual({ synced: true });
    expect(convs[0]).toMatchObject({ unread: 0, unread_ack_at: 2000 });
    expect(api.markChatUnread).not.toHaveBeenCalled();
  });

  it("a chat written in the app is not unread afterwards", async () => {
    convs = [conv({ openwebui_chat_id: "S1", title: "From server", dirty: 1, server_updated_at: 2000, unread: 1 })];
    remote = [server({ updatedAt: 2000 })];
    store.getMessages.mockResolvedValue([
      { id: "m1", role: "user", content: "hi", created_at: 1, openwebui_message_id: "s-m1", vote: null, feedback_id: null, attachments: null },
    ]);
    await pullChats();
    store.getMessages.mockResolvedValue([]);
    expect(convs[0].dirty).toBe(0);
    expect(convs[0].unread).toBe(0);
  });
});

describe("ratings, attachments and knowledge bases", () => {
  it("push carries ratings, feedback ids, attachments and named knowledge bases", async () => {
    convs = [
      conv({ openwebui_chat_id: "S1", title: "From server", dirty: 1, server_updated_at: 2000, knowledge_ids: '["kb1","kb9"]' }),
    ];
    remote = [server({ updatedAt: 2000 })];
    store.getMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "see file",
        created_at: 1000,
        openwebui_message_id: "s-m1",
        vote: null,
        feedback_id: null,
        attachments: JSON.stringify([{ filename: "a.pdf", openWebUiFileId: "f1", mimeType: "application/pdf" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: "ok",
        created_at: 2000,
        openwebui_message_id: null,
        vote: -1,
        feedback_id: "fb1",
        attachments: null,
      },
    ]);
    await pullChats();
    store.getMessages.mockResolvedValue([]);

    const [, , , , , messages, knowledge] = api.updateChatContent.mock.calls[0] as unknown as [
      string, string, string, string, string, Array<Record<string, unknown>>, Array<{ id: string; name: string }>,
    ];
    expect(messages[0]).toMatchObject({
      id: "s-m1",
      files: [{ id: "f1", name: "a.pdf", mime: "application/pdf" }],
    });
    expect(messages[0].rating).toBeUndefined();
    expect(messages[1]).toMatchObject({ id: "m2", rating: -1, feedbackId: "fb1" });
    expect(knowledge).toEqual([
      { id: "kb1", name: "Docs" },
      { id: "kb9", name: "kb9" },
    ]);
  });

  it("the clone takes the knowledge bases from the server", async () => {
    remote = [server()];
    remoteKnowledge = ["kb1", "kb2"];
    await pullChats();
    expect(JSON.parse(convs[0].knowledge_ids!)).toEqual(["kb1", "kb2"]);
  });

  it("a cleared server-side selection clears it locally too", async () => {
    convs = [conv({ openwebui_chat_id: "S1", messages_stale: 1, knowledge_ids: '["kb1"]' })];
    remote = [server()];
    remoteKnowledge = [];
    await refreshChatMessages(convs[0].id);
    expect(convs[0].knowledge_ids).toBeNull();
  });
});

describe("tags", () => {
  it("the clone takes the server's tags, and a cleared list clears them", async () => {
    remote = [server()];
    remoteTags = ["work", "side_project"];
    await pullChats();
    expect(tagStore[convs[0].id]).toEqual(["work", "side_project"]);

    convs[0].messages_stale = 1;
    remoteTags = [];
    await refreshChatMessages(convs[0].id);
    expect(tagStore[convs[0].id]).toEqual([]);
  });

  it("adding goes to the server first and takes its answer", async () => {
    const c = conv({ openwebui_chat_id: "S1" });
    convs = [c];
    remoteTags = ["work"];
    expect(await addChatTag(c, "Side Project")).toEqual({ synced: true });
    expect(api.addChatTag).toHaveBeenCalledWith("http://srv", "t", "S1", "side project");
    expect(tagStore[c.id]).toEqual(["work", "side_project"]);
  });

  it("a refused add or remove changes nothing locally", async () => {
    const c = conv({ openwebui_chat_id: "S1" });
    convs = [c];
    tagStore[c.id] = ["work"];
    api.addChatTag.mockRejectedValueOnce(new Error("500"));
    expect((await addChatTag(c, "new")).synced).toBe(false);
    api.removeChatTag.mockRejectedValueOnce(new Error("500"));
    expect((await removeChatTag(c, "work")).synced).toBe(false);
    expect(tagStore[c.id]).toEqual(["work"]);
  });

  it("removing sends the tag's label and stores the server's list", async () => {
    const c = conv({ openwebui_chat_id: "S1" });
    convs = [c];
    tagStore[c.id] = ["side_project", "work"];
    remoteTags = ["work"];
    await removeChatTag(c, "side_project");
    expect(api.removeChatTag).toHaveBeenCalledWith("http://srv", "t", "S1", "side project");
    expect(tagStore[c.id]).toEqual(["work"]);
  });

  it("tags of a chat that never reached the server stay local, and move over when it is created", async () => {
    const c = conv();
    convs = [c];
    session = null;
    await addChatTag(c, "Draft");
    expect(tagStore[c.id]).toEqual(["draft"]);
    expect(api.addChatTag).not.toHaveBeenCalled();

    session = { baseUrl: "http://srv", token: "t" };
    await pullChats();
    expect(api.addChatTag).toHaveBeenCalledWith("http://srv", "t", "S-new", "draft");
  });
});

describe("chat settings", () => {
  it("the clone takes the server's settings", async () => {
    remote = [server()];
    remoteParams = { system: "Be brief", temperature: 0.2, top_p: null, max_tokens: null, seed: null, stop: [] };
    await pullChats();
    expect(JSON.parse(convs[0].params!)).toMatchObject({ system: "Be brief", temperature: 0.2 });
  });

  it("a push carries the chat's settings along", async () => {
    convs = [
      conv({
        openwebui_chat_id: "S1",
        title: "From server",
        dirty: 1,
        server_updated_at: 2000,
        params: '{"system":"Be brief","temperature":0.4,"stop":["END"]}',
      }),
    ];
    remote = [server({ updatedAt: 2000 })];
    store.getMessages.mockResolvedValue([
      { id: "m1", role: "user", content: "hi", created_at: 1, openwebui_message_id: "s-m1", vote: null, feedback_id: null, attachments: null },
    ]);
    await pullChats();
    store.getMessages.mockResolvedValue([]);
    const args = api.updateChatContent.mock.calls[0] as unknown as unknown[];
    expect(args[7]).toEqual({ system: "Be brief", temperature: 0.4, top_p: null, max_tokens: null, seed: null, stop: ["END"] });
  });
});

describe("changes go to the server first", () => {
  it("rename: applied locally only after the server accepted it", async () => {
    const c = conv({ openwebui_chat_id: "S1", title: "Old" });
    convs = [c];
    expect(await renameChat(c, "New")).toEqual({ synced: true });
    expect(api.updateChatTitle).toHaveBeenCalledWith("http://srv", "t", "S1", "New");
    expect(convs[0].title).toBe("New");

    api.updateChatTitle.mockRejectedValueOnce(new Error("500"));
    const outcome = await renameChat(c, "Again");
    expect(outcome.synced).toBe(false);
    expect(convs[0]).toMatchObject({ title: "New", dirty: 0 });
  });

  it("rename without a session changes nothing", async () => {
    const c = conv({ openwebui_chat_id: "S1", title: "Old" });
    convs = [c];
    session = null;
    expect((await renameChat(c, "New")).synced).toBe(false);
    expect(convs[0].title).toBe("Old");
  });

  it("rename of a chat that never reached the server is purely local", async () => {
    const c = conv();
    convs = [c];
    session = null;
    expect(await renameChat(c, "x")).toEqual({ synced: true });
    expect(api.updateChatTitle).not.toHaveBeenCalled();
    expect(convs[0].title).toBe("x");
  });

  it("pin and archive push the flag and are not applied when the server refuses", async () => {
    const c = conv({ openwebui_chat_id: "S1" });
    convs = [c];
    await setChatPinned(c, true);
    expect(convs[0].pinned).toBe(1);
    expect(api.setChatFlag).toHaveBeenCalledWith("http://srv", "t", "S1", "pin", true);

    api.setChatFlag.mockRejectedValueOnce(new Error("500"));
    expect((await setChatArchived(c, true)).synced).toBe(false);
    expect(convs[0].archived).toBe(0);
  });

  it("delete removes the chat on the server and locally", async () => {
    const a = conv({ openwebui_chat_id: "S1" });
    const local = conv();
    convs = [a, local];
    expect(await deleteChat(a)).toEqual({ synced: true });
    expect(api.deleteChat).toHaveBeenCalledWith("http://srv", "t", "S1");
    expect(await deleteChat(local)).toEqual({ synced: true });
    expect(convs).toHaveLength(0);
    expect(api.deleteChat).toHaveBeenCalledTimes(1);
  });

  it("delete keeps the chat when the server cannot be reached", async () => {
    const a = conv({ openwebui_chat_id: "S1" });
    convs = [a];
    api.deleteChat.mockRejectedValueOnce(new Error("could not reach http://srv"));
    expect((await deleteChat(a)).synced).toBe(false);
    expect(convs).toHaveLength(1);
    expect(convs[0].deleted_pending).toBe(0);
  });

  it("delete treats a 404 from the server as success", async () => {
    const a = conv({ openwebui_chat_id: "S1" });
    convs = [a];
    api.deleteChat.mockRejectedValueOnce(new Error("folder request failed (404 Not Found): x"));
    expect(await deleteChat(a)).toEqual({ synced: true });
    expect(convs).toHaveLength(0);
  });
});

describe("refreshChatMessages", () => {
  it("fetches messages only for stale server chats", async () => {
    convs = [conv({ openwebui_chat_id: "S1", messages_stale: 1 }), conv({ openwebui_chat_id: "S2" })];
    remote = [server()];
    expect(await refreshChatMessages(convs[0].id)).toBe(true);
    expect(store.replaceMessagesFromServer).toHaveBeenCalledTimes(1);
    expect(await refreshChatMessages(convs[1].id)).toBe(false);
  });

  it("replaces unsent local messages with the server's copy", async () => {
    convs = [conv({ openwebui_chat_id: "S1", messages_stale: 1, dirty: 1 })];
    remote = [server()];
    expect(await refreshChatMessages(convs[0].id)).toBe(true);
    expect(convs[0].dirty).toBe(0);
  });
});

describe("syncWithServer", () => {
  it("runs folders then chats once for overlapping calls", async () => {
    pullFolders.mockResolvedValueOnce(true);
    const [a, b] = await Promise.all([syncWithServer(), syncWithServer()]);
    expect(a).toEqual({ changed: true, reachable: true });
    expect(b).toEqual({ changed: true, reachable: true });
    expect(pullFolders).toHaveBeenCalledTimes(1);
    expect(api.listChats).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable server", async () => {
    listError = new Error("could not reach http://srv");
    expect((await syncWithServer()).reachable).toBe(false);
  });
});
