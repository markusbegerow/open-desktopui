import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import ConfirmDialog from "./ConfirmDialog";
import ConversationMenu from "./ConversationMenu";
import {
  Conversation,
  Group,
  deleteConversation,
  getMessages,
  listConversations,
  listGroups,
  renameConversation,
  setConversationArchived,
  setConversationPinned,
  setConversationUnread,
} from "../lib/chatHistory";
import { getAppPrefs, setAppPrefs } from "../lib/settingsStore";
import { ensureSharedChat } from "../lib/openWebUiSync";
import { useTranslation } from "../lib/i18n";
import { avatarInitial, resolveAvatar } from "../lib/avatar";
import { FolderNode, buildFolderTree } from "../lib/folders";
import {
  SyncOutcome,
  createFolder,
  deleteFolder,
  moveConversationToFolder,
  setFolderExpanded,
  updateFolderDetails,
} from "../lib/folderSync";
import FolderDialog from "./FolderDialog";
import FolderMenu from "./FolderMenu";

export type View = "home" | "chat" | "settings";

export interface SidebarProps {
  view: View;
  activeConversationId: string | null;
  onNewChat: () => void;
  onNewChatInFolder: (folder: { id: string; name: string }) => void;
  onSelectConversation: (id: string) => void;
  onSelectView: (view: View) => void;
  refreshKey: number;
}

export default function Sidebar({
  view,
  activeConversationId,
  onNewChat,
  onNewChatInFolder,
  onSelectConversation,
  onSelectView,
  refreshKey,
}: SidebarProps) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [hideUsername, setHideUsername] = useState(false);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [folderDialog, setFolderDialog] = useState<
    { mode: "create"; parentId: string | null } | { mode: "edit"; group: Group } | null
  >(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<Group | null>(null);

  function refresh() {
    listConversations().then(setConversations);
    listGroups().then(setGroups);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    getAppPrefs().then((prefs) => {
      setDisplayName(prefs?.displayName);
      setAvatar(resolveAvatar(prefs));
      setHideUsername(prefs?.hideUsername ?? false);
    });
  }, [refreshKey]);

  useEffect(() => {
    getAppPrefs().then((prefs) => setCollapsed(prefs?.sidebarCollapsed ?? false));
  }, []);

  async function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    await setAppPrefs({ sidebarCollapsed: next });
  }

  const filtered = conversations.filter((c) =>
    (c.title || "New conversation").toLowerCase().includes(search.trim().toLowerCase()),
  );

  const pinned = filtered.filter((c) => c.pinned && !c.archived);
  const archived = filtered.filter((c) => c.archived);
  const ungrouped = filtered.filter((c) => !c.pinned && !c.archived && !c.group_id);
  const folderTree = buildFolderTree(groups);
  const searching = search.trim() !== "";
  const folderItems = (id: string) => filtered.filter((c) => !c.pinned && !c.archived && c.group_id === id);
  // While searching, hide folders (and their parents) that contain no match.
  const folderHasMatch = (node: FolderNode): boolean =>
    folderItems(node.group.id).length > 0 || node.children.some(folderHasMatch);

  function handleOpenInWindow(c: Conversation) {
    new WebviewWindow(`chat-${Date.now()}`, {
      url: `index.html?conversationId=${c.id}`,
      title: c.title || "Conversation",
    });
  }

  async function handleTogglePin(c: Conversation) {
    await setConversationPinned(c.id, !c.pinned);
    refresh();
  }

  async function handleToggleUnread(c: Conversation) {
    await setConversationUnread(c.id, !c.unread);
    refresh();
  }

  function handleStartRename(c: Conversation) {
    setRenamingId(c.id);
    setRenameValue(c.title || "");
  }

  async function commitRename() {
    if (renamingId && renameValue.trim()) {
      await renameConversation(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    refresh();
  }

  function reportSync(outcome: SyncOutcome) {
    if (outcome.synced) return;
    setShareStatus(`${t("folders.syncFailed")}${outcome.error ? `: ${outcome.error}` : ""}`);
    setTimeout(() => setShareStatus(null), 5000);
  }

  async function handleMoveToGroup(c: Conversation, groupId: string | null) {
    reportSync(await moveConversationToFolder(c, groupId));
    refresh();
  }

  async function handleCreateGroupAndMove(c: Conversation, name: string) {
    const { group, outcome } = await createFolder(name, null);
    reportSync(outcome);
    reportSync(await moveConversationToFolder(c, group.id));
    refresh();
  }

  async function handleSaveFolder(name: string, systemPrompt: string) {
    const dialog = folderDialog;
    setFolderDialog(null);
    if (!dialog) return;
    if (dialog.mode === "create") {
      const { group, outcome } = await createFolder(name, dialog.parentId);
      reportSync(outcome);
      if (systemPrompt) reportSync(await updateFolderDetails(group.id, { name, icon: null, systemPrompt }));
      if (dialog.parentId) await setFolderExpanded(dialog.parentId, true);
    } else {
      reportSync(
        await updateFolderDetails(dialog.group.id, {
          name,
          icon: dialog.group.icon,
          systemPrompt: systemPrompt || null,
        }),
      );
    }
    refresh();
  }

  async function confirmDeleteFolder() {
    const group = pendingDeleteFolder;
    setPendingDeleteFolder(null);
    if (!group) return;
    reportSync(await deleteFolder(group.id));
    refresh();
  }

  async function handleToggleFolder(group: Group) {
    // Optimistic: flip locally first so the tree responds immediately.
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, is_expanded: group.is_expanded ? 0 : 1 } : g)));
    reportSync(await setFolderExpanded(group.id, !group.is_expanded));
  }

  async function handleToggleArchive(c: Conversation) {
    const willArchive = !c.archived;
    await setConversationArchived(c.id, willArchive);
    if (willArchive && view === "chat" && activeConversationId === c.id) {
      onNewChat();
    }
    refresh();
  }

  async function handleOpenInOpenWebUi(c: Conversation) {
    setShareStatus("Opening in Open WebUI...");
    try {
      const { url } = await ensureSharedChat(c);
      refresh();
      await openUrl(url);
      setShareStatus(null);
    } catch (err) {
      setShareStatus(err instanceof Error ? err.message : String(err));
      setTimeout(() => setShareStatus(null), 4000);
    }
  }

  async function handleShareLink(c: Conversation) {
    setShareStatus("Preparing link...");
    try {
      const { url } = await ensureSharedChat(c);
      refresh();
      await navigator.clipboard.writeText(url);
      setShareStatus("Link copied");
    } catch (err) {
      setShareStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setTimeout(() => setShareStatus(null), 4000);
    }
  }

  async function handleExportConversation(c: Conversation) {
    try {
      const stored = await getMessages(c.id);
      const title = c.title || "New conversation";
      const lines = [`# ${title}`, ""];
      for (const m of stored) {
        lines.push(m.role === "user" ? "**You:**" : "**Assistant:**", "", m.content, "");
      }
      const safeName = title.replace(/[\\/:*?"<>|]/g, "_");
      const saved = await invoke<boolean>("save_text_file", {
        defaultName: `${safeName}.md`,
        filterName: "Markdown",
        extension: "md",
        content: lines.join("\n"),
      });
      if (!saved) return;
      setShareStatus("Exported");
    } catch (err) {
      setShareStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setTimeout(() => setShareStatus(null), 4000);
    }
  }

  function handleDelete(c: Conversation) {
    setPendingDelete(c);
  }

  async function confirmDelete() {
    const c = pendingDelete;
    setPendingDelete(null);
    if (!c) return;
    await deleteConversation(c.id);
    if (view === "chat" && activeConversationId === c.id) {
      onNewChat();
    }
    refresh();
  }

  function renderConversation(c: Conversation) {
    if (renamingId === c.id) {
      return (
        <input
          key={c.id}
          type="text"
          className="conversation-rename-input"
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenamingId(null);
          }}
        />
      );
    }

    const isActive = view === "chat" && activeConversationId === c.id;
    return (
      <div className="conversation-item-row" key={c.id}>
        <button
          className={`conversation-item${isActive ? " active" : ""}${c.unread ? " unread" : ""}`}
          onClick={() => onSelectConversation(c.id)}
          title={c.title}
        >
          {c.unread ? <span className="conversation-unread-dot" /> : null}
          {c.title || "New conversation"}
        </button>
        <ConversationMenu
          conversation={c}
          groups={groups}
          onOpenInWindow={() => handleOpenInWindow(c)}
          onTogglePin={() => handleTogglePin(c)}
          onToggleUnread={() => handleToggleUnread(c)}
          onRename={() => handleStartRename(c)}
          onMoveToGroup={(groupId) => handleMoveToGroup(c, groupId)}
          onCreateGroupAndMove={(name) => handleCreateGroupAndMove(c, name)}
          onToggleArchive={() => handleToggleArchive(c)}
          onDelete={() => handleDelete(c)}
          onOpenInOpenWebUi={() => handleOpenInOpenWebUi(c)}
          onCopyLink={() => handleShareLink(c)}
          onExport={() => handleExportConversation(c)}
        />
      </div>
    );
  }

  function renderFolder(node: FolderNode) {
    const { group } = node;
    if (searching && !folderHasMatch(node)) return null;
    const expanded = searching || !!group.is_expanded;
    const items = folderItems(group.id);
    return (
      <div key={group.id} className="folder" style={{ marginLeft: node.depth * 12 }}>
        <div className="folder-row">
          <button
            type="button"
            className="folder-toggle"
            onClick={() => handleToggleFolder(group)}
            aria-expanded={expanded}
            title={group.system_prompt ? `${group.name} — ${t("folders.systemPrompt")}` : group.name}
          >
            <span className="folder-chevron">{expanded ? "▾" : "▸"}</span>
            <span className="folder-name">{group.name}</span>
          </button>
          <FolderMenu
            onNewChat={() => onNewChatInFolder({ id: group.id, name: group.name })}
            onNewSubfolder={() => setFolderDialog({ mode: "create", parentId: group.id })}
            onEdit={() => setFolderDialog({ mode: "edit", group })}
            onDelete={() => setPendingDeleteFolder(group)}
          />
        </div>
        {expanded && (
          <>
            {node.children.map(renderFolder)}
            {items.length > 0 && <div className="conversation-list">{items.map(renderConversation)}</div>}
          </>
        )}
      </div>
    );
  }

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <button
        className="sidebar-toggle"
        type="button"
        onClick={toggleCollapsed}
        title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
      >
        {collapsed ? "»" : "«"}
      </button>
      {collapsed && (
        <button className="sidebar-new-chat-collapsed" type="button" onClick={onNewChat} title={t("sidebar.newChat")}>
          +
        </button>
      )}
      <div className="sidebar-scroll">
        <input
          type="text"
          className="sidebar-search"
          placeholder={t("sidebar.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <button className="new-chat-button" onClick={onNewChat}>
          {t("sidebar.newChat")}
        </button>

        {filtered.length === 0 && search.trim() !== "" && (
          <p className="hint sidebar-search-empty">{t("sidebar.noMatches")}</p>
        )}

        {shareStatus && <p className="hint sidebar-search-empty">{shareStatus}</p>}

        {pinned.length > 0 && (
          <>
            <div className="sidebar-section-label">{t("sidebar.pinned")}</div>
            <div className="conversation-list">{pinned.map(renderConversation)}</div>
          </>
        )}

        <div className="sidebar-section-label folder-section-label">
          <span>{t("folders.title")}</span>
          <button
            type="button"
            className="folder-add"
            title={t("folders.newFolder")}
            onClick={() => setFolderDialog({ mode: "create", parentId: null })}
          >
            +
          </button>
        </div>
        {folderTree.map(renderFolder)}

        {ungrouped.length > 0 && (
          <>
            <div className="sidebar-section-label">{t("sidebar.recent")}</div>
            <div className="conversation-list">{ungrouped.map(renderConversation)}</div>
          </>
        )}

        {archived.length > 0 && (
          <>
            <button className="sidebar-archived-toggle" type="button" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "▾" : "▸"} {t("sidebar.archived")} ({archived.length})
            </button>
            {showArchived && <div className="conversation-list">{archived.map(renderConversation)}</div>}
          </>
        )}
      </div>

      <button
        className="sidebar-account"
        onClick={() => onSelectView("settings")}
        title={displayName || t("sidebar.account")}
        type="button"
      >
        {avatar ? (
          <img className="sidebar-account-avatar" src={avatar} alt="" />
        ) : (
          <span className="sidebar-account-avatar">{avatarInitial(displayName)}</span>
        )}
        {!hideUsername && <span className="sidebar-account-name">{displayName || t("sidebar.account")}</span>}
      </button>

      {folderDialog && (
        <FolderDialog
          mode={folderDialog.mode}
          initialName={folderDialog.mode === "edit" ? folderDialog.group.name : ""}
          initialSystemPrompt={folderDialog.mode === "edit" ? (folderDialog.group.system_prompt ?? "") : ""}
          onSave={handleSaveFolder}
          onCancel={() => setFolderDialog(null)}
        />
      )}

      {pendingDeleteFolder && (
        <ConfirmDialog
          title={t("folders.delete")}
          message={`"${pendingDeleteFolder.name}": ${t("folders.deleteMessage")}`}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={confirmDeleteFolder}
          onCancel={() => setPendingDeleteFolder(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete chat"
          message={`Delete "${pendingDelete.title || "New conversation"}"? This can't be undone.`}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </nav>
  );
}
