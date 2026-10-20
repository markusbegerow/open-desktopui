import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "./chatHistory";

// --- in-memory stand-in for the groups table -------------------------------
let groups: Group[] = [];
let nextId = 1;
const conversationGroups = new Map<string, string | null>();

function find(id: string) {
  return groups.find((g) => g.id === id);
}

vi.mock("./chatHistory", () => ({
  listGroups: vi.fn(async () => groups.map((g) => ({ ...g }))),
  getGroup: vi.fn(async (id: string) => {
    const g = find(id);
    return g ? { ...g } : null;
  }),
  createGroup: vi.fn(async (name: string, parentId: string | null = null, fields: Record<string, unknown> = {}) => {
    const g: Group = {
      id: `L${nextId++}`,
      name,
      account_id: "acct",
      created_at: 0,
      parent_id: (fields.parent_id as string | null) ?? parentId,
      icon: (fields.icon as string | null) ?? null,
      system_prompt: (fields.system_prompt as string | null) ?? null,
      is_expanded: fields.is_expanded === false ? 0 : 1,
      openwebui_folder_id: (fields.openwebui_folder_id as string | null) ?? null,
      updated_at: 0,
      dirty: 0,
    };
    groups.push(g);
    return { ...g };
  }),
  deleteGroup: vi.fn(async (id: string) => {
    const g = find(id);
    for (const c of groups) if (c.parent_id === id) c.parent_id = g?.parent_id ?? null;
    for (const [k, v] of conversationGroups) if (v === id) conversationGroups.set(k, null);
    groups = groups.filter((x) => x.id !== id);
  }),
  renameGroup: vi.fn(async (id: string, name: string) => void (find(id)!.name = name)),
  setGroupIcon: vi.fn(async (id: string, icon: string | null) => void (find(id)!.icon = icon)),
  setGroupSystemPrompt: vi.fn(async (id: string, p: string | null) => void (find(id)!.system_prompt = p)),
  setGroupExpanded: vi.fn(async (id: string, e: boolean) => void (find(id)!.is_expanded = e ? 1 : 0)),
  setGroupParent: vi.fn(async (id: string, p: string | null) => void (find(id)!.parent_id = p)),
  setGroupDirty: vi.fn(async (id: string, d: boolean) => void (find(id)!.dirty = d ? 1 : 0)),
  setGroupOpenWebUiFolderId: vi.fn(async (id: string, s: string | null) => void (find(id)!.openwebui_folder_id = s)),
  applyServerGroupFields: vi.fn(
    async (
      id: string,
      f: { name: string; parent_id: string | null; icon: string | null; system_prompt?: string | null; is_expanded: boolean },
    ) => {
      const g = find(id)!;
      g.name = f.name;
      g.parent_id = f.parent_id;
      g.icon = f.icon;
      g.is_expanded = f.is_expanded ? 1 : 0;
      if (f.system_prompt !== undefined) g.system_prompt = f.system_prompt;
    },
  ),
  setConversationGroup: vi.fn(async (id: string, gid: string | null) => void conversationGroups.set(id, gid)),
}));

// --- fake Open WebUI folders API -------------------------------------------
type Remote = {
  id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  isExpanded: boolean;
  systemPrompt: string | null;
  systemPromptKnown: boolean;
};
let remote: Remote[] = [];
let remoteNext = 1;
let listShouldFail = false;
const api = {
  listFolders: vi.fn(async () => {
    if (listShouldFail) throw new Error("403");
    return remote.map((r) => ({ ...r }));
  }),
  createFolder: vi.fn(
    async (_b: string, _t: string, name: string, parentId: string | null, systemPrompt: string | null, icon: string | null) => {
      const r: Remote = {
        id: `S${remoteNext++}`,
        name,
        parentId,
        icon,
        isExpanded: false,
        systemPrompt,
        systemPromptKnown: true,
      };
      remote.push(r);
      return { ...r };
    },
  ),
  updateFolder: vi.fn(async (_b: string, _t: string, id: string, f: { name?: string; systemPrompt?: string; icon?: string }) => {
    const r = remote.find((x) => x.id === id)!;
    if (f.name !== undefined) r.name = f.name;
    if (f.systemPrompt !== undefined) r.systemPrompt = f.systemPrompt;
    if (f.icon !== undefined) r.icon = f.icon || null;
  }),
  updateFolderParent: vi.fn(async (_b: string, _t: string, id: string, parentId: string | null) => {
    remote.find((x) => x.id === id)!.parentId = parentId;
  }),
  updateFolderExpanded: vi.fn(async () => {}),
  deleteFolder: vi.fn(async (_b: string, _t: string, id: string) => {
    remote = remote.filter((x) => x.id !== id);
  }),
  moveChatToFolder: vi.fn(async () => {}),
};
vi.mock("./openWebUiClient", () => api);

let session: { baseUrl: string; apiKey: string } | null = { baseUrl: "https://owui.test/", apiKey: "tok" };
vi.mock("./settingsStore", () => ({ getOpenWebUiConfig: vi.fn(async () => session) }));

function addRemote(r: Partial<Remote> & { id: string; name: string }) {
  remote.push({ parentId: null, icon: null, isExpanded: false, systemPrompt: null, systemPromptKnown: true, ...r });
}

beforeEach(() => {
  groups = [];
  nextId = 1;
  remote = [];
  remoteNext = 1;
  listShouldFail = false;
  session = { baseUrl: "https://owui.test/", apiKey: "tok" };
  conversationGroups.clear();
  Object.values(api).forEach((f) => f.mockClear());
});

describe("pullFolders", () => {
  it("creates local folders from the server, parents before children", async () => {
    addRemote({ id: "S9", name: "Child", parentId: "S8" });
    addRemote({ id: "S8", name: "Parent", systemPrompt: "Be brief", icon: "star" });
    const { pullFolders } = await import("./folderSync");
    expect(await pullFolders()).toBe(true);
    const parent = groups.find((g) => g.name === "Parent")!;
    const child = groups.find((g) => g.name === "Child")!;
    expect(child.parent_id).toBe(parent.id);
    expect(parent.system_prompt).toBe("Be brief");
    expect(parent.icon).toBe("star");
    expect(parent.openwebui_folder_id).toBe("S8");
  });

  it("links an unsynced local folder with the same name instead of duplicating it", async () => {
    groups.push({ ...baseGroup("L0", "Work") });
    addRemote({ id: "S1", name: "work" });
    const { pullFolders } = await import("./folderSync");
    await pullFolders();
    expect(groups).toHaveLength(1);
    expect(groups[0].openwebui_folder_id).toBe("S1");
    expect(api.createFolder).not.toHaveBeenCalled();
  });

  it("removes folders that were deleted on the server and unfiles their chats", async () => {
    groups.push({ ...baseGroup("L0", "Gone"), openwebui_folder_id: "S404" });
    conversationGroups.set("c1", "L0");
    const { pullFolders } = await import("./folderSync");
    expect(await pullFolders()).toBe(true);
    expect(groups).toHaveLength(0);
    expect(conversationGroups.get("c1")).toBeNull();
  });

  it("pushes folders the server doesn't know yet, parents first", async () => {
    groups.push({ ...baseGroup("L2", "Child"), parent_id: "L1" }, { ...baseGroup("L1", "Parent") });
    const { pullFolders } = await import("./folderSync");
    await pullFolders();
    expect(remote.map((r) => r.name)).toEqual(["Parent", "Child"]);
    expect(remote[1].parentId).toBe(remote[0].id);
    expect(groups.every((g) => g.openwebui_folder_id)).toBe(true);
  });

  it("retries a dirty folder instead of overwriting it with the server's old values", async () => {
    addRemote({ id: "S1", name: "Old name" });
    groups.push({ ...baseGroup("L1", "New name"), openwebui_folder_id: "S1", dirty: 1 });
    const { pullFolders } = await import("./folderSync");
    await pullFolders();
    expect(remote[0].name).toBe("New name");
    expect(groups[0].name).toBe("New name");
    expect(groups[0].dirty).toBe(0);
  });

  it("keeps the local system prompt when the server's detail lookup failed", async () => {
    addRemote({ id: "S1", name: "A", systemPrompt: null, systemPromptKnown: false });
    groups.push({ ...baseGroup("L1", "A"), openwebui_folder_id: "S1", system_prompt: "mine" });
    const { pullFolders } = await import("./folderSync");
    await pullFolders();
    expect(groups[0].system_prompt).toBe("mine");
  });

  it("does nothing when signed out or when the folders feature is unavailable", async () => {
    groups.push({ ...baseGroup("L1", "Local only") });
    const { pullFolders } = await import("./folderSync");
    session = null;
    expect(await pullFolders()).toBe(false);
    session = { baseUrl: "https://owui.test", apiKey: "tok" };
    listShouldFail = true;
    expect(await pullFolders()).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].openwebui_folder_id).toBeNull();
  });
});

describe("mutations", () => {
  it("creating a folder pushes it and stores the server id", async () => {
    const { createFolder } = await import("./folderSync");
    const { group, outcome } = await createFolder("Ideas", null);
    expect(outcome.synced).toBe(true);
    expect(group.openwebui_folder_id).toBe("S1");
  });

  it("a failed push keeps the change locally and marks the folder dirty", async () => {
    groups.push({ ...baseGroup("L1", "A"), openwebui_folder_id: "S1" });
    api.updateFolder.mockRejectedValueOnce(new Error("offline"));
    const { updateFolderDetails } = await import("./folderSync");
    const outcome = await updateFolderDetails("L1", { name: "B", icon: null, systemPrompt: "x" });
    expect(outcome).toEqual({ synced: false, error: "offline" });
    expect(groups[0]).toMatchObject({ name: "B", system_prompt: "x", dirty: 1 });
  });

  it("deleting a folder re-parents its subfolders on the server before deleting it", async () => {
    addRemote({ id: "S1", name: "Top" });
    addRemote({ id: "S2", name: "Mid", parentId: "S1" });
    addRemote({ id: "S3", name: "Leaf", parentId: "S2" });
    groups.push(
      { ...baseGroup("L1", "Top"), openwebui_folder_id: "S1" },
      { ...baseGroup("L2", "Mid"), parent_id: "L1", openwebui_folder_id: "S2" },
      { ...baseGroup("L3", "Leaf"), parent_id: "L2", openwebui_folder_id: "S3" },
    );
    const { deleteFolder } = await import("./folderSync");
    const outcome = await deleteFolder("L2");
    expect(outcome.synced).toBe(true);
    expect(api.updateFolderParent).toHaveBeenCalledWith("https://owui.test", "tok", "S3", "S1");
    expect(api.deleteFolder).toHaveBeenCalledWith("https://owui.test", "tok", "S2");
    expect(groups.find((g) => g.id === "L3")!.parent_id).toBe("L1");
  });

  it("moves a chat on the server only if it was already shared", async () => {
    groups.push({ ...baseGroup("L1", "A"), openwebui_folder_id: "S1" });
    const { moveConversationToFolder } = await import("./folderSync");
    await moveConversationToFolder({ id: "c1", openwebui_chat_id: null }, "L1");
    expect(api.moveChatToFolder).not.toHaveBeenCalled();
    expect(conversationGroups.get("c1")).toBe("L1");
    await moveConversationToFolder({ id: "c2", openwebui_chat_id: "chat-2" }, "L1");
    expect(api.moveChatToFolder).toHaveBeenCalledWith("https://owui.test", "tok", "chat-2", "S1");
    await moveConversationToFolder({ id: "c2", openwebui_chat_id: "chat-2" }, null);
    expect(api.moveChatToFolder).toHaveBeenLastCalledWith("https://owui.test", "tok", "chat-2", null);
  });
});

function baseGroup(id: string, name: string): Group {
  return {
    id,
    name,
    account_id: "acct",
    created_at: 0,
    parent_id: null,
    icon: null,
    system_prompt: null,
    is_expanded: 1,
    openwebui_folder_id: null,
    updated_at: 0,
    dirty: 0,
  };
}
