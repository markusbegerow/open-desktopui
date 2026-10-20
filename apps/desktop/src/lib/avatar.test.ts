import { describe, expect, it } from "vitest";
import { avatarInitial, encodeAvatarCanvas, hasTransparentPixels, isAllowedAvatarExtension, isDefaultProfileImage } from "./avatar";

describe("avatar helpers", () => {
  it("accepts png, jpg, jpeg and webp case-insensitively", () => {
    for (const p of ["a.png", "b.JPG", "c.jpeg", "d.WebP", "C:\\x\\y.png"]) {
      expect(isAllowedAvatarExtension(p)).toBe(true);
    }
  });

  it("rejects other extensions", () => {
    for (const p of ["a.gif", "b.svg", "c.txt", "noext"]) {
      expect(isAllowedAvatarExtension(p)).toBe(false);
    }
  });

  it("treats missing and placeholder Open WebUI images as no avatar", () => {
    for (const u of [null, undefined, "", "/user.png", "https://x.test/user.png?v=1", "/static/favicon.png"]) {
      expect(isDefaultProfileImage(u)).toBe(true);
    }
    expect(isDefaultProfileImage("data:image/png;base64,AAAA")).toBe(false);
    expect(isDefaultProfileImage("/api/v1/users/1/profile/image")).toBe(false);
  });

  it("derives the initial with a fallback", () => {
    expect(avatarInitial("markus")).toBe("M");
    expect(avatarInitial(undefined)).toBe("?");
    expect(avatarInitial("")).toBe("?");
  });

  it("detects transparent pixels from RGBA data", () => {
    expect(hasTransparentPixels([1, 2, 3, 255, 4, 5, 6, 255])).toBe(false);
    expect(hasTransparentPixels([1, 2, 3, 255, 4, 5, 6, 0])).toBe(true);
  });

  describe("encodeAvatarCanvas", () => {
    function canvasThatEncodes(supported: string[]) {
      return {
        toDataURL: (type?: string) => (supported.includes(type!) ? `data:${type};base64,X` : "data:image/png;base64,X"),
      };
    }
    it("uses WebP when the webview can encode it", () => {
      expect(encodeAvatarCanvas(canvasThatEncodes(["image/webp"]), false)).toMatch(/^data:image\/webp/);
    });
    it("falls back to JPEG for opaque pictures on WebKit", () => {
      expect(encodeAvatarCanvas(canvasThatEncodes(["image/jpeg"]), false)).toMatch(/^data:image\/jpeg/);
    });
    it("keeps PNG when the picture has transparency and WebP is unavailable", () => {
      expect(encodeAvatarCanvas(canvasThatEncodes([]), true)).toMatch(/^data:image\/png/);
    });
  });
});
