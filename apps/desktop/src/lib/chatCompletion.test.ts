import { describe, expect, it } from "vitest";
import { applyChatChunk, finishMessage, initialChunkAccumulator } from "./chatCompletion";

describe("reasoning and sources", () => {
  it("keeps separately streamed thinking apart from the answer and times it", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "reasoning", content: "Let me " }, 1000);
    acc = applyChatChunk(acc, { type: "reasoning", content: "think." }, 2000);
    acc = applyChatChunk(acc, { type: "delta", content: "The answer" }, 5000);
    acc = applyChatChunk(acc, { type: "delta", content: " is 4." }, 6000);
    const done = finishMessage(acc, 7000);
    expect(done).toMatchObject({ content: "The answer is 4.", reasoning: "Let me think.", reasoningSeconds: 4 });
  });

  it("splits inline <think> blocks, even when the tag arrives in pieces", () => {
    let acc = initialChunkAccumulator;
    for (const [piece, at] of [["<thi", 1000], ["nk>weigh it", 2000], ["</think>", 4000], ["Result", 4500]] as const) {
      acc = applyChatChunk(acc, { type: "delta", content: piece }, at);
    }
    const done = finishMessage(acc, 9000);
    expect(done).toMatchObject({ content: "Result", reasoning: "weigh it", reasoningSeconds: 3 });
  });

  it("reports no thinking time for a plain answer", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "delta", content: "Hi" }, 1000);
    expect(finishMessage(acc, 2000)).toEqual({ content: "Hi", reasoning: "", reasoningSeconds: undefined, sources: [] });
  });

  it("counts thinking up to the end of the stream when no answer followed", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "reasoning", content: "hmm" }, 1000);
    expect(finishMessage(acc, 3400).reasoningSeconds).toBe(2);
  });

  it("collects the sources of all source chunks", () => {
    let acc = initialChunkAccumulator;
    acc = applyChatChunk(acc, { type: "sources", sources: [{ a: 1 }] });
    acc = applyChatChunk(acc, { type: "sources", sources: [{ b: 2 }] });
    expect(finishMessage(acc).sources).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

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
