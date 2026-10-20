import { useEffect, useRef, useState } from "react";
import { useFloatingMenu } from "../lib/useFloatingMenu";
import { useTranslation } from "../lib/i18n";

export interface FolderMenuProps {
  onNewChat: () => void;
  onNewSubfolder: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function FolderMenu({ onNewChat, onNewSubfolder, onEdit, onDelete }: FolderMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menu = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(open, () => setOpen(false), {
    axis: "vertical",
    placement: "down",
    align: "right",
  });

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="conversation-menu" ref={rootRef}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="conversation-menu-trigger"
        title={t("folders.folderOptions")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div
          ref={menu.menuRef}
          className="picker-menu conversation-menu-list"
          style={menu.style}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="picker-option" type="button" onClick={() => run(onNewChat)}>
            {t("folders.newChatHere")}
          </button>
          <button className="picker-option" type="button" onClick={() => run(onNewSubfolder)}>
            {t("folders.newSubfolder")}
          </button>
          <button className="picker-option" type="button" onClick={() => run(onEdit)}>
            {t("folders.edit")}
          </button>
          <hr className="picker-divider" />
          <button className="picker-option conversation-menu-delete" type="button" onClick={() => run(onDelete)}>
            {t("folders.delete")}
          </button>
        </div>
      )}
    </div>
  );
}
