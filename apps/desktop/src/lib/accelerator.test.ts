import { describe, expect, it } from "vitest";
import { acceleratorFrom, acceleratorLabel } from "./accelerator";

const press = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  acceleratorFrom({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("acceleratorFrom", () => {
  it("builds the string the plugin expects", () => {
    expect(press("Space", { ctrlKey: true, altKey: true })).toBe("CommandOrControl+Alt+Space");
    expect(press("KeyJ", { metaKey: true, shiftKey: true })).toBe("CommandOrControl+Shift+J");
    expect(press("Digit1", { altKey: true })).toBe("Alt+1");
    expect(press("F9", { ctrlKey: true })).toBe("CommandOrControl+F9");
    expect(press("ArrowUp", { ctrlKey: true })).toBe("CommandOrControl+Up");
  });

  it("needs a modifier, so plain typing is never hijacked", () => {
    expect(press("KeyA")).toBeNull();
    expect(press("Space")).toBeNull();
    expect(press("KeyA", { shiftKey: false })).toBeNull();
  });

  it("waits while only modifier keys are down and ignores unnamed keys", () => {
    expect(press("ControlLeft", { ctrlKey: true })).toBeNull();
    expect(press("ShiftLeft", { shiftKey: true })).toBeNull();
    expect(press("MediaPlayPause", { ctrlKey: true })).toBeNull();
  });
});

describe("acceleratorLabel", () => {
  it("shows Ctrl for the portable modifier", () => {
    expect(acceleratorLabel("CommandOrControl+Alt+Space")).toBe("Ctrl+Alt+Space");
  });
});
