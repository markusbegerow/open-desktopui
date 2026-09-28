import { useEffect, useRef, useState } from "react";
import { OpenWebUiModel } from "../lib/openWebUiClient";
import { useFloatingMenu } from "../lib/useFloatingMenu";

export interface ModelPickerProps {
  models: OpenWebUiModel[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export default function ModelPicker({ models, selectedId, onSelect, disabled }: ModelPickerProps) {
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

  const selectedModel = models.find((m) => m.id === selectedId);
  const label = selectedModel ? selectedModel.name : models.length === 0 ? "No models" : "Select model";

  return (
    <div className="picker-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        className="picker-toggle"
        onClick={() => setOpen((v) => !v)}
        type="button"
        disabled={disabled || models.length === 0}
      >
        {label} ▾
      </button>
      {open && (
        <div ref={menuRef} className="picker-menu" style={style}>
          {models.map((m) => (
            <button
              key={m.id}
              className={`picker-option${m.id === selectedId ? " active" : ""}`}
              onClick={() => {
                onSelect(m.id);
                setOpen(false);
              }}
              type="button"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
