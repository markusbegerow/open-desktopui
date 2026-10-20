// Typed frontend client for Open WebUI's chat API, routed through the Rust
// commands in `src-tauri/src/commands.rs` / `openwebui_client.rs` (reqwest,
// not the webview's `fetch`, to sidestep CORS on arbitrary self-hosted
// servers). Shapes captured from a live instance — see the project plan's
// "M2 execution plan" addendum.
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";

export interface OpenWebUiModel {
  id: string;
  name: string;
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

// ASSUMPTION — not yet verified against a live instance: see the doc
// comment on `rate_message` in `openwebui_client.rs`.
export async function rateOpenWebUiMessage(
  baseUrl: string,
  apiKey: string | undefined,
  chatId: string,
  messageId: string,
  model: string,
  rating: number,
): Promise<void> {
  return invoke("rate_openwebui_message", { baseUrl, apiKey, chatId, messageId, model, rating });
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
): Promise<void> {
  const channel = new Channel<ChatChunk>();
  channel.onmessage = onChunk;
  return invoke("send_chat_message", {
    baseUrl,
    apiKey,
    model,
    messages,
    knowledgeIds,
    requestId,
    channel,
  });
}

// Stops the reply started with the same `requestId`. The stream then ends
// with a normal `done` chunk, so what has streamed so far is kept.
export function cancelChatMessage(requestId: string): Promise<void> {
  return invoke("cancel_chat_message", { requestId });
}
