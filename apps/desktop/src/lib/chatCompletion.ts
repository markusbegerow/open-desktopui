import { ChatChunk } from "./openWebUiClient";

// Pure reduction of a streamed `ChatChunk` sequence into the final message
// state — pulled out of `ChatView.tsx`'s `runCompletion` so this bookkeeping is
// unit-testable without mounting the component or a real SSE stream.
export interface ChunkAccumulator {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
}

export const initialChunkAccumulator: ChunkAccumulator = { content: "" };

export function applyChatChunk(acc: ChunkAccumulator, chunk: ChatChunk): ChunkAccumulator {
  if (chunk.type === "delta") {
    return { ...acc, content: acc.content + chunk.content };
  }
  if (chunk.type === "error") {
    return { ...acc, errorMessage: chunk.message };
  }
  // chunk.type === "done"
  return { ...acc, promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
}
