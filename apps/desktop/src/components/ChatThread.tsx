import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "../lib/openWebUiClient";

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  attachments?: { filename: string; mimeType: string }[];
  createdAt?: number;
  vote?: number; // -1, 0, or 1 — thumbs down/none/up, sent to Open WebUI
}

export interface ChatThreadProps {
  messages: DisplayMessage[];
  onEditMessage: (id: string, text: string) => void;
  onRegenerate: (id: string) => void;
  onVote: (id: string, rating: number) => void;
}

// Small inline icons matching the send button's style in Composer.tsx
// (stroke-based, currentColor, no external icon library needed).
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CopyIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...ICON_PROPS}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function ThumbsUpIcon({ active }: { active?: boolean }) {
  return (
    <svg {...ICON_PROPS} fill={active ? "currentColor" : "none"}>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

function ThumbsDownIcon({ active }: { active?: boolean }) {
  return (
    <svg {...ICON_PROPS} fill={active ? "currentColor" : "none"}>
      <path d="M17 14V2" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
    </svg>
  );
}

// Strips common markdown syntax before handing text to SpeechSynthesis, so
// it doesn't read out symbol names ("asterisk asterisk...").
function toSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~]/g, "")
    .trim();
}

export default function ChatThread({ messages, onEditMessage, onRegenerate, onVote }: ChatThreadProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  async function handleCopy(m: DisplayMessage) {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((id) => (id === m.id ? null : id)), 1500);
    } catch {
      // Clipboard access denied/unavailable — nothing more we can do here.
    }
  }

  function startEdit(m: DisplayMessage) {
    setEditingId(m.id);
    setEditValue(m.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  function saveEdit(id: string) {
    const text = editValue.trim();
    setEditingId(null);
    if (text) onEditMessage(id, text);
  }

  function handleSpeak(m: DisplayMessage) {
    if (speakingId === m.id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(toSpeechText(m.content));
    utterance.onend = () => setSpeakingId((id) => (id === m.id ? null : id));
    utterance.onerror = () => setSpeakingId((id) => (id === m.id ? null : id));
    setSpeakingId(m.id);
    window.speechSynthesis.speak(utterance);
  }

  return (
    <div className="chat-thread">
      <div className="chat-thread-inner">
        {messages.length === 0 && <p className="hint">Send a message to start the conversation.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-message chat-message-${m.role}`}>
            <div className="chat-message-role">{m.role === "user" ? "You" : "Assistant"}</div>
            {m.attachments && m.attachments.length > 0 && (
              <div className="attachment-chip-row">
                {m.attachments.map((a, i) => (
                  <span key={i} className="attachment-chip">
                    <span className="attachment-chip-icon">
                      {a.mimeType.startsWith("image/") ? "🖼" : "📄"}
                    </span>
                    <span className="attachment-chip-name">{a.filename}</span>
                  </span>
                ))}
              </div>
            )}
            {editingId === m.id ? (
              <div className="chat-message-edit">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={Math.min(10, Math.max(2, editValue.split("\n").length))}
                  autoFocus
                />
                <div className="chat-message-edit-actions">
                  <button type="button" onClick={() => saveEdit(m.id)}>
                    Save &amp; submit
                  </button>
                  <button type="button" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-message-content">
                {m.streaming && !m.content ? (
                  <span className="thinking-indicator" aria-label="Assistant is thinking">
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                  </span>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {m.content}
                  </ReactMarkdown>
                )}
              </div>
            )}
            {!m.streaming && editingId !== m.id && (
              <div className="chat-message-actions">
                <button
                  type="button"
                  onClick={() => handleCopy(m)}
                  title={copiedId === m.id ? "Copied" : "Copy"}
                  aria-label={copiedId === m.id ? "Copied" : "Copy"}
                >
                  {copiedId === m.id ? <CheckIcon /> : <CopyIcon />}
                </button>
                {m.role === "user" && (
                  <button type="button" onClick={() => startEdit(m)} title="Edit" aria-label="Edit">
                    <EditIcon />
                  </button>
                )}
                {m.role === "assistant" && (
                  <>
                    <button
                      type="button"
                      onClick={() => onRegenerate(m.id)}
                      title="Regenerate"
                      aria-label="Regenerate"
                    >
                      <RegenerateIcon />
                    </button>
                    <button
                      type="button"
                      onClick={() => onVote(m.id, 1)}
                      title="Good response"
                      aria-label="Good response"
                    >
                      <ThumbsUpIcon active={m.vote === 1} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onVote(m.id, -1)}
                      title="Bad response"
                      aria-label="Bad response"
                    >
                      <ThumbsDownIcon active={m.vote === -1} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSpeak(m)}
                      title={speakingId === m.id ? "Stop" : "Read aloud"}
                      aria-label={speakingId === m.id ? "Stop" : "Read aloud"}
                    >
                      {speakingId === m.id ? <StopIcon /> : <SpeakerIcon />}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
