// Keeps the sidebar's folders in step with the signed-in Open WebUI account.
//
// Local-first: every change is written to SQLite immediately and then pushed
// to the server best-effort. A change that doesn't reach the server marks the
// folder `dirty` and is retried by the next `pullFolders()`. With no session,
// or when the server's folders feature is disabled, everything keeps working
// locally.
import {
  Conversation,
  Group,
  applyServerGroupFields,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  renameGroup,
  setConversationGroup,
  setGroupDirty,
  setGroupExpanded,
  setGroupIcon,
  setGroupOpenWebUiFolderId,
  setGroupParent,
  setGroupSystemPrompt,
} from "./chatHistory";
import * as api from "./openWebUiClient";
import { getOpenWebUiConfig } from "./settingsStore";

export interface SyncOutcome {
  // false when the change is saved locally but couldn't be sent to the server
  synced: boolean;
  error?: string;
}

interface Session {
  baseUrl: string;
  token: string;
}

async function getSession(): Promise<Session | null> {
  const config = await getOpenWebUiConfig();
  if (!config?.baseUrl || !config.apiKey) return null;
  return { baseUrl: config.baseUrl.replace(/\/+$/, ""), token: config.apiKey };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs `push` for a folder that already exists on the server. Without a
// session there is nothing to do; if the push fails the folder is flagged so
// the next pull retries it.
async function pushExisting(
  group: Group,
  push: (session: Session, serverId: string) => Promise<void>,
): Promise<SyncOutcome> {
  if (!group.openwebui_folder_id) return { synced: true }; // not on the server yet; pull will create it
  const session = await getSession();
  if (!session) {
    await setGroupDirty(group.id, true);
    return { synced: false };
  }
  try {
    await push(session, group.openwebui_folder_id);
    return { synced: true };
  } catch (err) {
    await setGroupDirty(group.id, true);
    return { synced: false, error: errorText(err) };
  }
}

export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<{ group: Group; outcome: SyncOutcome }> {
  const group = await createGroup(name, parentId);
  const outcome = await pushNewFolder(group);
  return { group: (await getGroup(group.id)) ?? group, outcome };
}

async function pushNewFolder(group: Group): Promise<SyncOutcome> {
  const session = await getSession();
  if (!session) return { synced: true };
  try {
    const parent = group.parent_id ? await getGroup(group.parent_id) : null;
    // A parent that isn't on the server yet means this one can't be created
    // there either; pull creates both, parent first.
    if (group.parent_id && !parent?.openwebui_folder_id) return { synced: true };
    const created = await api.createFolder(
      session.baseUrl,
      session.token,
      group.name,
      parent?.openwebui_folder_id ?? null,
      group.system_prompt,
      group.icon,
    );
    await setGroupOpenWebUiFolderId(group.id, created.id);
    return { synced: true };
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
}

export async function updateFolderDetails(
  id: string,
  fields: { name: string; icon: string | null; systemPrompt: string | null },
): Promise<SyncOutcome> {
  await renameGroup(id, fields.name);
  await setGroupIcon(id, fields.icon);
  await setGroupSystemPrompt(id, fields.systemPrompt);
  const group = await getGroup(id);
  if (!group) return { synced: true };
  return pushExisting(group, (s, serverId) =>
    api.updateFolder(s.baseUrl, s.token, serverId, {
      name: fields.name,
      // The server merges `data`/`meta`, so an empty string is how a value is cleared.
      systemPrompt: fields.systemPrompt ?? "",
      icon: fields.icon ?? "",
    }),
  );
}

export async function moveFolder(id: string, parentId: string | null): Promise<SyncOutcome> {
  await setGroupParent(id, parentId);
  const [group, parent] = await Promise.all([getGroup(id), parentId ? getGroup(parentId) : Promise.resolve(null)]);
  if (!group) return { synced: true };
  return pushExisting(group, (s, serverId) =>
    api.updateFolderParent(s.baseUrl, s.token, serverId, parent?.openwebui_folder_id ?? null),
  );
}

export async function setFolderExpanded(id: string, expanded: boolean): Promise<SyncOutcome> {
  await setGroupExpanded(id, expanded);
  const group = await getGroup(id);
  if (!group) return { synced: true };
  return pushExisting(group, (s, serverId) => api.updateFolderExpanded(s.baseUrl, s.token, serverId, expanded));
}

// Deleting keeps the folder's chats (unfiled) and moves its subfolders up one
// level — on the server too, since it would otherwise delete the whole subtree.
export async function deleteFolder(id: string): Promise<SyncOutcome> {
  const group = await getGroup(id);
  if (!group) return { synced: true };
  const all = await listGroups();
  const children = all.filter((g) => g.parent_id === id);
  const newParent = group.parent_id ? all.find((g) => g.id === group.parent_id) : undefined;

  await deleteGroup(id);
  if (!group.openwebui_folder_id) return { synced: true };

  const session = await getSession();
  if (!session) return { synced: false };
  try {
    for (const child of children) {
      if (!child.openwebui_folder_id) continue;
      await api.updateFolderParent(
        session.baseUrl,
        session.token,
        child.openwebui_folder_id,
        newParent?.openwebui_folder_id ?? null,
      );
    }
    await api.deleteFolder(session.baseUrl, session.token, group.openwebui_folder_id);
    return { synced: true };
  } catch (err) {
    // The folder is gone locally but would reappear on the next pull.
    return { synced: false, error: errorText(err) };
  }
}

// Files a chat into a folder (or unfiles it with null). If the chat already
// exists on the server it is moved there as well; otherwise the folder is
// attached when the chat is first shared (see `ensureSharedChat`).
export async function moveConversationToFolder(
  conversation: Pick<Conversation, "id" | "openwebui_chat_id">,
  groupId: string | null,
): Promise<SyncOutcome> {
  await setConversationGroup(conversation.id, groupId);
  if (!conversation.openwebui_chat_id) return { synced: true };
  const session = await getSession();
  if (!session) return { synced: true };
  const group = groupId ? await getGroup(groupId) : null;
  if (groupId && !group?.openwebui_folder_id) return { synced: true };
  try {
    await api.moveChatToFolder(
      session.baseUrl,
      session.token,
      conversation.openwebui_chat_id,
      group?.openwebui_folder_id ?? null,
    );
    return { synced: true };
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
}

export async function serverFolderIdFor(groupId: string | null): Promise<string | null> {
  if (!groupId) return null;
  return (await getGroup(groupId))?.openwebui_folder_id ?? null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Reconciles local folders with the server's. Returns true if anything local
// changed (so the sidebar should reload). Never throws: the folders feature
// may be disabled or the server unreachable.
export async function pullFolders(): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;

  let server: api.ServerFolder[];
  try {
    server = await api.listFolders(session.baseUrl, session.token);
  } catch {
    return false;
  }

  let changed = false;
  try {
    let local = await listGroups();
    const serverById = new Map(server.map((f) => [f.id, f]));

    // 1. Folders deleted on the server disappear locally; dirty ones are re-pushed.
    for (const g of local) {
      if (!g.openwebui_folder_id) continue;
      const remote = serverById.get(g.openwebui_folder_id);
      if (!remote) {
        await deleteGroup(g.id);
        changed = true;
      }
    }
    local = await listGroups();
    const localByServerId = new Map(local.filter((g) => g.openwebui_folder_id).map((g) => [g.openwebui_folder_id!, g]));

    // 2. Folders that exist on the server but not locally: adopt a same-named
    //    unsynced local folder under the same parent, otherwise create one.
    //    Parents first, so a child can find its parent's local id.
    const pending = [...server.filter((f) => !localByServerId.has(f.id))];
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const remote = pending[i];
        const parentLocal = remote.parentId ? localByServerId.get(remote.parentId) : null;
        if (remote.parentId && !parentLocal) continue; // parent not mapped yet
        const parentLocalId = parentLocal?.id ?? null;
        const twin = local.find(
          (g) => !g.openwebui_folder_id && g.parent_id === parentLocalId && sameName(g.name, remote.name),
        );
        let target: Group;
        if (twin) {
          await setGroupOpenWebUiFolderId(twin.id, remote.id);
          target = { ...twin, openwebui_folder_id: remote.id };
          local = local.map((g) => (g.id === twin.id ? target : g));
        } else {
          target = await createGroup(remote.name, parentLocalId, {
            icon: remote.icon,
            system_prompt: remote.systemPrompt,
            is_expanded: remote.isExpanded,
            openwebui_folder_id: remote.id,
          });
          local.push(target);
        }
        localByServerId.set(remote.id, target);
        pending.splice(i, 1);
        progress = true;
        changed = true;
      }
    }

    // 3. Synced folders: push dirty ones, take the server's values for the rest.
    for (const g of local) {
      if (!g.openwebui_folder_id) continue;
      const remote = serverById.get(g.openwebui_folder_id);
      if (!remote) continue;
      if (g.dirty) {
        try {
          const parent = g.parent_id ? local.find((p) => p.id === g.parent_id) : null;
          await api.updateFolder(session.baseUrl, session.token, remote.id, {
            name: g.name,
            systemPrompt: g.system_prompt ?? "",
            icon: g.icon ?? "",
          });
          await api.updateFolderParent(session.baseUrl, session.token, remote.id, parent?.openwebui_folder_id ?? null);
          await api.updateFolderExpanded(session.baseUrl, session.token, remote.id, !!g.is_expanded);
          await setGroupDirty(g.id, false);
        } catch {
          // still dirty; retried next time
        }
        continue;
      }
      const parentLocal = remote.parentId ? localByServerId.get(remote.parentId) : null;
      const next = {
        name: remote.name,
        parent_id: parentLocal?.id ?? null,
        icon: remote.icon,
        is_expanded: remote.isExpanded,
        system_prompt: remote.systemPromptKnown ? remote.systemPrompt : undefined,
      };
      const differs =
        g.name !== next.name ||
        g.parent_id !== next.parent_id ||
        g.icon !== next.icon ||
        !!g.is_expanded !== next.is_expanded ||
        (next.system_prompt !== undefined && (g.system_prompt ?? null) !== (next.system_prompt ?? null));
      if (differs) {
        await applyServerGroupFields(g.id, next);
        changed = true;
      }
    }

    // 4. Local folders the server doesn't know yet get created there, parents first.
    let unsynced = local.filter((g) => !g.openwebui_folder_id);
    progress = true;
    while (unsynced.length > 0 && progress) {
      progress = false;
      for (const g of unsynced) {
        const fresh = await getGroup(g.id);
        if (!fresh || fresh.openwebui_folder_id) continue;
        const parent = fresh.parent_id ? await getGroup(fresh.parent_id) : null;
        if (fresh.parent_id && !parent?.openwebui_folder_id) continue;
        try {
          const created = await api.createFolder(
            session.baseUrl,
            session.token,
            fresh.name,
            parent?.openwebui_folder_id ?? null,
            fresh.system_prompt,
            fresh.icon,
          );
          await setGroupOpenWebUiFolderId(fresh.id, created.id);
          progress = true;
        } catch {
          // e.g. name clash or feature disabled; retried next time
        }
      }
      unsynced = (await listGroups()).filter((g) => !g.openwebui_folder_id);
    }
  } catch {
    // Local database trouble — leave things as they are.
  }
  return changed;
}
