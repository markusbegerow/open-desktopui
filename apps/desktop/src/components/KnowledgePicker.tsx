import { useEffect, useRef, useState } from "react";
import { KnowledgeBase } from "../lib/openWebUiClient";
import { useFloatingMenu } from "../lib/useFloatingMenu";

export interface KnowledgePickerProps {
  knowledgeBases: KnowledgeBase[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}

export default function KnowledgePicker({ knowledgeBases, selectedIds, onToggle }: KnowledgePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { triggerRef, menuRef, style } = useFloatingMenu<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    { axis: "vertical", placement: "auto", align: "right" }
  );

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const label =
    selectedIds.length === 0
      ? "Knowledge: none"
      : selectedIds.length === 1
        ? `Knowledge: ${knowledgeBases.find((kb) => kb.id === selectedIds[0])?.name ?? "1 selected"}`
        : `Knowledge: ${selectedIds.length} selected`;

  return (
    <div className="picker-dropdown" ref={rootRef}>
      <button ref={triggerRef} className="picker-toggle" onClick={() => setOpen((v) => !v)} type="button">
        {label} ▾
      </button>
      {open && (
        <div ref={menuRef} className="picker-menu" style={style}>
          {knowledgeBases.map((kb) => (
            <label className="picker-option" key={kb.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(kb.id)}
                onChange={() => onToggle(kb.id)}
              />
              {kb.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
