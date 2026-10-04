import { forwardRef, KeyboardEvent, useEffect, useImperativeHandle, useState } from "react";
import type { PendingAttachment } from "../lib/attachments";
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
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, disabled, attachments, streaming, onStop },
  ref,
) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [sendKey, setSendKey] = useState<"enter" | "ctrl-enter">("enter");

  useEffect(() => {
    getAppPrefs().then((prefs) => setSendKey(prefs?.sendKey ?? "enter"));
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

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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
      <div className="composer-input-wrap">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
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
