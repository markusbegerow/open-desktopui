import { describe, expect, it } from "vitest";
import { prepareMath } from "./mathText";

describe("prepareMath", () => {
  it("turns \\( \\) into inline $$ and \\[ \\] into a display block", () => {
    expect(prepareMath("Energy is \\(E=mc^2\\) here")).toBe("Energy is $$E=mc^2$$ here");
    // the block gets blank lines around it, whatever surrounded it before
    expect(prepareMath("See\n\\[x^2 + y^2\\]\nabove")).toBe("See\n\n\n$$\nx^2 + y^2\n$$\n\n\nabove");
  });

  it("leaves $$ blocks and plain dollar amounts alone", () => {
    expect(prepareMath("$$a+b$$")).toBe("$$a+b$$");
    expect(prepareMath("It costs $5 and $10.")).toBe("It costs $5 and $10.");
  });

  it("does not touch code", () => {
    const fenced = "```js\nconst s = '\\(not math\\)';\n```";
    expect(prepareMath(fenced)).toBe(fenced);
    expect(prepareMath("use `\\(x\\)` literally")).toBe("use `\\(x\\)` literally");
    expect(prepareMath("a `code` and \\(m\\)")).toBe("a `code` and $$m$$");
  });

  it("passes text without math through", () => {
    expect(prepareMath("Hello\nworld")).toBe("Hello\nworld");
    expect(prepareMath("")).toBe("");
  });
});
