import { beforeEach, describe, expect, it, vi } from "vitest";

let prefs: Record<string, unknown> = {};
const setAppPrefs = vi.fn(async (patch: Record<string, unknown>) => void (prefs = { ...prefs, ...patch }));
vi.mock("./settingsStore", () => ({
  getAppPrefs: vi.fn(async () => prefs),
  setAppPrefs: (patch: Record<string, unknown>) => setAppPrefs(patch),
}));

const check = vi.fn(async (): Promise<{ version: string } | null> => null);
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));

const { UPDATE_CHECK_INTERVAL_MS, checkForUpdateQuietly, isNewerVersion, knownUpdate, shouldCheck } = await import("./updateCheck");

const NOW = 1_800_000_000_000;

beforeEach(() => {
  prefs = {};
  vi.clearAllMocks();
  check.mockResolvedValue(null);
});

describe("shouldCheck", () => {
  it("checks the first time and then once a day", () => {
    expect(shouldCheck(NOW, undefined, undefined)).toBe(true);
    expect(shouldCheck(NOW, NOW - 1000, true)).toBe(false);
    expect(shouldCheck(NOW, NOW - UPDATE_CHECK_INTERVAL_MS, true)).toBe(true);
  });

  it("never checks when switched off", () => {
    expect(shouldCheck(NOW, undefined, false)).toBe(false);
  });

  it("does not stay silent forever after the clock was set back", () => {
    expect(shouldCheck(NOW, NOW + 10 * UPDATE_CHECK_INTERVAL_MS, true)).toBe(true);
  });
});

describe("isNewerVersion", () => {
  it("compares numerically, not as text", () => {
    expect(isNewerVersion("0.10.0", "0.9.5")).toBe(true);
    expect(isNewerVersion("0.1.4", "0.1.4")).toBe(false);
    expect(isNewerVersion("0.1.3", "0.1.4")).toBe(false);
    expect(isNewerVersion("1.0", "0.9.9")).toBe(true);
  });
});

describe("knownUpdate", () => {
  it("shows an earlier find only while it is newer than the running app", async () => {
    prefs = { availableUpdateVersion: "0.2.0" };
    expect(await knownUpdate("0.1.4")).toBe("0.2.0");
    expect(await knownUpdate("0.2.0")).toBeNull();
    prefs = { availableUpdateVersion: "" };
    expect(await knownUpdate("0.1.4")).toBeNull();
    prefs = {};
    expect(await knownUpdate("0.1.4")).toBeNull();
  });
});

describe("checkForUpdateQuietly", () => {
  it("reports a new version once, and remembers that it looked", async () => {
    check.mockResolvedValue({ version: "0.2.0" });
    expect(await checkForUpdateQuietly(NOW)).toEqual({ version: "0.2.0", isNew: true });
    expect(prefs).toMatchObject({ lastUpdateCheck: NOW, notifiedUpdateVersion: "0.2.0" });

    // a day later the same version is still there, but no second notification
    expect(await checkForUpdateQuietly(NOW + UPDATE_CHECK_INTERVAL_MS)).toEqual({ version: "0.2.0", isNew: false });
  });

  it("is quiet when up to date and still counts as a check", async () => {
    expect(await checkForUpdateQuietly(NOW)).toBeNull();
    expect(prefs.lastUpdateCheck).toBe(NOW);
  });

  it("does not ask the server when it isn't due or is switched off", async () => {
    prefs = { lastUpdateCheck: NOW - 1000 };
    expect(await checkForUpdateQuietly(NOW)).toBeNull();
    prefs = { autoUpdateCheck: false };
    expect(await checkForUpdateQuietly(NOW)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("remembers the found version and forgets it once up to date", async () => {
    check.mockResolvedValue({ version: "0.2.0" });
    await checkForUpdateQuietly(NOW);
    expect(prefs.availableUpdateVersion).toBe("0.2.0");
    check.mockResolvedValue(null);
    await checkForUpdateQuietly(NOW + UPDATE_CHECK_INTERVAL_MS);
    expect(prefs.availableUpdateVersion).toBe("");
  });

  it("swallows a failed check and tries again next time", async () => {
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON"));
    expect(await checkForUpdateQuietly(NOW)).toBeNull();
    expect(prefs.lastUpdateCheck).toBeUndefined();
  });
});
