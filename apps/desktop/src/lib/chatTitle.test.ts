import { beforeEach, describe, expect, it, vi } from "vitest";

let conversation: { id: string; title: string; model: string; openwebui_chat_id: string | null } | null;
let stored: Array<{ role: string; content: string }>;
let prefs: { aiTitles?: boolean } | null;
let session: { baseUrl: string; token: string } | null;

const getConversation = vi.fn(async () => (conversation ? { ...conversation } : null));
const getMessages = vi.fn(async () => stored);
vi.mock("./chatHistory", () => ({
  getConversation: () => getConversation(),
  getMessages: () => getMessages(),
}));

const renameChat = vi.fn(async (_c: unknown, _title: string) => ({ synced: true }));
vi.mock("./chatSync", () => ({ renameChat: (c: unknown, title: string) => renameChat(c, title) }));
vi.mock("./folderSync", () => ({ getSession: vi.fn(async () => session) }));
vi.mock("./settingsStore", () => ({ getAppPrefs: vi.fn(async () => prefs) }));

const generateTitle = vi.fn(async (..._args: unknown[]): Promise<string | null> => "A fine title");
vi.mock("./openWebUiClient", () => ({ generateTitle: (...args: unknown[]) => generateTitle(...args) }));

const { autoTitle, generateChatTitle } = await import("./chatTitle");

beforeEach(() => {
  conversation = { id: "c1", title: "How do I", model: "gpt", openwebui_chat_id: "S1" };
  stored = [
    { role: "user", content: "How do I cancel my lease?" },
    { role: "assistant", content: "Send a written notice …" },
    { role: "user", content: "and then?" },
  ];
  prefs = null;
  session = { baseUrl: "http://srv", token: "t" };
  vi.clearAllMocks();
});

describe("autoTitle", () => {
  it("keeps short text and cuts long text with an ellipsis", () => {
    expect(autoTitle("hi")).toBe("hi");
    expect(autoTitle("x".repeat(60))).toBe(`${"x".repeat(48)}…`);
  });
});

describe("generateChatTitle", () => {
  it("asks the server about the first exchange only and renames the chat", async () => {
    expect(await generateChatTitle("c1")).toBe(true);
    expect(generateTitle).toHaveBeenCalledWith(
      "http://srv",
      "t",
      "gpt",
      [
        { role: "user", content: "How do I cancel my lease?" },
        { role: "assistant", content: "Send a written notice …" },
      ],
      "S1",
    );
    expect(renameChat).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), "A fine title");
  });

  it("does nothing when switched off, signed out, or before there is a reply", async () => {
    prefs = { aiTitles: false };
    expect(await generateChatTitle("c1")).toBe(false);
    prefs = null;

    session = null;
    expect(await generateChatTitle("c1")).toBe(false);
    session = { baseUrl: "http://srv", token: "t" };

    stored = [{ role: "user", content: "hello" }];
    expect(await generateChatTitle("c1")).toBe(false);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it("keeps the placeholder when the server has no title to offer", async () => {
    generateTitle.mockResolvedValueOnce(null);
    expect(await generateChatTitle("c1")).toBe(false);
    expect(renameChat).not.toHaveBeenCalled();
  });

  it("never throws, and reports a refused rename as unchanged", async () => {
    generateTitle.mockRejectedValueOnce(new Error("could not reach http://srv"));
    expect(await generateChatTitle("c1")).toBe(false);

    renameChat.mockResolvedValueOnce({ synced: false });
    expect(await generateChatTitle("c1")).toBe(false);
  });

  it("renames the chat as it is after the wait, in case it reached the server meanwhile", async () => {
    getConversation
      .mockResolvedValueOnce({ id: "c1", title: "How do I", model: "gpt", openwebui_chat_id: null })
      .mockResolvedValueOnce({ id: "c1", title: "How do I", model: "gpt", openwebui_chat_id: "S-new" });
    await generateChatTitle("c1");
    expect(renameChat).toHaveBeenCalledWith(expect.objectContaining({ openwebui_chat_id: "S-new" }), "A fine title");
  });
});
