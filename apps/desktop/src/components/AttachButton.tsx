import { ReactNode, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ALLOWED_EXTENSIONS, classifyAttachment, isRejected, PendingAttachment } from "../lib/attachments";
import { getMessages, listConversations } from "../lib/chatHistory";
import {
  captureScreenshot,
  chatTranscript,
  htmlToText,
  imageAttachment,
  markdownAttachment,
  serverFileAttachment,
} from "../lib/contextAttachments";
import { useTranslation } from "../lib/i18n";
import { listLibraryNotes } from "../lib/library";
import { fetchWebPage, listServerFiles } from "../lib/openWebUiClient";
import type { KnowledgeBase } from "../lib/openWebUiClient";
import { getOpenWebUiConfig } from "../lib/settingsStore";

export interface AttachButtonProps {
  onAdd: (attachments: PendingAttachment[]) => void;
  onError: (message: string) => void;
  /** When given, the menu also offers these knowledge bases for the chat. */
  knowledgeBases?: KnowledgeBase[];
  selectedKnowledgeIds?: string[];
  onToggleKnowledge?: (id: string) => void;
}

type View = "root" | "web" | "files" | "notes" | "knowledge" | "chats";

interface Entry {
  id: string;
  label: string;
  /** What choosing the entry attaches. */
  attach: () => Promise<PendingAttachment>;
}

// Screen capture works in the Windows webview; the macOS and Linux ones often
// lack it, so the menu entry only shows where the browser API exists.
const canCaptureScreen = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
);

const chevron = (
  <svg className="options-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The "+" button: a menu above it for everything that can go into the next
// message — files, a screenshot, a web page, notes, chats and knowledge bases.
export default function AttachButton({
  onAdd,
  onError,
  knowledgeBases = [],
  selectedKnowledgeIds = [],
  onToggleKnowledge,
}: AttachButtonProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<View>("root");
  const [entries, setEntries] = useState<Entry[] | null>(null); // null while loading
  const [filter, setFilter] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function handleUpload() {
    setMenuOpen(false);
    const selection = await open({
      multiple: true,
      filters: [{ name: "Documents & Images", extensions: ALLOWED_EXTENSIONS }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    const results = paths.map(classifyAttachment);
    const accepted = results.filter((r): r is PendingAttachment => !isRejected(r));
    const rejected = results.filter(isRejected);
    if (accepted.length) onAdd(accepted);
    if (rejected.length) onError(rejected.map((r) => r.rejected).join(" "));
  }

  async function handleCapture() {
    setMenuOpen(false);
    try {
      onAdd([await imageAttachment(await captureScreenshot(), "Screenshot")]);
    } catch (err) {
      // Closing the system's "share your screen" picker is not an error.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      onError(errorText(err));
    }
  }

  async function handleWeb() {
    const address = url.trim();
    if (!address) return;
    setBusy(true);
    try {
      const { title, text } = htmlToText(await fetchWebPage(address));
      if (!text) throw new Error("The page has no readable text.");
      onAdd([await markdownAttachment(title || address, `# ${title || address}\n\nSource: ${address}\n\n${text}\n`)]);
      setUrl("");
      setMenuOpen(false);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // Opens a list page and fills it; `load` runs once per opening.
  function openList(next: View, load: () => Promise<Entry[]>) {
    setView(next);
    setFilter("");
    setEntries(null);
    load()
      .then(setEntries)
      .catch((err) => {
        onError(errorText(err));
        setEntries([]);
      });
  }

  async function serverSession() {
    const config = await getOpenWebUiConfig();
    if (!config?.baseUrl) throw new Error("Configure your Open WebUI server in Settings first.");
    return { baseUrl: config.baseUrl.replace(/\/+$/, ""), token: config.apiKey };
  }

  const loadFiles = async (): Promise<Entry[]> => {
    const { baseUrl, token } = await serverSession();
    return (await listServerFiles(baseUrl, token)).map((f) => ({
      id: f.id,
      label: f.filename,
      attach: async () => serverFileAttachment(f),
    }));
  };
  const loadNotes = async (): Promise<Entry[]> =>
    (await listLibraryNotes()).map((n) => ({
      id: n.id,
      label: n.title || "Untitled",
      attach: () => markdownAttachment(n.title || "Note", `# ${n.title}\n\n${n.markdown}\n`),
    }));
  const loadChats = async (): Promise<Entry[]> =>
    (await listConversations()).map((c) => ({
      id: c.id,
      label: c.title,
      attach: async () => markdownAttachment(c.title, chatTranscript(c.title, await getMessages(c.id))),
    }));

  async function choose(entry: Entry) {
    setBusy(true);
    try {
      onAdd([await entry.attach()]);
      setMenuOpen(false);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const back = (label: string) => (
    <button type="button" className="options-back" onClick={() => setView("root")}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{label}</span>
    </button>
  );

  const row = (label: string, glyph: ReactNode, onClick: () => void, opts?: { sub?: boolean; count?: number }) => (
    <button type="button" className="options-row" onClick={onClick}>
      {glyph}
      <span className="options-row-label">{label}</span>
      {!!opts?.count && <span className="options-count">{opts.count}</span>}
      {opts?.sub && chevron}
    </button>
  );

  const hasKnowledge = knowledgeBases.length > 0 && !!onToggleKnowledge;
  const listTitle: Record<string, string> = {
    files: t("composer.attachFiles"),
    notes: t("composer.attachNotes"),
    chats: t("composer.referenceChats"),
  };
  const shown = (entries ?? []).filter((e) => e.label.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="options-popover" ref={rootRef}>
      <button
        type="button"
        className={`composer-icon-button${selectedKnowledgeIds.length > 0 ? " active" : ""}`}
        onClick={() => {
          setView("root");
          setMenuOpen((v) => !v);
        }}
        title={t("composer.attach")}
        aria-label={t("composer.attach")}
        aria-expanded={menuOpen}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </button>

      {menuOpen && view === "root" && (
        <div className="options-menu options-menu-wide">
          {row(t("composer.upload"), icon(<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" strokeLinecap="round" strokeLinejoin="round" />), () => void handleUpload())}
          {canCaptureScreen &&
            row(t("composer.capture"), icon(<><path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" /><circle cx="12" cy="13" r="3.5" /></>), () => void handleCapture())}
          {row(t("composer.attachWeb"), icon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>), () => setView("web"))}
          {row(t("composer.attachFiles"), icon(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" strokeLinejoin="round" />), () => openList("files", loadFiles), { sub: true })}
          {row(t("composer.attachNotes"), icon(<path d="M5 4h11l3 3v13H5zM8 10h8M8 14h8" strokeLinejoin="round" strokeLinecap="round" />), () => openList("notes", loadNotes), { sub: true })}
          {hasKnowledge &&
            row(t("composer.attachKnowledge"), icon(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>), () => setView("knowledge"), { sub: true, count: selectedKnowledgeIds.length })}
          {row(t("composer.referenceChats"), icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" /></>), () => openList("chats", loadChats), { sub: true })}
        </div>
      )}

      {menuOpen && view === "web" && (
        <div className="options-menu options-menu-wide">
          {back(t("composer.attachWeb"))}
          <form
            className="options-web"
            onSubmit={(e) => {
              e.preventDefault();
              void handleWeb();
            }}
          >
            <input
              type="url"
              autoFocus
              value={url}
              placeholder={t("composer.webPlaceholder")}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" disabled={busy || !url.trim()}>
              {busy ? t("composer.loading") : t("composer.add")}
            </button>
          </form>
        </div>
      )}

      {menuOpen && (view === "files" || view === "notes" || view === "chats") && (
        <div className="options-menu options-menu-wide">
          {back(listTitle[view])}
          <input
            className="options-filter"
            type="search"
            autoFocus
            value={filter}
            placeholder={t("composer.search")}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="options-list">
            {entries === null && <p className="hint">{t("composer.loading")}</p>}
            {entries !== null && shown.length === 0 && <p className="hint">{t("composer.empty")}</p>}
            {shown.map((entry) => (
              <button key={entry.id} type="button" className="options-row" disabled={busy} onClick={() => void choose(entry)}>
                <span className="options-row-label options-ellipsis">{entry.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {menuOpen && view === "knowledge" && (
        <div className="options-menu options-menu-wide">
          {back(t("composer.attachKnowledge"))}
          <div className="options-tools">
            {knowledgeBases.map((kb) => (
              <label key={kb.id} className="options-tool">
                <input
                  type="checkbox"
                  checked={selectedKnowledgeIds.includes(kb.id)}
                  onChange={() => onToggleKnowledge?.(kb.id)}
                />
                <span>{kb.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
