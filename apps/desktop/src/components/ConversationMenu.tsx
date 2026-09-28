import { useEffect, useRef, useState } from "react";
import { Conversation, Group } from "../lib/chatHistory";
import { useFloatingMenu } from "../lib/useFloatingMenu";

export interface ConversationMenuProps {
  conversation: Conversation;
  groups: Group[];
  onOpenInWindow: () => void;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onRename: () => void;
  onMoveToGroup: (groupId: string | null) => void;
  onCreateGroupAndMove: (name: string) => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onOpenInOpenWebUi: () => void;
  onCopyLink: () => void;
  onExport: () => void;
}

export default function ConversationMenu({
  conversation,
  groups,
  onOpenInWindow,
  onTogglePin,
  onToggleUnread,
  onRename,
  onMoveToGroup,
  onCreateGroupAndMove,
  onToggleArchive,
  onDelete,
  onOpenInOpenWebUi,
  onCopyLink,
  onExport,
}: ConversationMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const mainMenu = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(menuOpen, closeAll, {
    axis: "vertical",
    placement: "down",
    align: "right",
  });
  const subMenu = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(submenuOpen, closeSubmenu, {
    axis: "horizontal",
    placement: "right",
    align: "top",
  });
  const openInMenu = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(openInMenuOpen, closeOpenInSubmenu, {
    axis: "horizontal",
    placement: "right",
    align: "top",
  });
  const triggerRef = mainMenu.triggerRef;
  const groupItemRef = subMenu.triggerRef;
  const openInItemRef = openInMenu.triggerRef;

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeAll();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  function closeAll() {
    setMenuOpen(false);
    setSubmenuOpen(false);
    setOpenInMenuOpen(false);
    setNewGroupName("");
  }

  function closeSubmenu() {
    setSubmenuOpen(false);
  }

  function closeOpenInSubmenu() {
    setOpenInMenuOpen(false);
  }

  function toggleMenu() {
    setMenuOpen((v) => {
      if (v) {
        setSubmenuOpen(false);
        setOpenInMenuOpen(false);
      }
      return !v;
    });
  }

  function toggleSubmenu() {
    setOpenInMenuOpen(false);
    setSubmenuOpen((v) => !v);
  }

  function toggleOpenInSubmenu() {
    setSubmenuOpen(false);
    setOpenInMenuOpen((v) => !v);
  }

  function run(action: () => void) {
    action();
    closeAll();
  }

  return (
    <div className="conversation-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-menu-trigger"
        onClick={(e) => {
          e.stopPropagation();
          toggleMenu();
        }}
        title="More options"
      >
        ⋮
      </button>
      {menuOpen && (
        <div
          ref={mainMenu.menuRef}
          className="picker-menu conversation-menu-list"
          style={mainMenu.style}
          onClick={(e) => e.stopPropagation()}
        >
          <button ref={openInItemRef} className="picker-option" type="button" onClick={toggleOpenInSubmenu}>
            Open in ▸
          </button>
          <hr className="picker-divider" />
          <button className="picker-option" type="button" onClick={() => run(onTogglePin)}>
            {conversation.pinned ? "Unpin" : "Pin"}
          </button>
          <button className="picker-option" type="button" onClick={() => run(onToggleUnread)}>
            {conversation.unread ? "Mark as read" : "Mark as unread"}
          </button>
          <button className="picker-option" type="button" onClick={() => run(onRename)}>
            Rename
          </button>
          <button className="picker-option" type="button" onClick={() => run(onCopyLink)}>
            Share Link
          </button>
          <button className="picker-option" type="button" onClick={() => run(onExport)}>
            Export...
          </button>
          <hr className="picker-divider" />

          <button ref={groupItemRef} className="picker-option" type="button" onClick={toggleSubmenu}>
            Move to group ▸
          </button>
          <hr className="picker-divider" />

          <button className="picker-option" type="button" onClick={() => run(onToggleArchive)}>
            {conversation.archived ? "Unarchive" : "Archive"}
          </button>
          <button className="picker-option conversation-menu-delete" type="button" onClick={() => run(onDelete)}>
            Delete
          </button>
        </div>
      )}
      {menuOpen && openInMenuOpen && (
        <div
          ref={openInMenu.menuRef}
          className="picker-menu conversation-menu-submenu"
          style={openInMenu.style}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="picker-option" type="button" onClick={() => run(onOpenInWindow)}>
            New window
          </button>
          <button className="picker-option" type="button" onClick={() => run(onOpenInOpenWebUi)}>
            Open WebUI
          </button>
        </div>
      )}
      {menuOpen && submenuOpen && (
        <div
          ref={subMenu.menuRef}
          className="picker-menu conversation-menu-submenu"
          style={subMenu.style}
          onClick={(e) => e.stopPropagation()}
        >
          {conversation.group_id && (
            <button className="picker-option" type="button" onClick={() => run(() => onMoveToGroup(null))}>
              No group
            </button>
          )}
          {groups
            .filter((g) => g.id !== conversation.group_id)
            .map((g) => (
              <button
                className="picker-option"
                type="button"
                key={g.id}
                onClick={() => run(() => onMoveToGroup(g.id))}
              >
                {g.name}
              </button>
            ))}
          <form
            className="conversation-menu-new-group"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newGroupName.trim()) return;
              run(() => onCreateGroupAndMove(newGroupName.trim()));
            }}
          >
            <input
              type="text"
              placeholder="New group..."
              value={newGroupName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNewGroupName(e.target.value)}
            />
          </form>
        </div>
      )}
    </div>
  );
}
