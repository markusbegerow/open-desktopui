import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import AttachButton from "./AttachButton";
import KnowledgePicker from "./KnowledgePicker";
import MicButton from "./MicButton";
import ModelPicker from "./ModelPicker";
import ChatThread, { DisplayMessage } from "./ChatThread";
import Composer, { ComposerHandle } from "./Composer";
import { getAppPrefs, getOpenWebUiConfig } from "../lib/settingsStore";
import type { PendingAttachment } from "../lib/attachments";
import {
  ChatMessage,
  KnowledgeBase,
  listKnowledgeBases,
  listModels,
  MessageFileRef,
  OpenWebUiModel,
  rateOpenWebUiMessage,
  sendChatMessage,
  cancelChatMessage,
  uploadOpenWebUiFile,
} from "../lib/openWebUiClient";
import { ensureSharedChat } from "../lib/openWebUiSync";
import { applyChatChunk, initialChunkAccumulator, ChunkAccumulator } from "../lib/chatCompletion";
import {
  addMessage,
  createConversation,
  deleteMessagesFrom,
  getConversation,
  getMessages,
  parseAttachments,
  parseKnowledgeIds,
  setConversationKnowledge,
  updateMessageContent,
  updateMessageTokens,
  updateMessageVote,
} from "../lib/chatHistory";

// Desktop notification for a finished reply, only while the pref is on and
// the window isn't focused (no point notifying about something already on
// screen). Never throws into the caller — notifications are a nice-to-have.
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function notifyReplyIfEnabled(content: string) {
  try {
    const prefs = await getAppPrefs();
    if (!prefs?.notifyOnReply) return;
    if (await getCurrentWindow().isFocused()) return;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification({ title: "New reply", body: content.slice(0, 200) });
  } catch {
    // Non-fatal.
  }
}

export interface ChatViewProps {
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  initialMessage?: string | null;
  onInitialMessageConsumed?: () => void;
  initialModel?: string;
  initialKnowledgeIds?: string[];
  initialAttachments?: PendingAttachment[];
  onInitialAttachmentsConsumed?: () => void;
  attachments: PendingAttachment[];
  onAddAttachments: (attachments: PendingAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  onAttachmentError: (message: string) => void;
  onClearAttachments: () => void;
}

export default function ChatView({
  conversationId,
  onConversationCreated,
  initialMessage,
  onInitialMessageConsumed,
  initialModel,
  initialKnowledgeIds,
  initialAttachments,
  onInitialAttachmentsConsumed,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  onAttachmentError,
  onClearAttachments,
}: ChatViewProps) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<OpenWebUiModel[]>([]);
  const [model, setModel] = useState<string>(initialModel ?? "");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>(initialKnowledgeIds ?? []);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [sending, setSending] = useState(false);
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;
  // Set right before we create a conversation mid-`handleSend`, so the
  // `conversationId`-keyed effect below (meant for switching between
  // *existing* conversations via the sidebar) doesn't reload from disk and
  // clobber the in-flight streaming state we're already tracking locally.
  const skipNextLoadRef = useRef(false);
  const sendLockRef = useRef(false);
  // Id of the reply currently streaming, so the Stop button can cancel it.
  const activeRequestRef = useRef<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

  // Loads the model and knowledge-base lists. Also behind the "Retry" button,
  // so a temporary server problem doesn't leave the composer locked forever.
  async function loadServerData() {
    {
      const config = await getOpenWebUiConfig();
      if (!config?.baseUrl) return;
      setBaseUrl(config.baseUrl);
      setApiKey(config.apiKey || undefined);

      setError(null);
      setLoadingModels(true);
      try {
        const [modelList, kbList] = await Promise.all([
          listModels(config.baseUrl, config.apiKey || undefined),
          listKnowledgeBases(config.baseUrl, config.apiKey || undefined),
        ]);
        setModels(modelList);
        if (modelList.length > 0) {
          const prefs = await getAppPrefs();
          const preferred = prefs?.defaultModelId;
          const fallback = modelList.some((m) => m.id === preferred) ? preferred! : modelList[0].id;
          setModel((m) => m || fallback);
        }
        setKnowledgeBases(kbList);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingModels(false);
      }
    }
  }

  useEffect(() => {
    loadServerData().catch((err) => setError(errorText(err)));
  }, []);

  useEffect(() => {
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    if (!conversationId) {
      setMessages([]);
      return;
    }
    // Ignore results that arrive after the user already switched to another
    // conversation (a slow load must not overwrite the newer thread).
    let cancelled = false;
    setSelectedKnowledgeIds([]);
    getMessages(conversationId).then((stored) => {
      if (cancelled) return;
      setMessages(
        stored.map((m) => {
          const storedAttachments = parseAttachments(m);
          const files: MessageFileRef[] | undefined = storedAttachments.length
            ? storedAttachments.map((a) => ({ type: "file" as const, id: a.openWebUiFileId }))
            : undefined;
          return {
            id: m.id,
            role: m.role as ChatMessage["role"],
            content: m.content,
            files,
            createdAt: m.created_at,
            vote: m.vote ?? undefined,
            attachments: storedAttachments.length
              ? storedAttachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType }))
              : undefined,
          };
        }),
      );
    }).catch((err) => {
      if (!cancelled) setError(`Could not load this conversation: ${errorText(err)}`);
    });
    getConversation(conversationId).then((conv) => {
      if (!cancelled && conv) setSelectedKnowledgeIds(parseKnowledgeIds(conv));
    }).catch(() => {
      // The messages load above already reports a broken database.
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const initialMessageHandledRef = useRef(false);

  useEffect(() => {
    if (initialMessageHandledRef.current) return;
    const hasInitialText = initialMessage !== undefined && initialMessage !== null;
    const hasInitialAttachments = !!initialAttachments?.length;
    if (!hasInitialText && !hasInitialAttachments) return;
    if (conversationIdRef.current) return;
    if (!baseUrl || !model) return;
    initialMessageHandledRef.current = true;
    handleSend(initialMessage ?? "", initialAttachments ?? []);
    onInitialMessageConsumed?.();
    onInitialAttachmentsConsumed?.();
  }, [initialMessage, initialAttachments, baseUrl, model]);

  function toggleKnowledgeBase(id: string) {
    setSelectedKnowledgeIds((prev) => {
      const next = prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id];
      if (conversationIdRef.current) {
        setConversationKnowledge(conversationIdRef.current, next);
      }
      return next;
    });
  }

  async function ensureConversation(title: string): Promise<string> {
    if (conversationIdRef.current) return conversationIdRef.current;
    const trimmedTitle = title.length > 48 ? `${title.slice(0, 48)}…` : title;
    const created = await createConversation(model, trimmedTitle, selectedKnowledgeIds);
    conversationIdRef.current = created.id;
    skipNextLoadRef.current = true;
    onConversationCreated(created.id);
    return created.id;
  }

  // Shared tail for sending/edit-resend/regenerate: given the message
  // history to send (already persisted, up to and including the latest user
  // message), stream a fresh assistant reply and persist it.
  async function runCompletion(historyMessages: DisplayMessage[], convId: string) {
    setMessages(historyMessages);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setSending(true);

    const history: ChatMessage[] = historyMessages.map((m) => ({ role: m.role, content: m.content, files: m.files }));
    const lastUserMsg = [...historyMessages].reverse().find((m) => m.role === "user");

    let acc: ChunkAccumulator = initialChunkAccumulator;
    const requestId = crypto.randomUUID();
    activeRequestRef.current = requestId;
    setStreaming(true);
    try {
      await sendChatMessage(
        baseUrl!,
        apiKey,
        model,
        history,
        selectedKnowledgeIds,
        (chunk) => {
          acc = applyChatChunk(acc, chunk);
          if (chunk.type === "delta") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: acc.content } : m)),
            );
          } else if (chunk.type === "error") {
            setError(acc.errorMessage!);
          }
        },
        requestId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      activeRequestRef.current = null;
      setStreaming(false);
      setSending(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
      // Persisting must never throw out of `finally` (it would replace the
      // real error and surface as an unhandled rejection): report it instead.
      try {
        if (acc.promptTokens !== undefined && lastUserMsg) {
          await updateMessageTokens(lastUserMsg.id, acc.promptTokens);
        }
        if (acc.content) {
          const stored = await addMessage(convId, { role: "assistant", content: acc.content }, acc.completionTokens);
          // The streaming placeholder used a locally-generated id — swap it
          // for the real persisted id/timestamp so later actions (regenerate,
          // edit) can reference this message correctly.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, id: stored.id, createdAt: stored.created_at } : m,
            ),
          );
          void notifyReplyIfEnabled(acc.content);
        }
      } catch (err) {
        setError(`The reply could not be saved: ${errorText(err)}`);
      }
    }
  }

  // Serializes send/edit/regenerate: `sending` only flips inside
  // `runCompletion`, after uploads and DB writes, so a quick double Enter
  // would otherwise start two completions. Any failure is shown instead of
  // becoming an unhandled rejection. Resolves to whether the action ran.
  async function withSendLock(action: () => Promise<boolean | void>): Promise<boolean> {
    if (sendLockRef.current) return false;
    sendLockRef.current = true;
    setSending(true);
    try {
      return (await action()) !== false;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      sendLockRef.current = false;
      setSending(false);
    }
  }

  function handleSend(text: string, sendAttachments: PendingAttachment[] = []): Promise<boolean> {
    return withSendLock(() => sendMessage(text, sendAttachments));
  }

  async function sendMessage(text: string, sendAttachments: PendingAttachment[]): Promise<boolean> {
    if (!baseUrl || !model) {
      setError("Configure your Open WebUI server in Settings first.");
      return false;
    }
    if (!text.trim() && sendAttachments.length === 0) return false;
    setError(null);

    let uploadedAttachments: PendingAttachment[] = [];
    if (sendAttachments.length > 0) {
      try {
        for (const attachment of sendAttachments) {
          const uploaded = await uploadOpenWebUiFile(baseUrl, apiKey, attachment.path);
          uploadedAttachments.push({ ...attachment, uploadedId: uploaded.id });
        }
      } catch (err) {
        // Attachments stay in the composer so the user can retry.
        setError(`Could not upload attachment: ${errorText(err)}`);
        return false;
      }
      onClearAttachments();
    }
    const files: MessageFileRef[] | undefined = uploadedAttachments.length
      ? uploadedAttachments.map((a) => ({ type: "file", id: a.uploadedId! }))
      : undefined;

    const convId = await ensureConversation(text || sendAttachments[0]?.filename || "Attachment");

    const userMsg = await addMessage(
      convId,
      { role: "user", content: text, files },
      undefined,
      uploadedAttachments,
    );
    const nextMessages: DisplayMessage[] = [
      ...messages,
      {
        id: userMsg.id,
        role: "user",
        content: text,
        files,
        createdAt: userMsg.created_at,
        attachments: uploadedAttachments.length
          ? uploadedAttachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType }))
          : undefined,
      },
    ];
    await runCompletion(nextMessages, convId);
    return true;
  }

  function handleStop() {
    const id = activeRequestRef.current;
    if (id) cancelChatMessage(id).catch((err) => setError(errorText(err)));
  }

  function handleEditMessage(id: string, newText: string): Promise<boolean> {
    return withSendLock(async () => {
      const convId = conversationIdRef.current;
      if (!convId) return false;
      const index = messages.findIndex((m) => m.id === id);
      if (index === -1) return false;
      const target = messages[index];
      const before = messages.slice(0, index);
      await updateMessageContent(id, newText);
      if (target.createdAt !== undefined) {
        // Exclude the edited message's own row — only drop what came after it.
        await deleteMessagesFrom(convId, target.createdAt + 1);
      }
      await runCompletion([...before, { ...target, content: newText }], convId);
    });
  }

  function handleRegenerate(id: string): Promise<boolean> {
    return withSendLock(async () => {
      const convId = conversationIdRef.current;
      if (!convId) return false;
      const index = messages.findIndex((m) => m.id === id);
      if (index === -1 || messages[index].role !== "assistant") return false;
      const target = messages[index];
      const before = messages.slice(0, index);
      if (target.createdAt !== undefined) {
        await deleteMessagesFrom(convId, target.createdAt);
      }
      await runCompletion(before, convId);
    });
  }

  async function handleVote(id: string, rating: number) {
    const convId = conversationIdRef.current;
    if (!convId || !baseUrl) return;
    const target = messages.find((m) => m.id === id);
    if (!target) return;
    const nextVote = target.vote === rating ? 0 : rating;
    const setVote = (vote: number | undefined) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, vote } : m)));
    setVote(nextVote);
    try {
      await updateMessageVote(id, nextVote);
      const conv = await getConversation(convId);
      if (!conv) return;
      const { chatId } = await ensureSharedChat(conv);
      const stored = await getMessages(convId);
      const remoteMessageId = stored.find((m) => m.id === id)?.openwebui_message_id;
      if (!remoteMessageId) throw new Error("Could not determine this message's Open WebUI id.");
      await rateOpenWebUiMessage(baseUrl, apiKey, chatId, remoteMessageId, model, nextVote);
    } catch (err) {
      // Roll back so the UI never shows a vote the server didn't record.
      setVote(target.vote);
      await updateMessageVote(id, target.vote ?? 0).catch(() => {});
      setError(errorText(err));
    }
  }

  if (!baseUrl) {
    return (
      <div className="view">
        <h2>Chat</h2>
        <p className="hint">Configure your Open WebUI server connection in Settings first.</p>
      </div>
    );
  }

  return (
    <div className="view chat-view">
      {error && <p className="status-error">{error}</p>}
      {!loadingModels && models.length === 0 && (
        <p>
          <button
            type="button"
            onClick={() => loadServerData().catch((err) => setError(errorText(err)))}
          >
            Retry loading models
          </button>
        </p>
      )}

      <ChatThread
        messages={messages}
        onEditMessage={handleEditMessage}
        onRegenerate={handleRegenerate}
        onVote={handleVote}
      />

      <div className="chat-view-footer">
      {(knowledgeBases.length > 0 || attachments.length > 0) && (
        <div className="context-row">
          {knowledgeBases.length > 0 && (
            <KnowledgePicker
              knowledgeBases={knowledgeBases}
              selectedIds={selectedKnowledgeIds}
              onToggle={toggleKnowledgeBase}
            />
          )}
          {attachments.length > 0 && (
            <div className="attachment-chip-row">
              {attachments.map((a) => (
                <span key={a.id} className="attachment-chip">
                  <span className="attachment-chip-icon">{a.kind === "image" ? "🖼" : "📄"}</span>
                  <span className="attachment-chip-name">{a.filename}</span>
                  <button
                    type="button"
                    className="attachment-chip-remove"
                    aria-label={`Remove ${a.filename}`}
                    onClick={() => onRemoveAttachment(a.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <Composer
        ref={composerRef}
        onSend={(text, atts) => handleSend(text, atts)}
        disabled={sending || !model}
        attachments={attachments}
        streaming={streaming}
        onStop={handleStop}
      />
      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <AttachButton onAdd={onAddAttachments} onError={onAttachmentError} />
          <MicButton
            baseUrl={baseUrl}
            apiKey={apiKey}
            onResult={(text) => composerRef.current?.appendText(text)}
            onError={setError}
          />
        </div>
        <div className="composer-toolbar-right">
          <ModelPicker models={models} selectedId={model} onSelect={setModel} disabled={loadingModels} />
        </div>
      </div>
      </div>
    </div>
  );
}
