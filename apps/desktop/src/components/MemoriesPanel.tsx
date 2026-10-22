import { FormEvent, useCallback, useEffect, useState } from "react";
import { LibraryMemory, listLibraryMemories } from "../lib/library";
import { LIBRARY_UPDATED_EVENT, createMemory, removeMemory, saveMemory } from "../lib/librarySync";
import { useTranslation } from "../lib/i18n";

// What Open WebUI remembers about the user (Settings → Memory). Read from the
// local copy; every change goes to the server first.
export default function MemoriesPanel() {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<LibraryMemory[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setMemories(await listLibraryMemories()), []);
  useEffect(() => {
    void load();
    window.addEventListener(LIBRARY_UPDATED_EVENT, load);
    return () => window.removeEventListener(LIBRARY_UPDATED_EVENT, load);
  }, [load]);

  async function run(action: () => Promise<{ synced: boolean; error?: string }>): Promise<boolean> {
    setError(null);
    const outcome = await action();
    if (!outcome.synced) {
      setError(outcome.error ?? "Could not reach Open WebUI");
      return false;
    }
    await load();
    return true;
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await run(() => createMemory(text))) setDraft("");
  }

  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    if (await run(() => saveMemory(id, text))) setEditingId(null);
  }

  return (
    <fieldset>
      <legend>{t("memories.title")}</legend>
      <p className="hint">{t("memories.hint")}</p>
      <form className="row memory-add" onSubmit={add}>
        <input type="text" value={draft} placeholder={t("memories.placeholder")} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim()}>
          {t("memories.add")}
        </button>
      </form>
      {error && <p className="status-error">{error}</p>}
      {memories.length === 0 && <p className="hint">{t("memories.empty")}</p>}
      <ul className="memory-list">
        {memories.map((m) => (
          <li key={m.id}>
            {editingId === m.id ? (
              <>
                <textarea rows={2} value={editText} autoFocus onChange={(e) => setEditText(e.target.value)} />
                <button type="button" onClick={() => void saveEdit(m.id)} disabled={!editText.trim()}>
                  {t("memories.save")}
                </button>
              </>
            ) : (
              <>
                <span className="memory-text">{m.content}</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(m.id);
                    setEditText(m.content);
                  }}
                >
                  {t("memories.edit")}
                </button>
                <button type="button" className="conversation-menu-delete" onClick={() => void run(() => removeMemory(m.id))}>
                  {t("memories.delete")}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
