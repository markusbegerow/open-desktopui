import { describe, expect, it } from "vitest";
import { applyChatChunk, initialChunkAccumulator } from "./chatCompletion";

describe("applyChatChunk", () => {
  it("accumulates delta chunks into content", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "delta", content: "Hel" });
    acc = applyChatChunk(acc, { type: "delta", content: "lo" });
    expect(acc.content).toBe("Hello");
  });

  it("records token counts from the done chunk without touching content", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "delta", content: "hi" });
    acc = applyChatChunk(acc, { type: "done", promptTokens: 12, completionTokens: 3 });
    expect(acc.content).toBe("hi");
    expect(acc.promptTokens).toBe(12);
    expect(acc.completionTokens).toBe(3);
  });

  it("records an error message without discarding partial content", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "delta", content: "partial" });
    acc = applyChatChunk(acc, { type: "error", message: "stream error: connection reset" });
    expect(acc.content).toBe("partial");
    expect(acc.errorMessage).toBe("stream error: connection reset");
  });

  it("tolerates a done chunk with no token counts", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "done", promptTokens: undefined, completionTokens: undefined });
    expect(acc.promptTokens).toBeUndefined();
    expect(acc.completionTokens).toBeUndefined();
  });
});
