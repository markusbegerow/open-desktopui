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
}

export async function getCurrentUser(baseUrl: string, token: string): Promise<CurrentUser> {
  return invoke("get_openwebui_current_user", { baseUrl, token });
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
): Promise<CreatedChat> {
  return invoke("create_openwebui_chat", { baseUrl, apiKey, title, model, messages });
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
): Promise<void> {
  const channel = new Channel<ChatChunk>();
  channel.onmessage = onChunk;
  return invoke("send_chat_message", { baseUrl, apiKey, model, messages, knowledgeIds, channel });
}
