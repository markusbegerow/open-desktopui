// Per-chat settings: the sampling parameters and system prompt Open WebUI keeps
// in `chat.params` (synced with the server), and the feature switches / tools
// for the next reply (kept on this device).
import type { CompletionOptions, ChatParams, OpenWebUiModel, ServerFeatures } from "./openWebUiClient";

export interface ChatFeatures {
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
  memory: boolean;
  toolIds: string[];
}

export interface ChatSettings {
  params: ChatParams;
  features: ChatFeatures;
}

export const EMPTY_PARAMS: ChatParams = { system: null, temperature: null, top_p: null, max_tokens: null, seed: null, stop: [] };

export const EMPTY_FEATURES: ChatFeatures = {
  webSearch: false,
  imageGeneration: false,
  codeInterpreter: false,
  memory: false,
  toolIds: [],
};

export function emptySettings(): ChatSettings {
  return { params: { ...EMPTY_PARAMS }, features: { ...EMPTY_FEATURES } };
}

function parseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseParams(text: string | null | undefined): ChatParams {
  const raw = parseJson(text);
  const system = typeof raw.system === "string" && raw.system.trim() !== "" ? raw.system : null;
  return {
    system,
    temperature: num(raw.temperature),
    top_p: num(raw.top_p),
    max_tokens: num(raw.max_tokens),
    seed: num(raw.seed),
    stop: Array.isArray(raw.stop) ? raw.stop.filter((s): s is string => typeof s === "string") : [],
  };
}

// Params as the server sent them: blank text and non-numbers count as unset.
export function normalizeParams(params: Partial<ChatParams> | null | undefined): ChatParams {
  return {
    system: typeof params?.system === "string" && params.system.trim() !== "" ? params.system : null,
    temperature: num(params?.temperature),
    top_p: num(params?.top_p),
    max_tokens: num(params?.max_tokens),
    seed: num(params?.seed),
    stop: Array.isArray(params?.stop) ? params.stop.filter((s): s is string => typeof s === "string") : [],
  };
}

export function parseFeatures(text: string | null | undefined): ChatFeatures {
  const raw = parseJson(text);
  return {
    webSearch: raw.webSearch === true,
    imageGeneration: raw.imageGeneration === true,
    codeInterpreter: raw.codeInterpreter === true,
    memory: raw.memory === true,
    toolIds: Array.isArray(raw.toolIds) ? raw.toolIds.filter((s): s is string => typeof s === "string") : [],
  };
}

// What is stored in the database: only what differs from the defaults, so an
// untouched chat keeps NULL columns.
export function serializeParams(params: ChatParams): string | null {
  const out: Record<string, unknown> = {};
  if (params.system && params.system.trim() !== "") out.system = params.system;
  if (params.temperature !== null) out.temperature = params.temperature;
  if (params.top_p !== null) out.top_p = params.top_p;
  if (params.max_tokens !== null) out.max_tokens = params.max_tokens;
  if (params.seed !== null) out.seed = params.seed;
  if (params.stop.length > 0) out.stop = params.stop;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

export function serializeFeatures(features: ChatFeatures): string | null {
  const out: Record<string, unknown> = {};
  for (const key of ["webSearch", "imageGeneration", "codeInterpreter", "memory"] as const) {
    if (features[key]) out[key] = true;
  }
  if (features.toolIds.length > 0) out.toolIds = features.toolIds;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

export function toCompletionOptions(settings: ChatSettings): CompletionOptions {
  const { params, features } = settings;
  return {
    temperature: params.temperature ?? undefined,
    topP: params.top_p ?? undefined,
    maxTokens: params.max_tokens ?? undefined,
    seed: params.seed ?? undefined,
    stop: params.stop,
    webSearch: features.webSearch,
    imageGeneration: features.imageGeneration,
    codeInterpreter: features.codeInterpreter,
    memory: features.memory,
    toolIds: features.toolIds,
  };
}

// The system prompt sent with a reply: the folder's first, then the chat's own.
// (A custom model's own prompt is added by the server.) Null when there is none.
export function combinedSystemPrompt(folderPrompt: string | null | undefined, chatPrompt: string | null | undefined): string | null {
  const parts = [folderPrompt, chatPrompt].map((p) => p?.trim()).filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export interface AvailableFeatures {
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
  memory: boolean;
}

// Which switches to offer: the model must support it and the server must not
// have it turned off. Unknown (no model yet, no server answer) counts as available.
export function availableFeatures(model: OpenWebUiModel | undefined, server: ServerFeatures | null): AvailableFeatures {
  const caps = model?.capabilities;
  return {
    webSearch: (caps?.webSearch ?? true) && server?.webSearch !== false,
    imageGeneration: (caps?.imageGeneration ?? true) && server?.imageGeneration !== false,
    codeInterpreter: (caps?.codeInterpreter ?? true) && server?.codeInterpreter !== false,
    memory: server?.memory !== false,
  };
}

// A switch that is on but not offered (e.g. after changing the model) must not
// be sent.
export function effectiveFeatures(features: ChatFeatures, available: AvailableFeatures): ChatFeatures {
  return {
    webSearch: features.webSearch && available.webSearch,
    imageGeneration: features.imageGeneration && available.imageGeneration,
    codeInterpreter: features.codeInterpreter && available.codeInterpreter,
    memory: features.memory && available.memory,
    toolIds: features.toolIds,
  };
}
