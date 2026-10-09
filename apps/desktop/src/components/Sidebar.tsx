import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import ConfirmDialog from "./ConfirmDialog";
import ConversationMenu from "./ConversationMenu";
import {
  Conversation,
  Group,
  createGroup,
  deleteConversation,
  getMessages,
  listConversations,
  listGroups,
  renameConversation,
  setConversationArchived,
  setConversationGroup,
  setConversationPinned,
  setConversationUnread,
} from "../lib/chatHistory";
import { getAppPrefs, setAppPrefs } from "../lib/settingsStore";
import { ensureSharedChat } from "../lib/openWebUiSync";
import { useTranslation } from "../lib/i18n";

export type View = "home" | "chat" | "settings";

export interface SidebarProps {
  view: View;
  activeConversationId: string | null;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onSelectView: (view: View) => void;
  refreshKey: number;
}

export default function Sidebar({
  view,
  activeConversationId,
  onNewChat,
  onSelectConversation,
  onSelectView,
  refreshKey,
}: SidebarProps) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  function refresh() {
    listConversations().then(setConversations);
    listGroups().then(setGroups);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    getAppPrefs().then((prefs) => setDisplayName(prefs?.displayName));
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
  const byGroup = groups.map((g) => ({
    group: g,
    items: filtered.filter((c) => !c.pinned && !c.archived && c.group_id === g.id),
  }));

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

  async function handleMoveToGroup(c: Conversation, groupId: string | null) {
    await setConversationGroup(c.id, groupId);
    refresh();
  }

  async function handleCreateGroupAndMove(c: Conversation, name: string) {
    const group = await createGroup(name);
    await setConversationGroup(c.id, group.id);
    refresh();
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

        {byGroup.map(({ group, items }) =>
          items.length > 0 ? (
            <div key={group.id}>
              <div className="sidebar-section-label">{group.name}</div>
              <div className="conversation-list">{items.map(renderConversation)}</div>
            </div>
          ) : null,
        )}

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

      <button className="sidebar-account" onClick={() => onSelectView("settings")} type="button">
        <span className="sidebar-account-avatar">{(displayName || "?")[0]?.toUpperCase()}</span>
        <span className="sidebar-account-name">{displayName || t("sidebar.account")}</span>
      </button>

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
