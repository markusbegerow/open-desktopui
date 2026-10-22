import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  shortcutFor({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("shortcutFor", () => {
  it("maps Ctrl/Cmd + N, K and comma", () => {
    expect(press("n", { ctrlKey: true })).toBe("new-chat");
    expect(press("K", { metaKey: true })).toBe("search");
    expect(press(",", { ctrlKey: true })).toBe("settings");
  });

  it("ignores keys without the modifier", () => {
    expect(press("n")).toBeNull();
    expect(press(",")).toBeNull();
  });

  it("leaves Shift and Alt combinations to the system", () => {
    expect(press("n", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press("k", { ctrlKey: true, altKey: true })).toBeNull();
  });

  it("ignores other keys", () => {
    expect(press("a", { ctrlKey: true })).toBeNull();
    expect(press("c", { ctrlKey: true })).toBeNull();
  });
});
