import { describe, expect, it } from "vitest";
import { followScrollTop, isUserScroll } from "./scroll";

describe("followScrollTop", () => {
  it("follows the bottom for a short question", () => {
    // reply starts near the bottom of a 1000px page in a 600px viewport
    expect(followScrollTop({ scrollHeight: 1000, clientHeight: 600, replyTop: 900 })).toBe(400);
  });

  it("pins the reply start when a long question pushes it below the fold", () => {
    // question is 2000px tall: reply starts at 2100, page is 2600 high
    expect(followScrollTop({ scrollHeight: 2600, clientHeight: 600, replyTop: 2100 })).toBe(2000);
  });

  it("stops following once the reply is taller than the viewport", () => {
    expect(followScrollTop({ scrollHeight: 5000, clientHeight: 600, replyTop: 1000 })).toBe(992);
  });

  it("never returns a negative position", () => {
    expect(followScrollTop({ scrollHeight: 300, clientHeight: 600, replyTop: 0 })).toBe(0);
  });
});

describe("isUserScroll", () => {
  it("ignores scroll events at our own position", () => {
    expect(isUserScroll(400, 400)).toBe(false);
    expect(isUserScroll(401, 400)).toBe(false);
  });
  it("detects the user moving away", () => {
    expect(isUserScroll(300, 400)).toBe(true);
    expect(isUserScroll(520, 400)).toBe(true);
  });
});
