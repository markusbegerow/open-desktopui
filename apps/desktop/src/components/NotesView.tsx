import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import MarkdownBody from "./MarkdownBody";
import { LibraryNote, listLibraryNotes } from "../lib/library";
import { LIBRARY_UPDATED_EVENT, createNote, removeNote, saveNote } from "../lib/librarySync";
import { useTranslation } from "../lib/i18n";

// The account's notes: a list on the left, an editor on the right. Notes are
// read from the local copy (so they open offline); saving and deleting go to
// the server first. A note changed on the server meanwhile is flagged instead
// of silently overwritten.
export default function NotesView({ onClose }: { onClose: () => void }) {
  const { t, language } = useTranslation();
  const [notes, setNotes] = useState<LibraryNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  // the `updated_at` of the note when the editor loaded it
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(0);
  const [serverChanged, setServerChanged] = useState(false);
  const [preview, setPreview] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const dirty = selected ? title !== selected.title || markdown !== selected.markdown : title !== "" || markdown !== "";

  const load = useCallback(async () => setNotes(await listLibraryNotes()), []);
  useEffect(() => {
    void load();
    window.addEventListener(LIBRARY_UPDATED_EVENT, load);
    return () => window.removeEventListener(LIBRARY_UPDATED_EVENT, load);
  }, [load]);

  // The list changed under an open note: follow the server unless there are
  // unsaved edits, in which case say so.
  useEffect(() => {
    if (!selected) return;
    if (selected.updated_at <= baseUpdatedAt) return;
    if (dirty) {
      setServerChanged(true);
    } else {
      setTitle(selected.title);
      setMarkdown(selected.markdown);
      setBaseUpdatedAt(selected.updated_at);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.updated_at]);

  function open(note: LibraryNote | null) {
    setSelectedId(note?.id ?? null);
    setTitle(note?.title ?? "");
    setMarkdown(note?.markdown ?? "");
    setBaseUpdatedAt(note?.updated_at ?? 0);
    setServerChanged(false);
    setPreview(false);
    setError(null);
  }

  async function save() {
    if (saving || (!dirty && selected)) return;
    setSaving(true);
    setError(null);
    const finalTitle = title.trim() || t("notes.untitled");
    const result = selected ? await saveNote(selected.id, finalTitle, markdown) : await createNote(finalTitle, markdown);
    setSaving(false);
    if (!result.outcome.synced || !result.note) {
      setError(`${t("notes.offline")} ${result.outcome.error ?? ""}`.trim());
      return;
    }
    await load();
    setSelectedId(result.note.id);
    setTitle(result.note.title);
    setMarkdown(result.note.markdown);
    setBaseUpdatedAt(result.note.updated_at);
    setServerChanged(false);
  }

  async function remove() {
    setConfirmDelete(false);
    if (!selected) return;
    const outcome = await removeNote(selected.id);
    if (!outcome.synced) {
      setError(`${t("notes.offline")} ${outcome.error ?? ""}`.trim());
      return;
    }
    await load();
    open(null);
  }

  // Leaving with unsaved edits asks first.
  function requestClose() {
    if (dirty) setConfirmLeave(true);
    else onClose();
  }

  const query = search.trim().toLowerCase();
  const visible = notes.filter(
    (n) => query === "" || n.title.toLowerCase().includes(query) || n.markdown.toLowerCase().includes(query),
  );

  return (
    <div className="view notes-view" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape" && !confirmDelete && !confirmLeave) {
        requestClose();
      }
    }}>
      <aside className="notes-list">
        <div className="notes-list-head">
          <h2>{t("notes.title")}</h2>
          <span className="notes-list-head-actions">
            <button type="button" onClick={() => open(null)}>
              + {t("notes.new")}
            </button>
            <button type="button" className="notes-close" onClick={requestClose} title={t("notes.close")} aria-label={t("notes.close")}>
              ×
            </button>
          </span>
        </div>
        <input
          type="text"
          className="sidebar-search"
          placeholder={t("notes.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {visible.length === 0 && <p className="hint">{t("notes.empty")}</p>}
        <ul>
          {visible.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`notes-list-item${n.id === selectedId ? " active" : ""}`}
                onClick={() => open(n)}
              >
                <span className="notes-list-title">
                  {n.pinned ? "📌 " : ""}
                  {n.title || t("notes.untitled")}
                </span>
                <span className="notes-list-date">{new Date(n.updated_at).toLocaleDateString(language)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="notes-editor">
        <input
          type="text"
          className="notes-title-input"
          placeholder={t("notes.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {serverChanged && (
          <p className="status-error">
            {t("notes.serverChanged")}{" "}
            <button type="button" onClick={() => selected && open(selected)}>
              {t("notes.loadServer")}
            </button>
          </p>
        )}
        {error && <p className="status-error">{error}</p>}
        {preview ? (
          <div className="notes-preview chat-message-content">
            <MarkdownBody text={markdown} />
          </div>
        ) : (
          <textarea
            className="notes-body-input"
            placeholder={t("notes.bodyPlaceholder")}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
        )}
        <div className="notes-actions">
          <button type="button" onClick={() => setPreview((v) => !v)}>
            {preview ? t("notes.edit") : t("notes.preview")}
          </button>
          <span className="hint notes-status">{dirty ? t("notes.unsaved") : ""}</span>
          {selected && (
            <button type="button" className="conversation-menu-delete" onClick={() => setConfirmDelete(true)}>
              {t("notes.delete")}
            </button>
          )}
          <button type="button" onClick={() => void save()} disabled={saving || (!dirty && !!selected) || (!selected && !title && !markdown)}>
            {saving ? t("notes.saving") : t("notes.save")}
          </button>
        </div>
      </section>

      {confirmLeave && (
        <ConfirmDialog
          title={t("notes.unsaved")}
          message={t("notes.leaveMessage")}
          confirmLabel={t("notes.leave")}
          danger
          onConfirm={() => {
            setConfirmLeave(false);
            onClose();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}

      {confirmDelete && selected && (
        <ConfirmDialog
          title={t("notes.delete")}
          message={`"${selected.title || t("notes.untitled")}": ${t("notes.deleteMessage")}`}
          confirmLabel={t("notes.delete")}
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
