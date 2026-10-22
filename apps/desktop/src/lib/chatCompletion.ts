import { ChatChunk } from "./openWebUiClient";
import { splitThinking } from "./reasoning";

// Pure reduction of a streamed `ChatChunk` sequence into the final message
// state — pulled out of `ChatView.tsx`'s `runCompletion` so this bookkeeping is
// unit-testable without mounting the component or a real SSE stream.
export interface ChunkAccumulator {
  // the raw streamed text, possibly with inline <think> blocks
  content: string;
  // thinking that arrived as its own chunks
  reasoning: string;
  // retrieved documents (raw, as the server sent them)
  sources: unknown[];
  // when thinking began / ended (ms), to say how long the model thought
  reasoningStart?: number;
  reasoningEnd?: number;
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
}

export const initialChunkAccumulator: ChunkAccumulator = { content: "", reasoning: "", sources: [] };

export function applyChatChunk(acc: ChunkAccumulator, chunk: ChatChunk, now: number = Date.now()): ChunkAccumulator {
  if (chunk.type === "error") {
    return { ...acc, errorMessage: chunk.message };
  }
  if (chunk.type === "done") {
    return { ...acc, promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
  }
  if (chunk.type === "sources") {
    return { ...acc, sources: [...acc.sources, ...chunk.sources] };
  }

  const next: ChunkAccumulator =
    chunk.type === "reasoning"
      ? { ...acc, reasoning: acc.reasoning + chunk.content }
      : { ...acc, content: acc.content + chunk.content };

  // Time the thinking: from its first text to the moment the answer starts
  // (separate chunks) or the <think> block closes (inline).
  const inline = splitThinking(next.content);
  const thinking = next.reasoning !== "" || inline.reasoning !== "" || inline.open;
  if (thinking && next.reasoningStart === undefined) next.reasoningStart = now;
  if (thinking && next.reasoningEnd === undefined && next.reasoningStart !== undefined) {
    const answerStarted = inline.content !== "" && !inline.open;
    if (answerStarted || (next.reasoning !== "" && chunk.type === "delta" && chunk.content !== "")) {
      next.reasoningEnd = now;
    }
  }
  return next;
}

export interface FinishedMessage {
  content: string;
  reasoning: string;
  reasoningSeconds?: number;
  sources: unknown[];
}

// The finished message: the answer without the thinking, the thinking apart,
// and how long it took.
export function finishMessage(acc: ChunkAccumulator, now: number = Date.now()): FinishedMessage {
  const inline = splitThinking(acc.content);
  const reasoning = [acc.reasoning.trim(), inline.reasoning].filter(Boolean).join("\n\n");
  let reasoningSeconds: number | undefined;
  if (reasoning && acc.reasoningStart !== undefined) {
    reasoningSeconds = Math.max(0, Math.round(((acc.reasoningEnd ?? now) - acc.reasoningStart) / 1000));
  }
  return { content: inline.content, reasoning, reasoningSeconds, sources: acc.sources };
}
