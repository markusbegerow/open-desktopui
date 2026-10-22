import { describe, expect, it } from "vitest";
import { joinForServer, splitThinking } from "./reasoning";

describe("splitThinking", () => {
  it("returns plain text untouched", () => {
    expect(splitThinking("Just an answer")).toEqual({ content: "Just an answer", reasoning: "", open: false, seconds: undefined });
  });

  it("separates a closed <think> block from the answer", () => {
    const r = splitThinking("<think>First consider X.\nThen Y.</think>\n\nThe answer is 42.");
    expect(r.reasoning).toBe("First consider X.\nThen Y.");
    expect(r.content).toBe("The answer is 42.");
    expect(r.open).toBe(false);
  });

  it("treats an unterminated <think> as still thinking, so a stream can be shown live", () => {
    const r = splitThinking("<think>Working on it");
    expect(r).toMatchObject({ reasoning: "Working on it", content: "", open: true });
    const after = splitThinking("<think>Done.</think>Result");
    expect(after).toMatchObject({ reasoning: "Done.", content: "Result", open: false });
  });

  it("understands the other tag styles models use", () => {
    expect(splitThinking("<reasoning>a</reasoning>b")).toMatchObject({ reasoning: "a", content: "b" });
    expect(splitThinking("<|begin_of_thought|>a<|end_of_thought|>b")).toMatchObject({ reasoning: "a", content: "b" });
  });

  it("reads the <details> block Open WebUI stores, with its duration", () => {
    const stored =
      '<details type="reasoning" done="true" duration="7">\n<summary>Thought for 7 seconds</summary>\n> step one\n> step two\n</details>\nThe answer.';
    const r = splitThinking(stored);
    expect(r.reasoning).toBe("step one\nstep two");
    expect(r.content).toBe("The answer.");
    expect(r.seconds).toBe(7);
  });

  it("does not touch ordinary details blocks", () => {
    const text = "<details><summary>More</summary>hidden</details>";
    expect(splitThinking(text).content).toBe(text);
  });
});

describe("joinForServer", () => {
  it("round-trips through splitThinking", () => {
    const joined = joinForServer("The answer.", "step one\nstep two", 7);
    expect(joined).toContain('<details type="reasoning" done="true" duration="7">');
    const back = splitThinking(joined);
    expect(back).toMatchObject({ content: "The answer.", reasoning: "step one\nstep two", seconds: 7 });
  });

  it("leaves an answer without thinking as it is", () => {
    expect(joinForServer("Answer", null)).toBe("Answer");
    expect(joinForServer("Answer", "   ")).toBe("Answer");
  });
});
