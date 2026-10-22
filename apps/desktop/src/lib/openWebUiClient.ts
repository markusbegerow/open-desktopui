// Typed frontend client for Open WebUI's chat API, routed through the Rust
// commands in `src-tauri/src/commands.rs` / `openwebui_client.rs` (reqwest,
// not the webview's `fetch`, to sidestep CORS on arbitrary self-hosted
// servers). Shapes captured from a live instance — see the project plan's
// "M2 execution plan" addendum.
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";

export interface ModelCapabilities {
  vision: boolean;
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
}

export interface OpenWebUiModel {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  // absent capabilities count as available, as in the web interface
  capabilities: ModelCapabilities;
  // a preset set up in the server's workspace, as opposed to a raw model
  workspace: boolean;
}

// What the server itself has switched on; null = it didn't say.
export interface ServerFeatures {
  webSearch: boolean | null;
  imageGeneration: boolean | null;
  codeInterpreter: boolean | null;
  memory: boolean | null;
}

export interface ServerTool {
  id: string;
  name: string;
  description: string | null;
}

// The chat settings Open WebUI keeps in `chat.params` (its own key names).
export interface ChatParams {
  system: string | null;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  seed: number | null;
  stop: string[];
}

// Optional switches for one reply; anything left out is not sent.
export interface CompletionOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
  webSearch?: boolean;
  imageGeneration?: boolean;
  codeInterpreter?: boolean;
  memory?: boolean;
  toolIds?: string[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
}

export interface MessageFileRef {
  type: "file";
  id: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  files?: MessageFileRef[];
}

export interface UploadedFile {
  id: string;
  filename: string;
}

export type ChatChunk =
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "sources"; sources: unknown[] }
  | { type: "done"; promptTokens?: number; completionTokens?: number }
  | { type: "error"; message: string };

export async function listModels(baseUrl: string, apiKey?: string): Promise<OpenWebUiModel[]> {
  return invoke("list_openwebui_models", { baseUrl, apiKey });
}

export async function listKnowledgeBases(baseUrl: string, apiKey?: string): Promise<KnowledgeBase[]> {
  return invoke("list_knowledge_bases", { baseUrl, apiKey });
}

export async function login(baseUrl: string, email: string, password: string): Promise<string> {
  return invoke("openwebui_login", { baseUrl, email, password });
}

export interface CurrentUser {
  id: string | null;
  name: string | null;
  detectedLanguage: string | null;
  profileImageUrl: string | null;
}

export async function getCurrentUser(baseUrl: string, token: string): Promise<CurrentUser> {
  return invoke("get_openwebui_current_user", { baseUrl, token });
}

export async function fetchProfileImage(
  baseUrl: string,
  token: string,
  imageUrl: string,
): Promise<ArrayBuffer> {
  return invoke("fetch_openwebui_profile_image", { baseUrl, token, imageUrl });
}

export interface CreatedChat {
  id: string;
  messageIds: string[];
}

// ASSUMPTION — not yet verified against a live instance, and a bigger
// unknown than the other unverified calls: see the doc comment on
// `create_chat` in `openwebui_client.rs`.
export async function createOpenWebUiChat(
  baseUrl: string,
  apiKey: string | undefined,
  title: string,
  model: string,
  messages: ChatMessage[],
  folderId?: string | null,
): Promise<CreatedChat> {
  return invoke("create_openwebui_chat", { baseUrl, apiKey, title, model, messages, folderId: folderId ?? null });
}

// Folders — shapes taken from Open WebUI's `routers/folders.py`; see the doc
// comments in `openwebui_client.rs`. A 403 means the folders feature is
// disabled or not permitted for this account.
export interface ServerFolder {
  id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  isExpanded: boolean;
  systemPrompt: string | null;
  // false when the per-folder lookup failed: keep the local prompt then.
  systemPromptKnown: boolean;
  // server-side last change in ms; 0 when unknown
  updatedAt: number;
}

export function listFolders(baseUrl: string, token: string): Promise<ServerFolder[]> {
  return invoke("list_openwebui_folders", { baseUrl, token });
}

export function createFolder(
  baseUrl: string,
  token: string,
  name: string,
  parentId: string | null,
  systemPrompt: string | null,
  icon: string | null,
): Promise<ServerFolder> {
  return invoke("create_openwebui_folder", { baseUrl, token, name, parentId, systemPrompt, icon });
}

export function updateFolder(
  baseUrl: string,
  token: string,
  id: string,
  fields: { name?: string; systemPrompt?: string; icon?: string },
): Promise<void> {
  return invoke("update_openwebui_folder", {
    baseUrl,
    token,
    id,
    name: fields.name ?? null,
    systemPrompt: fields.systemPrompt ?? null,
    icon: fields.icon ?? null,
  });
}

export function updateFolderParent(baseUrl: string, token: string, id: string, parentId: string | null): Promise<void> {
  return invoke("update_openwebui_folder_parent", { baseUrl, token, id, parentId });
}

export function updateFolderExpanded(baseUrl: string, token: string, id: string, isExpanded: boolean): Promise<void> {
  return invoke("update_openwebui_folder_expanded", { baseUrl, token, id, isExpanded });
}

export function deleteFolder(baseUrl: string, token: string, id: string): Promise<void> {
  return invoke("delete_openwebui_folder", { baseUrl, token, id });
}

export function moveChatToFolder(
  baseUrl: string,
  token: string,
  chatId: string,
  folderId: string | null,
): Promise<void> {
  return invoke("move_openwebui_chat_to_folder", { baseUrl, token, chatId, folderId });
}

// Chats — shapes taken from Open WebUI's `routers/chats.py`; see the doc
// comments in `openwebui_client.rs`. Times are milliseconds.
export interface ServerChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  // null = the server didn't say; keep the local value
  pinned: boolean | null;
  archived: boolean | null;
  folderId: string | null;
  folderKnown: boolean;
  // ms; 0 after "mark as unread"; null = the server didn't say
  lastReadAt: number | null;
}

export interface FileRef {
  id: string;
  name: string;
  mime: string; // may be empty
}

export interface ServerMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  rating: number | null; // 1 / -1 from annotation.rating
  feedbackId: string | null;
  files: FileRef[];
  sources: unknown[] | null; // the retrieved documents behind the answer
}

export interface ServerChatDetail {
  chat: ServerChat;
  model: string | null;
  messages: ServerMessage[];
  knowledgeIds: string[];
  tags: string[]; // tag ids (lower-case, underscores for spaces)
  params: ChatParams;
}

export interface SyncMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  // 0 clears the server's rating, undefined leaves it alone
  rating?: number;
  feedbackId?: string;
  files?: FileRef[];
  sources?: unknown[];
}

export function listChats(baseUrl: string, token: string, folderIds: string[]): Promise<ServerChat[]> {
  return invoke("list_openwebui_chats", { baseUrl, token, folderIds });
}

export function getChat(baseUrl: string, token: string, id: string): Promise<ServerChatDetail> {
  return invoke("get_openwebui_chat", { baseUrl, token, id });
}

export function updateChatTitle(baseUrl: string, token: string, id: string, title: string): Promise<void> {
  return invoke("update_openwebui_chat_title", { baseUrl, token, id, title });
}

export function updateChatContent(
  baseUrl: string,
  token: string,
  id: string,
  title: string,
  model: string,
  messages: SyncMessage[],
  knowledge: KnowledgeBase[],
  params: ChatParams | null = null,
): Promise<void> {
  return invoke("update_openwebui_chat_content", { baseUrl, token, id, title, model, messages, knowledge, params });
}

export function deleteChat(baseUrl: string, token: string, id: string): Promise<void> {
  return invoke("delete_openwebui_chat", { baseUrl, token, id });
}

export function setChatFlag(
  baseUrl: string,
  token: string,
  id: string,
  flag: "pin" | "archive",
  value: boolean,
): Promise<void> {
  return invoke("set_openwebui_chat_flag", { baseUrl, token, id, flag, value });
}

// ASSUMPTION — not yet verified against a live instance: see the doc
// comment on `rate_message` in `openwebui_client.rs`.
// Resolves to the id of the feedback record on the server (null once the
// rating was cleared); pass it back on the next change to update that record.
export async function rateOpenWebUiMessage(
  baseUrl: string,
  apiKey: string | undefined,
  chatId: string,
  messageId: string,
  model: string,
  rating: number,
  feedbackId: string | null = null,
): Promise<string | null> {
  return invoke("rate_openwebui_message", { baseUrl, apiKey, chatId, messageId, model, rating, feedbackId });
}

// The server's own title generation, so titles match the web UI. Resolves to
// null when the server has the feature switched off or the model said nothing usable.
export function generateTitle(
  baseUrl: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  chatId: string | null,
): Promise<string | null> {
  return invoke("generate_openwebui_title", { baseUrl, token, model, messages, chatId });
}

// Both resolve to the chat's tag ids afterwards.
export function addChatTag(baseUrl: string, token: string, id: string, name: string): Promise<string[]> {
  return invoke("add_openwebui_chat_tag", { baseUrl, token, id, name });
}

export function removeChatTag(baseUrl: string, token: string, id: string, name: string): Promise<string[]> {
  return invoke("remove_openwebui_chat_tag", { baseUrl, token, id, name });
}

// Stores an image from the clipboard as a file and resolves to its path, so it
// can be attached like any picked file. The bytes go as the raw request body.
export function savePastedImage(bytes: ArrayBuffer, extension: string): Promise<string> {
  return invoke("save_pasted_image", bytes, { headers: { "x-extension": extension } });
}

// Downloads an attachment from the server and opens it with the system's
// default application for its type.
export function openServerFile(baseUrl: string, token: string, fileId: string, filename: string): Promise<void> {
  return invoke("open_openwebui_file", { baseUrl, token, fileId, filename });
}

export function markChatUnread(baseUrl: string, token: string, id: string): Promise<void> {
  return invoke("mark_openwebui_chat_unread", { baseUrl, token, id });
}

// ASSUMPTION — not yet verified against a live instance: see the doc
// comment on `upload_file` in `openwebui_client.rs`.
export async function uploadOpenWebUiFile(
  baseUrl: string,
  apiKey: string | undefined,
  filePath: string,
): Promise<UploadedFile> {
  return invoke("upload_openwebui_file", { baseUrl, apiKey, filePath });
}

// ASSUMPTION — not yet verified against a live instance: see the doc
// comment on `transcribe_audio` in `openwebui_client.rs`.
export async function transcribeAudio(
  baseUrl: string,
  apiKey: string | undefined,
  audioBytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  return invoke("transcribe_audio", { baseUrl, apiKey, audioBytes: Array.from(audioBytes), mimeType });
}

export function sendChatMessage(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  knowledgeIds: string[],
  onChunk: (chunk: ChatChunk) => void,
  requestId: string = crypto.randomUUID(),
  options: CompletionOptions = {},
): Promise<void> {
  const channel = new Channel<ChatChunk>();
  channel.onmessage = onChunk;
  return invoke("send_chat_message", {
    baseUrl,
    apiKey,
    model,
    messages,
    knowledgeIds,
    options,
    requestId,
    channel,
  });
}

export interface ServerPrompt {
  id: string;
  command: string; // without the leading slash
  name: string;
  content: string;
}

export interface ServerNote {
  id: string;
  title: string;
  markdown: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ServerMemory {
  id: string;
  content: string;
  updatedAt: number;
}

export function listPrompts(baseUrl: string, token: string): Promise<ServerPrompt[]> {
  return invoke("list_openwebui_prompts", { baseUrl, token });
}

export function listNotes(baseUrl: string, token: string): Promise<ServerNote[]> {
  return invoke("list_openwebui_notes", { baseUrl, token });
}

export function createNote(baseUrl: string, token: string, title: string, markdown: string): Promise<ServerNote> {
  return invoke("create_openwebui_note", { baseUrl, token, title, markdown });
}

export function updateNote(
  baseUrl: string,
  token: string,
  id: string,
  title: string,
  markdown: string,
): Promise<ServerNote> {
  return invoke("update_openwebui_note", { baseUrl, token, id, title, markdown });
}

export function deleteNote(baseUrl: string, token: string, id: string): Promise<void> {
  return invoke("delete_openwebui_note", { baseUrl, token, id });
}

export function listMemories(baseUrl: string, token: string): Promise<ServerMemory[]> {
  return invoke("list_openwebui_memories", { baseUrl, token });
}

export function addMemory(baseUrl: string, token: string, content: string): Promise<ServerMemory> {
  return invoke("add_openwebui_memory", { baseUrl, token, content });
}

export function updateMemory(baseUrl: string, token: string, id: string, content: string): Promise<ServerMemory> {
  return invoke("update_openwebui_memory", { baseUrl, token, id, content });
}

export function deleteMemory(baseUrl: string, token: string, id: string): Promise<void> {
  return invoke("delete_openwebui_memory", { baseUrl, token, id });
}

export function getServerFeatures(baseUrl: string): Promise<ServerFeatures> {
  return invoke("get_openwebui_server_features", { baseUrl });
}

export function listTools(baseUrl: string, token: string): Promise<ServerTool[]> {
  return invoke("list_openwebui_tools", { baseUrl, token });
}

// Stops the reply started with the same `requestId`. The stream then ends
// with a normal `done` chunk, so what has streamed so far is kept.
export function cancelChatMessage(requestId: string): Promise<void> {
  return invoke("cancel_chat_message", { requestId });
}

export interface ServerFile {
  id: string;
  filename: string;
  mimeType: string;
}

// Files already uploaded to the server (so they can be attached without a new upload).
export function listServerFiles(baseUrl: string, token: string): Promise<ServerFile[]> {
  return invoke("list_openwebui_files", { baseUrl, token });
}

// The raw HTML of a web page, fetched by the app (not the webview, to avoid CORS).
export function fetchWebPage(url: string): Promise<string> {
  return invoke("fetch_web_page", { url });
}
