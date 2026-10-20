import { FormEvent, useState } from "react";
import { useTranslation } from "../lib/i18n";

export interface FolderDialogProps {
  mode: "create" | "edit";
  initialName?: string;
  initialSystemPrompt?: string;
  onSave: (name: string, systemPrompt: string) => void;
  onCancel: () => void;
}

// Name + system prompt for a folder, used both for creating (also as a
// subfolder) and for editing.
export default function FolderDialog({
  mode,
  initialName = "",
  initialSystemPrompt = "",
  onSave,
  onCancel,
}: FolderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave(name.trim(), systemPrompt.trim());
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal-box folder-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{mode === "create" ? t("folders.newFolder") : t("folders.edit")}</h3>
        <label className="folder-dialog-field">
          {t("folders.name")}
          <input
            type="text"
            value={name}
            placeholder={t("folders.namePlaceholder")}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="folder-dialog-field">
          {t("folders.systemPrompt")}
          <textarea rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </label>
        <p className="hint">{t("folders.systemPromptHint")}</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {t("confirmDialog.cancel")}
          </button>
          <button type="submit" disabled={!name.trim()}>
            {mode === "create" ? t("folders.create") : t("folders.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
