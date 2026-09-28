import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the plain (non-secret) tauri-plugin-store file —
// good enough to exercise settingsStore.ts's own merge/migration logic
// without a real Tauri backend.
const storeData = new Map<string, unknown>();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async (key: string) => storeData.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      storeData.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      storeData.delete(key);
    }),
  })),
}));

const secretData = new Map<string, string>();

vi.mock("./secureStore", () => ({
  getSecret: vi.fn(async (key: string) => secretData.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => {
    secretData.set(key, value);
  }),
  deleteSecret: vi.fn(async (key: string) => {
    secretData.delete(key);
  }),
}));

beforeEach(() => {
  storeData.clear();
  secretData.clear();
  vi.resetModules(); // settingsStore.ts caches its store promise at module scope
});

describe("setAppPrefs", () => {
  it("merges into existing prefs rather than replacing them", async () => {
    const { setAppPrefs, getAppPrefs } = await import("./settingsStore");
    await setAppPrefs({ theme: "dark" });
    await setAppPrefs({ displayName: "Ada" });

    const prefs = await getAppPrefs();
    expect(prefs).toEqual({ theme: "dark", displayName: "Ada" });
  });
});

describe("OpenWebUiConfig secret handling", () => {
  it("keeps apiKey out of the plain store and round-trips it via secureStore", async () => {
    const { setOpenWebUiConfig, getOpenWebUiConfig } = await import("./settingsStore");
    await setOpenWebUiConfig({ baseUrl: "http://localhost:3000", apiKey: "sk-secret" });

    expect(JSON.stringify([...storeData.values()])).not.toContain("sk-secret");

    const config = await getOpenWebUiConfig();
    expect(config?.apiKey).toBe("sk-secret");
    expect(config?.baseUrl).toBe("http://localhost:3000");
  });

  it("migrates a leftover plaintext apiKey into secure storage on read", async () => {
    // Simulate a pre-Stronghold record written directly to the plain store.
    storeData.set("openwebui", { baseUrl: "http://localhost:3000", apiKey: "legacy-plaintext" });

    const { getOpenWebUiConfig } = await import("./settingsStore");
    const config = await getOpenWebUiConfig();

    expect(config?.apiKey).toBe("legacy-plaintext");
    expect(secretData.get("openwebui.apiKey")).toBe("legacy-plaintext");
    expect((storeData.get("openwebui") as { apiKey?: string })?.apiKey).toBeUndefined();
  });
});
