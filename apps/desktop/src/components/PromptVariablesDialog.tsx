import { FormEvent, useState } from "react";
import type { LibraryPrompt } from "../lib/library";
import { useTranslation } from "../lib/i18n";

export interface PromptVariablesDialogProps {
  prompt: LibraryPrompt;
  names: string[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

// Asks for the {{variables}} of a prompt before it is put into the message.
export default function PromptVariablesDialog({ prompt, names, onSubmit, onCancel }: PromptVariablesDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map((n) => [n, ""])));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(values);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal-box prompt-variables" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>
          /{prompt.command} <span className="hint">{prompt.name}</span>
        </h3>
        {names.map((name, i) => (
          <label key={name} className="folder-dialog-field">
            {name}
            <textarea
              rows={2}
              autoFocus={i === 0}
              value={values[name]}
              onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
              }}
            />
          </label>
        ))}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {t("confirmDialog.cancel")}
          </button>
          <button type="submit">{t("prompts.insert")}</button>
        </div>
      </form>
    </div>
  );
}
