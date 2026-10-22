import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1 }));
let rows: Array<{ conversation_id: string; content?: string; tag?: string }> = [];
const select = vi.fn(async (_sql: string, _params: unknown[] = []) => rows);

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn(async () => ({ execute, select })) },
}));
vi.mock("./settingsStore", () => ({
  getOpenWebUiConfig: vi.fn(async () => ({ accountId: "srv|u1" })),
}));

beforeEach(() => {
  rows = [];
  execute.mockClear();
  select.mockClear();
  vi.resetModules();
});

describe("tag ids", () => {
  it("normalizes names the way Open WebUI does", async () => {
    const { tagId, tagLabel } = await import("./chatHistory");
    expect(tagId("  Side  Project ")).toBe("side_project");
    expect(tagLabel("side_project")).toBe("side project");
  });
});

describe("snippetAround", () => {
  it("cuts a window around the match and marks the cut ends", async () => {
    const { snippetAround } = await import("./chatHistory");
    const text = `${"a ".repeat(60)}needle${" b".repeat(60)}`;
    const snippet = snippetAround(text, "NEEDLE", 10);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThan(40);
  });

  it("returns short texts whole and collapses whitespace", async () => {
    const { snippetAround } = await import("./chatHistory");
    expect(snippetAround("hello\n  world", "world")).toBe("hello world");
  });
});

describe("searchMessages", () => {
  it("ignores queries shorter than two characters without touching the database", async () => {
    const { searchMessages } = await import("./chatHistory");
    expect(await searchMessages(" a ")).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("is scoped to the current account and keeps one hit per conversation, newest first", async () => {
    rows = [
      { conversation_id: "c1", content: "newest mention of Kündigung here" },
      { conversation_id: "c2", content: "another kündigung" },
      { conversation_id: "c1", content: "older kündigung text" },
    ];
    const { searchMessages } = await import("./chatHistory");
    const hits = await searchMessages("Kündigung");

    expect(select.mock.calls[0][1]).toEqual(["srv|u1", "Kündigung", 200]);
    expect(hits.map((h) => h.conversationId)).toEqual(["c1", "c2"]);
    expect(hits[0].snippet).toContain("newest mention");
  });
});

describe("setConversationTags", () => {
  it("replaces the list, normalizing and de-duplicating", async () => {
    const { setConversationTags } = await import("./chatHistory");
    await setConversationTags("c1", ["Work", "work", "Side Project", ""]);
    const sql = execute.mock.calls.map((c) => c[0]);
    expect(sql[0]).toContain("DELETE FROM conversation_tags");
    const inserted = execute.mock.calls.filter((c) => c[0].startsWith("INSERT")).map((c) => c[1]?.[1]);
    expect(inserted).toEqual(["work", "side_project"]);
  });
});

describe("listConversationTags", () => {
  it("groups the account's tags by conversation", async () => {
    rows = [
      { conversation_id: "c1", tag: "a" },
      { conversation_id: "c1", tag: "b" },
      { conversation_id: "c2", tag: "a" },
    ];
    const { listConversationTags } = await import("./chatHistory");
    const tags = await listConversationTags();
    expect(tags.get("c1")).toEqual(["a", "b"]);
    expect(tags.get("c2")).toEqual(["a"]);
    expect(select.mock.calls[0][1]).toEqual(["srv|u1"]);
  });
});
