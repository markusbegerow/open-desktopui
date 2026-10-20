import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAvatar } from "./avatar";

const prefs: Record<string, unknown> = {};
const setAppPrefs = vi.fn(async (partial: Record<string, unknown>) => {
  Object.assign(prefs, partial);
});
const fetchProfileImage = vi.fn();

vi.mock("./settingsStore", () => ({ setAppPrefs: (p: Record<string, unknown>) => setAppPrefs(p) }));
vi.mock("./openWebUiClient", () => ({
  fetchProfileImage: (...a: unknown[]) => fetchProfileImage(...a),
}));
vi.mock("./avatar", async (orig) => ({
  ...(await orig<typeof import("./avatar")>()),
  cropToSquareDataUrl: vi.fn(async () => "data:image/webp;base64,CROPPED"),
}));

beforeEach(() => {
  for (const k of Object.keys(prefs)) delete prefs[k];
  setAppPrefs.mockClear();
  fetchProfileImage.mockReset();
});

describe("syncServerAvatar", () => {
  it("downloads a server-hosted image and stores it", async () => {
    fetchProfileImage.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const { syncServerAvatar } = await import("./serverAvatar");
    const changed = await syncServerAvatar("https://owui.test", "tok", {
      profileImageUrl: "/api/v1/users/1/profile/image",
    });
    expect(changed).toBe(true);
    expect(fetchProfileImage).toHaveBeenCalledWith("https://owui.test", "tok", "/api/v1/users/1/profile/image");
    expect(prefs.serverAvatar).toBe("data:image/webp;base64,CROPPED");
  });

  it("decodes an inline data URL without calling the server", async () => {
    const { syncServerAvatar } = await import("./serverAvatar");
    await syncServerAvatar("https://owui.test", "tok", { profileImageUrl: "data:image/png;base64,AAAA" });
    expect(fetchProfileImage).not.toHaveBeenCalled();
    expect(prefs.serverAvatar).toBe("data:image/webp;base64,CROPPED");
  });

  it("clears the server avatar for the placeholder image (initials)", async () => {
    prefs.serverAvatar = "old";
    const { syncServerAvatar } = await import("./serverAvatar");
    await syncServerAvatar("https://owui.test", "tok", { profileImageUrl: "/user.png" });
    expect(fetchProfileImage).not.toHaveBeenCalled();
    expect(prefs.serverAvatar).toBeUndefined();
  });

  it("keeps the previous image when the download fails", async () => {
    prefs.serverAvatar = "old";
    fetchProfileImage.mockRejectedValue(new Error("offline"));
    const { syncServerAvatar } = await import("./serverAvatar");
    const changed = await syncServerAvatar("https://owui.test", "tok", { profileImageUrl: "/api/v1/users/1/profile/image" });
    expect(changed).toBe(false);
    expect(prefs.serverAvatar).toBe("old");
  });
});

describe("resolveAvatar precedence", () => {
  it("manual upload beats the server image", () => {
    expect(resolveAvatar({ avatar: "manual", serverAvatar: "server" })).toBe("manual");
  });
  it("falls back to the server image after the manual one is removed", () => {
    expect(resolveAvatar({ serverAvatar: "server" })).toBe("server");
  });
  it("returns undefined (initials) when neither exists", () => {
    expect(resolveAvatar({})).toBeUndefined();
    expect(resolveAvatar(null)).toBeUndefined();
  });
});
