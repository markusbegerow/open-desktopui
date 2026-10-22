import { describe, expect, it } from "vitest";
import { commandQuery, customVariables, fillVariables, matchPrompts, usesVariable } from "./promptVars";

const ctx = { now: new Date(2026, 9, 21, 8, 5, 9), userName: "Mara", language: "de", clipboard: "copied text" };

describe("customVariables", () => {
  it("finds the names to ask for, once each, ignoring the system ones and field options", () => {
    const text = "Dear {{ name }}, {{CURRENT_DATE}} {{topic | text:required}} {{name}} {{USER_NAME}}";
    expect(customVariables(text)).toEqual(["name", "topic"]);
  });

  it("finds none in plain text", () => {
    expect(customVariables("No variables { here }")).toEqual([]);
  });

  it("tells whether a name is used", () => {
    expect(usesVariable("Paste: {{CLIPBOARD}}", "CLIPBOARD")).toBe(true);
    expect(usesVariable("Nothing", "CLIPBOARD")).toBe(false);
  });
});

describe("fillVariables", () => {
  it("fills system variables from the context and custom ones from the values", () => {
    const out = fillVariables(
      "Hi {{USER_NAME}} ({{USER_LANGUAGE}}) on {{CURRENT_DATE}} at {{CURRENT_TIME}}: {{ topic }} / {{CLIPBOARD}}",
      { topic: "taxes" },
      ctx,
    );
    expect(out).toBe("Hi Mara (de) on 2026-10-21 at 08:05:09: taxes / copied text");
  });

  it("formats date and time fields", () => {
    expect(fillVariables("{{CURRENT_DATETIME}}|{{CURRENT_WEEKDAY}}", {}, ctx)).toBe("2026-10-21 08:05:09|Wednesday");
  });

  it("leaves a variable it has no value for, and fills an empty answer with nothing", () => {
    expect(fillVariables("A {{missing}} B", {}, ctx)).toBe("A {{missing}} B");
    expect(fillVariables("A {{x}} B", { x: "" }, ctx)).toBe("A  B");
  });

  it("does not run a value as a template again", () => {
    expect(fillVariables("{{a}}", { a: "{{USER_NAME}}" }, ctx)).toBe("{{USER_NAME}}");
  });
});

describe("commandQuery", () => {
  it("is the text after the slash while still typing the command", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/sum")).toBe("sum");
  });

  it("is null for anything else", () => {
    expect(commandQuery("sum")).toBeNull();
    expect(commandQuery("/sum this")).toBeNull();
    expect(commandQuery("text /sum")).toBeNull();
    expect(commandQuery("")).toBeNull();
  });
});

describe("matchPrompts", () => {
  const prompts = [
    { id: "1", command: "summarize", name: "Summarize text", content: "x" },
    { id: "2", command: "translate", name: "Translate", content: "x" },
    { id: "3", command: "sum-up", name: "Quick recap", content: "x" },
    { id: "4", command: "email", name: "Write an email to summarize", content: "x" },
  ];

  it("lists every prompt for a bare slash", () => {
    expect(matchPrompts(prompts, "")).toHaveLength(4);
  });

  it("puts commands that start with the text first, then ones that contain it", () => {
    expect(matchPrompts(prompts, "sum").map((p) => p.id)).toEqual(["1", "3", "4"]);
  });

  it("ignores case and respects the limit", () => {
    expect(matchPrompts(prompts, "TRANS").map((p) => p.id)).toEqual(["2"]);
    expect(matchPrompts(prompts, "", 2)).toHaveLength(2);
    expect(matchPrompts(prompts, "zzz")).toEqual([]);
  });
});
