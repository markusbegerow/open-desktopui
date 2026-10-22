import { useEffect, useRef, useState } from "react";
import { tagLabel } from "../lib/chatHistory";
import { useTranslation } from "../lib/i18n";
import { useFloatingMenu } from "../lib/useFloatingMenu";

export interface TagFilterProps {
  tags: string[];
  /** How many chats carry each tag. */
  counts: Map<string, number>;
  selected: string | null;
  onSelect: (tag: string | null) => void;
}

// One dropdown instead of a row of chips: pick a tag to show only its chats.
export default function TagFilter({ tags, counts, selected, onSelect }: TagFilterProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { triggerRef, menuRef, style } = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    { axis: "vertical", placement: "auto", align: "left" },
  );

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function choose(tag: string | null) {
    onSelect(tag);
    setOpen(false);
  }

  return (
    <div className="picker-dropdown tag-filter" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`picker-toggle${selected ? " active" : ""}`}
        aria-expanded={open}
        title={t("tags.filter")}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? `${t("tags.title")}: ${tagLabel(selected)}` : t("tags.title")} ▾
      </button>
      {open && (
        <div ref={menuRef} className="picker-menu" style={style}>
          <button type="button" className={`picker-option${selected === null ? " active" : ""}`} onClick={() => choose(null)}>
            {t("tags.all")}
          </button>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`picker-option${selected === tag ? " active" : ""}`}
              onClick={() => choose(selected === tag ? null : tag)}
            >
              <span className="options-row-label">{tagLabel(tag)}</span>
              <span className="hint">{counts.get(tag) ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
