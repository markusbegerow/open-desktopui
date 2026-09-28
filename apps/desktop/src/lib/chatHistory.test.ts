import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake account-scoped tables, good enough to verify chatHistory.ts never
// crosses account boundaries — the real invariant this module promises.
let conversations: Array<{ id: string; account_id: string | null; [k: string]: unknown }>;

const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.startsWith("INSERT INTO conversations")) {
    const [id, title, model, created_at, knowledge_ids, account_id] = params;
    conversations.push({ id, title, model, created_at, knowledge_ids, account_id } as never);
  }
  return { rowsAffected: 1 };
});

const select = vi.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FROM conversations WHERE account_id")) {
    const [accountId] = params;
    return conversations.filter((c) => c.account_id === accountId);
  }
  return [];
});

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn(async () => ({ execute, select })) },
}));

let currentAccountId: string | undefined;
vi.mock("./settingsStore", () => ({
  getOpenWebUiConfig: vi.fn(async () => (currentAccountId ? { accountId: currentAccountId } : null)),
}));

beforeEach(() => {
  conversations = [];
  currentAccountId = undefined;
  execute.mockClear();
  select.mockClear();
  vi.resetModules();
});

describe("account scoping", () => {
  it("tags a new conversation with the current account", async () => {
    currentAccountId = "server-a|user-1";
    const { createConversation } = await import("./chatHistory");
    const conv = await createConversation("gpt-4", "Hello");
    expect(conv.account_id).toBe("server-a|user-1");
  });

  it("never returns another account's conversations from listConversations", async () => {
    const { createConversation, listConversations } = await import("./chatHistory");

    currentAccountId = "server-a|user-1";
    await createConversation("gpt-4", "Account A chat");

    currentAccountId = "server-b|user-2";
    await createConversation("gpt-4", "Account B chat");

    const accountBResults = await listConversations();
    expect(accountBResults).toHaveLength(1);
    expect(accountBResults[0].title).toBe("Account B chat");

    currentAccountId = "server-a|user-1";
    const accountAResults = await listConversations();
    expect(accountAResults).toHaveLength(1);
    expect(accountAResults[0].title).toBe("Account A chat");
  });

  it("falls back to the fixed 'unscoped' bucket when signed out", async () => {
    currentAccountId = undefined;
    const { createConversation, listConversations } = await import("./chatHistory");
    await createConversation("gpt-4", "No account");

    const results = await listConversations();
    expect(results).toHaveLength(1);
    expect(results[0].account_id).toBe("unscoped");
  });
});
