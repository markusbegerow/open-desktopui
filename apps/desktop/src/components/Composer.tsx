import { ClipboardEvent, forwardRef, KeyboardEvent, useEffect, useImperativeHandle, useState } from "react";
import type { PendingAttachment } from "../lib/attachments";
import { attachPastedImages, imageFilesOf } from "../lib/clipboardImages";
import { takePrefill } from "../lib/prefill";
import type { LibraryPrompt } from "../lib/library";
import { commandQuery, customVariables, fillVariables, matchPrompts, usesVariable } from "../lib/promptVars";
import { useLibraryPrompts } from "../lib/useLibraryPrompts";
import PromptVariablesDialog from "./PromptVariablesDialog";
import { getAppPrefs } from "../lib/settingsStore";
import { useTranslation } from "../lib/i18n";

export interface ComposerHandle {
  appendText: (text: string) => void;
}

export interface ComposerProps {
  onSend: (text: string, attachments: PendingAttachment[]) => void | boolean | Promise<boolean | void>;
  disabled: boolean;
  attachments: PendingAttachment[];
  /** A reply is streaming: the send button turns into a Stop button. */
  streaming?: boolean;
  onStop?: () => void;
  /** Called with images pasted from the clipboard, already saved as files. */
  onPasteAttachments?: (attachments: PendingAttachment[]) => void;
  onPasteError?: (message: string) => void;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, disabled, attachments, streaming, onStop, onPasteAttachments, onPasteError },
  ref,
) {
  const { t, language } = useTranslation();
  const [value, setValue] = useState("");
  const [sendKey, setSendKey] = useState<"enter" | "ctrl-enter">("enter");
  const [userName, setUserName] = useState<string | undefined>(undefined);
  const prompts = useLibraryPrompts();
  // "/summ…" at the start of the message offers the matching prompts.
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<LibraryPrompt | null>(null);
  const query = commandQuery(value);
  const matches = query !== null && !paletteDismissed ? matchPrompts(prompts, query) : [];

  useEffect(() => {
    getAppPrefs().then((prefs) => {
      setSendKey(prefs?.sendKey ?? "enter");
      setUserName(prefs?.displayName);
    });
  }, []);

  // A new search starts at the first entry and may show the palette again.
  useEffect(() => {
    setPaletteIndex(0);
    setPaletteDismissed(false);
  }, [query]);

  async function insertPrompt(prompt: LibraryPrompt, values: Record<string, string>) {
    let clipboard: string | undefined;
    if (usesVariable(prompt.content, "CLIPBOARD")) {
      try {
        clipboard = await navigator.clipboard.readText();
      } catch {
        clipboard = ""; // reading the clipboard can be refused; the prompt still works
      }
    }
    setValue(fillVariables(prompt.content, values, { now: new Date(), clipboard, userName, language }));
  }

  function choosePrompt(prompt: LibraryPrompt) {
    if (customVariables(prompt.content).length > 0) setPendingPrompt(prompt);
    else void insertPrompt(prompt, {});
  }

  // Text from an opendesktopui://new?q=… link.
  useEffect(() => {
    const text = takePrefill();
    if (text) setValue(text);
  }, []);

  useImperativeHandle(ref, () => ({
    appendText: (text: string) => {
      setValue((prev) => (prev ? `${prev} ${text}` : text));
    },
  }));

  function submit() {
    const text = value.trim();
    if ((!text && attachments.length === 0) || disabled) return;
    const result = onSend(text, attachments);
    setValue("");
    // The handler reports `false` when the message was not sent (upload or
    // storage failed) — put the text back so it isn't lost.
    void Promise.resolve(result).then((ok) => {
      if (ok === false) setValue((current) => current || text);
    });
  }

  // Ctrl+V with an image on the clipboard attaches it; text pastes as usual.
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onPasteAttachments) return;
    const images = imageFilesOf(e.clipboardData);
    if (images.length === 0) return;
    e.preventDefault();
    void attachPastedImages(images).then(({ attachments: pasted, errors }) => {
      if (pasted.length > 0) onPasteAttachments(pasted);
      if (errors.length > 0) onPasteError?.(errors.join(" "));
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPaletteIndex((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choosePrompt(matches[Math.min(paletteIndex, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaletteDismissed(true);
        return;
      }
    }
    if (sendKey === "ctrl-enter") {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      {pendingPrompt && (
        <PromptVariablesDialog
          prompt={pendingPrompt}
          names={customVariables(pendingPrompt.content)}
          onCancel={() => setPendingPrompt(null)}
          onSubmit={(values) => {
            const prompt = pendingPrompt;
            setPendingPrompt(null);
            void insertPrompt(prompt, values);
          }}
        />
      )}
      <div className="composer-input-wrap">
        {matches.length > 0 && (
          <ul className="prompt-palette" role="listbox" aria-label={t("prompts.title")}>
            {matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === paletteIndex}
                className={i === paletteIndex ? "active" : undefined}
                // mousedown, not click: the textarea must not lose focus first
                onMouseDown={(e) => {
                  e.preventDefault();
                  choosePrompt(p);
                }}
              >
                <span className="prompt-command">/{p.command}</span>
                <span className="prompt-name">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            sendKey === "ctrl-enter"
              ? t("composer.placeholderCtrlEnter")
              : t("composer.placeholderEnter")
          }
          rows={3}
          disabled={disabled}
        />
        {streaming && onStop ? (
          <button
            className="composer-send"
            onClick={onStop}
            type="button"
            aria-label="Stop"
            title="Stop generating"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
        <button
          className="composer-send"
          onClick={submit}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          type="button"
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2 11 13" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M22 2 15 22l-4-9-9-4Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        )}
      </div>
    </div>
  );
});

export default Composer;
