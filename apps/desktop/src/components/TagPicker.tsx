import { FormEvent, useEffect, useRef, useState } from "react";
import { tagLabel } from "../lib/chatHistory";
import { useTranslation } from "../lib/i18n";

export interface TagPickerProps {
  title: string;
  /** Every tag that exists, so one can be ticked for this chat. */
  allTags: string[];
  /** The tags this chat has. */
  tags: string[];
  /** Where the dropdown opens (the click that asked for it). */
  anchor: { x: number; y: number };
  // The parent applies the change (server first) and passes the new `tags` back.
  onAdd: (name: string) => void;
  onRemove: (tag: string) => void;
  onClose: () => void;
}

const WIDTH = 260;

// Dropdown to tick the tags of one chat, or to create a new one.
export default function TagPicker({ title, allTags, tags, anchor, onAdd, onRemove, onClose }: TagPickerProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    if (!tags.some((tag) => tagLabel(tag) === tagLabel(value))) onAdd(value);
    setName("");
  }

  // A tag created a moment ago is not in `allTags` until the parent refreshes,
  // so the chat's own tags are listed too.
  const options = [...new Set([...allTags, ...tags])].sort();
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 320));

  return (
    <div ref={rootRef} className="tag-picker" style={{ left, top, width: WIDTH }} role="dialog" aria-label={t("tags.title")}>
      <p className="hint tag-picker-chat">{title}</p>
      <form onSubmit={submit}>
        <input
          type="text"
          value={name}
          placeholder={t("tags.addPlaceholder")}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </form>
      <div className="tag-picker-list">
        {options.length === 0 && <span className="hint">{t("tags.none")}</span>}
        {options.map((tag) => {
          const checked = tags.includes(tag);
          return (
            <label key={tag} className="picker-option">
              <input type="checkbox" checked={checked} onChange={() => (checked ? onRemove(tag) : onAdd(tagLabel(tag)))} />
              {tagLabel(tag)}
            </label>
          );
        })}
      </div>
    </div>
  );
}
