import { ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "./SidebarIcons";
import { FOCUS_SEARCH_EVENT } from "../lib/shortcuts";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import ConfirmDialog from "./ConfirmDialog";
import ConversationMenu from "./ConversationMenu";
import {
  Conversation,
  Group,
  getMessages,
  listConversationTags,
  listConversations,
  listGroups,
  searchMessages,
  tagLabel,
} from "../lib/chatHistory";
import {
  CloneProgress,
  addChatTag,
  deleteChat,
  removeChatTag,
  renameChat,
  setChatArchived,
  setChatPinned,
  setChatUnread,
  subscribeCloneProgress,
} from "../lib/chatSync";
import { ChatDateGroup, activityTime, groupByDate, toggleSection } from "../lib/chatGroups";
import { relativeTimeParts } from "../lib/relativeTime";
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
import TagFilter from "./TagFilter";
import TagPicker from "./TagPicker";

export type View = "home" | "chat" | "notes" | "settings";

export interface SidebarProps {
  view: View;
  activeConversationId: string | null;
  onNewChat: () => void;
  onNewChatInFolder: (folder: { id: string; name: string }) => void;
  onSelectConversation: (id: string) => void;
  onSelectView: (view: View) => void;
  /** The notes panel is open next to the chat. */
  notesOpen: boolean;
  refreshKey: number;
  // false while Open WebUI can't be reached: chats are then shown from the local clone
  online?: boolean;
  // when the last successful sync finished (ms)
  lastSyncAt?: number | null;
  // a newer release exists (its version); clicking the hint opens the update page
  updateVersion?: string | null;
  onShowUpdate?: () => void;
}

export default function Sidebar({
  view,
  activeConversationId,
  onNewChat,
  onNewChatInFolder,
  onSelectConversation,
  onSelectView,
  notesOpen,
  refreshKey,
  online = true,
  lastSyncAt = null,
  updateVersion = null,
  onShowUpdate,
}: SidebarProps) {
  const { t, language } = useTranslation();
  const [cloneProgress, setCloneProgress] = useState<CloneProgress | null>(null);
  useEffect(() => subscribeCloneProgress(setCloneProgress), []);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [hideUsername, setHideUsername] = useState(false);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [folderDialog, setFolderDialog] = useState<
    { mode: "create"; parentId: string | null } | { mode: "edit"; group: Group } | null
  >(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<Group | null>(null);
  const [tagsByConversation, setTagsByConversation] = useState<Map<string, string[]>>(new Map());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [bodyHits, setBodyHits] = useState<Map<string, string>>(new Map());
  const [tagDialog, setTagDialog] = useState<Conversation | null>(null);
  // Where the last click happened: the tag dropdown opens there.
  const lastPointer = useRef({ x: 0, y: 0 });
  const [tagAnchor, setTagAnchor] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const track = (e: MouseEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousedown", track, true);
    return () => window.removeEventListener("mousedown", track, true);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [foldedSections, setFoldedSections] = useState<string[]>([]);

  useEffect(() => {
    getAppPrefs().then((prefs) => setFoldedSections(prefs?.collapsedSections ?? ["archived"]));
  }, []);

  function toggleFolded(key: string) {
    const next = toggleSection(foldedSections, key);
    setFoldedSections(next);
    void setAppPrefs({ collapsedSections: next });
  }

  function refresh() {
    listConversations().then(setConversations);
    listGroups().then(setGroups);
    listConversationTags().then(setTagsByConversation);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Message-text search runs on the local clone; a short pause after typing keeps it cheap.
  useEffect(() => {
    const text = search.trim();
    if (text.length < 2) {
      setBodyHits(new Map());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMessages(text)
        .then((hits) => {
          if (!cancelled) setBodyHits(new Map(hits.map((h) => [h.conversationId, h.snippet])));
        })
        .catch(() => {
          // the title / tag search still works
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, refreshKey]);

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

  // Ctrl/Cmd+K: open the sidebar if needed and focus the search box.
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusSearchPending, setFocusSearchPending] = useState(false);
  useEffect(() => {
    function onFocusSearch() {
      if (collapsed) {
        setCollapsed(false);
        void setAppPrefs({ sidebarCollapsed: false });
      }
      setSearchOpen(true);
      setFocusSearchPending(true);
    }
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
  }, [collapsed]);
  useEffect(() => {
    if (!focusSearchPending || collapsed) return;
    // the box only exists once the search is open; wait for the next render
    if (!searchRef.current) return;
    searchRef.current.focus();
    searchRef.current.select();
    setFocusSearchPending(false);
  }, [focusSearchPending, collapsed, searchOpen]);

  async function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    await setAppPrefs({ sidebarCollapsed: next });
  }

  // A search matches titles, tags and — through the local clone — message texts.
  const query = search.trim().toLowerCase();
  const matchesTitle = (c: Conversation) => (c.title || "New conversation").toLowerCase().includes(query);
  const matchesTag = (c: Conversation) => (tagsByConversation.get(c.id) ?? []).some((tag) => tagLabel(tag).includes(query));
  const filtered = conversations.filter(
    (c) =>
      (tagFilter === null || (tagsByConversation.get(c.id) ?? []).includes(tagFilter)) &&
      (query === "" || matchesTitle(c) || matchesTag(c) || bodyHits.has(c.id)),
  );
  const allTags = [...new Set([...tagsByConversation.values()].flat())].sort();
  const tagCounts = new Map<string, number>();
  for (const list of tagsByConversation.values()) for (const tag of list) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

  const pinned = filtered.filter((c) => c.pinned && !c.archived);
  const archived = filtered.filter((c) => c.archived);
  const ungrouped = filtered.filter((c) => !c.pinned && !c.archived && !c.group_id);
  const dateGroups = groupByDate(ungrouped);
  const folderTree = buildFolderTree(groups);
  const searching = query !== "" || tagFilter !== null;
  // A fold hides a section's chats, except while searching so no hit stays hidden.
  const isOpen = (key: string) => searching || !foldedSections.includes(key);
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
    const outcome = await setChatPinned(c, !c.pinned);
    refresh();
    reportChatAction(outcome);
  }

  async function handleAddTag(c: Conversation, name: string) {
    const outcome = await addChatTag(c, name);
    refresh();
    reportChatAction(outcome);
  }

  async function handleRemoveTag(c: Conversation, tag: string) {
    const outcome = await removeChatTag(c, tag);
    refresh();
    reportChatAction(outcome);
  }

  async function handleToggleUnread(c: Conversation) {
    const outcome = await setChatUnread(c, !c.unread);
    refresh();
    reportChatAction(outcome);
  }

  function handleStartRename(c: Conversation) {
    setRenamingId(c.id);
    setRenameValue(c.title || "");
  }

  async function commitRename() {
    const target = conversations.find((c) => c.id === renamingId);
    setRenamingId(null);
    if (target && renameValue.trim()) {
      const outcome = await renameChat(target, renameValue.trim());
      reportChatAction(outcome);
    }
    refresh();
  }

  function reportSync(outcome: SyncOutcome) {
    if (outcome.synced) return;
    setShareStatus(`${t("folders.syncFailed")}${outcome.error ? `: ${outcome.error}` : ""}`);
    setTimeout(() => setShareStatus(null), 5000);
  }

  // Chat changes go to the server first; a failure means nothing was changed.
  function reportChatAction(outcome: SyncOutcome) {
    if (outcome.synced) return;
    setShareStatus(`${t("sidebar.actionFailed")}${outcome.error ? `: ${outcome.error}` : ""}`);
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
    const outcome = await setChatArchived(c, willArchive);
    if (outcome.synced && willArchive && view === "chat" && activeConversationId === c.id) {
      onNewChat();
    }
    refresh();
    reportChatAction(outcome);
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

  // opendesktopui://chat/<id> opens the chat in this app on any device that has
  // the same account; the server's chat id is what they share.
  async function handleCopyAppLink(c: Conversation) {
    try {
      const { chatId } = await ensureSharedChat(c);
      refresh();
      await navigator.clipboard.writeText(`opendesktopui://chat/${chatId}`);
      setShareStatus(t("sidebar.appLinkCopied"));
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
    const outcome = await deleteChat(c);
    if (outcome.synced && view === "chat" && activeConversationId === c.id) {
      onNewChat();
    }
    refresh();
    reportChatAction(outcome);
  }

  function dateGroupLabel(group: ChatDateGroup<Conversation>): string {
    if (group.bucket === "month") {
      return new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(group.monthStart);
    }
    return t(`sidebar.dateGroups.${group.bucket}`);
  }

  function relativeLabel(at: number): string {
    const { unit, value } = relativeTimeParts(at);
    const word = t(`sidebar.relative.${unit}`);
    return unit === "now" ? word : `${value} ${word}`;
  }

  // A heading that folds the section below it.
  function sectionHeader(key: string, label: string, extra?: ReactNode) {
    const open = isOpen(key);
    return (
      <div className="sidebar-section-label">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          disabled={searching}
          onClick={() => toggleFolded(key)}
        >
          <span className={`section-chevron${open ? " open" : ""}`} aria-hidden="true" />
          <span>{label}</span>
        </button>
        {extra}
      </div>
    );
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
          {query !== "" && !matchesTitle(c) && bodyHits.get(c.id) && (
            <span className="conversation-snippet">{bodyHits.get(c.id)}</span>
          )}
        </button>
        <span className="conversation-time">{relativeLabel(activityTime(c))}</span>
        <ConversationMenu
          conversation={c}
          groups={groups}
          onOpenInWindow={() => handleOpenInWindow(c)}
          onTogglePin={() => handleTogglePin(c)}
          onToggleUnread={() => handleToggleUnread(c)}
          onRename={() => handleStartRename(c)}
          onEditTags={() => {
            setTagAnchor(lastPointer.current);
            setTagDialog(c);
          }}
          onMoveToGroup={(groupId) => handleMoveToGroup(c, groupId)}
          onCreateGroupAndMove={(name) => handleCreateGroupAndMove(c, name)}
          onToggleArchive={() => handleToggleArchive(c)}
          onDelete={() => handleDelete(c)}
          onOpenInOpenWebUi={() => handleOpenInOpenWebUi(c)}
          onCopyLink={() => handleShareLink(c)}
          onCopyAppLink={() => handleCopyAppLink(c)}
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
            <Icon name="folder" />
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
            {items.length === 0 && node.children.length === 0 && (
              <div className="folder-empty">{t("sidebar.noChats")}</div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <span className="sidebar-brand">
          <img className="sidebar-brand-logo" src="/logo.png" alt="" />
          <span className="sidebar-brand-name">Open DesktopUI</span>
        </span>
        <button
          className="sidebar-toggle"
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        >
          <Icon name="panel" size={18} />
        </button>
      </div>
      {collapsed && (
        <button className="sidebar-new-chat-collapsed" type="button" onClick={onNewChat} title={t("sidebar.newChat")}>
          <Icon name="newChat" size={18} />
        </button>
      )}
      <div className="sidebar-scroll">
        <div className="sidebar-nav">
          <button type="button" className="sidebar-nav-button" onClick={onNewChat}>
            <Icon name="newChat" />
            {t("sidebar.newChat")}
          </button>
          <button
            type="button"
            className={`sidebar-nav-button${searchOpen || search !== "" ? " active" : ""}`}
            onClick={() => {
              setSearchOpen(true);
              setFocusSearchPending(true);
            }}
          >
            <Icon name="search" />
            {t("sidebar.search")}
          </button>
          <button
            type="button"
            className={`sidebar-nav-button${notesOpen ? " active" : ""}`}
            aria-pressed={notesOpen}
            onClick={() => onSelectView("notes")}
          >
            <Icon name="notes" />
            {t("notes.title")}
          </button>
        </div>

        {(searchOpen || search !== "") && (
          <input
            ref={searchRef}
            type="text"
            className="sidebar-search"
            placeholder={t("sidebar.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => {
              if (search === "") setSearchOpen(false);
            }}
          />
        )}

        {allTags.length > 0 && (
          <TagFilter tags={allTags} counts={tagCounts} selected={tagFilter} onSelect={setTagFilter} />
        )}

        {filtered.length === 0 && search.trim() !== "" && (
          <p className="hint sidebar-search-empty">{t("sidebar.noMatches")}</p>
        )}

        {!online && (
          <p className="hint sidebar-search-empty">
            {t("sidebar.offline")}
            {lastSyncAt ? ` · ${t("sidebar.lastSynced")} ${new Date(lastSyncAt).toLocaleTimeString(language)}` : ""}
          </p>
        )}
        {online && cloneProgress && (
          <p className="hint sidebar-search-empty">
            {t("sidebar.syncing")} {cloneProgress.done}/{cloneProgress.total}
          </p>
        )}

        {shareStatus && <p className="hint sidebar-search-empty">{shareStatus}</p>}

        {pinned.length > 0 && (
          <>
            {sectionHeader("pinned", t("sidebar.pinned"))}
            {isOpen("pinned") && <div className="conversation-list">{pinned.map(renderConversation)}</div>}
          </>
        )}

        {sectionHeader(
          "folders",
          t("folders.title"),
          <button
            type="button"
            className="folder-add"
            title={t("folders.newFolder")}
            onClick={() => setFolderDialog({ mode: "create", parentId: null })}
          >
            +
          </button>,
        )}
        {isOpen("folders") && folderTree.map(renderFolder)}

        {(dateGroups.length > 0 || !searching) && sectionHeader("chats", t("sidebar.chats"))}
        {isOpen("chats") &&
          dateGroups.map((group) => (
            <div key={group.key}>
              <div className="sidebar-group-label">{dateGroupLabel(group)}</div>
              <div className="conversation-list">{group.items.map(renderConversation)}</div>
            </div>
          ))}

        {archived.length > 0 && (
          <>
            {sectionHeader("archived", `${t("sidebar.archived")} (${archived.length})`)}
            {isOpen("archived") && <div className="conversation-list">{archived.map(renderConversation)}</div>}
          </>
        )}
      </div>

      {updateVersion && onShowUpdate && (
        <button type="button" className="sidebar-update" onClick={onShowUpdate}>
          ⬆ {t("updates.available")} {updateVersion}
        </button>
      )}

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

      {tagDialog && (
        <TagPicker
          title={tagDialog.title || "New conversation"}
          allTags={allTags}
          anchor={tagAnchor}
          tags={tagsByConversation.get(tagDialog.id) ?? []}
          onAdd={(name) => handleAddTag(tagDialog, name)}
          onRemove={(tag) => handleRemoveTag(tagDialog, tag)}
          onClose={() => setTagDialog(null)}
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
