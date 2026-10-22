import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MarkdownBody from "./MarkdownBody";
import { ReasoningBlock, SourcesList } from "./MessageExtras";
import { I18nProvider } from "../lib/i18n";

describe("MarkdownBody", () => {
  it("renders formulas with KaTeX, in the forms models write them", () => {
    const { container } = render(
      <MarkdownBody text={"Energy \\(E=mc^2\\) and\n\n$$\\int_0^1 x\\,dx = \\tfrac12$$\n\nand \\[a^2+b^2=c^2\\]"} />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves dollar amounts alone", () => {
    const { container } = render(<MarkdownBody text="It costs $5 and $10 in total." />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("It costs $5 and $10 in total.");
  });

  it("does not turn code into formulas", () => {
    const { container } = render(<MarkdownBody text={"```js\nconst x = '\\\\(a\\\\)';\n```"} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("pre code")).not.toBeNull();
  });

  it("keeps a mermaid block as code while the reply is still streaming", () => {
    const { container } = render(<MarkdownBody streaming text={"```mermaid\ngraph TD\nA-->B\n```"} />);
    expect(container.querySelector(".mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("graph TD");
  });

  it("still renders tables and highlighted code", () => {
    const { container } = render(
      <MarkdownBody text={"| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst n: number = 1;\n```"} />,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("code.hljs, code[class*='language-']")).not.toBeNull();
  });
});

describe("answer extras", () => {
  it("shows how long the model thought, or that it still is", () => {
    const { rerender } = render(
      <I18nProvider language="en">
        <ReasoningBlock text="step one" seconds={7} />
      </I18nProvider>,
    );
    expect(screen.getByText("Thought for 7 seconds")).toBeInTheDocument();
    expect(screen.getByText("step one")).toBeInTheDocument();

    rerender(
      <I18nProvider language="en">
        <ReasoningBlock text="step one" thinking />
      </I18nProvider>,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("lists sources by name, with a snippet, and links web pages", () => {
    render(
      <I18nProvider language="en">
        <SourcesList
          sources={[
            { source: { name: "handbook.pdf" }, document: ["Chapter one says…"] },
            { source: { name: "Example" }, metadata: [{ source: "https://example.com/a" }] },
          ]}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Sources (2)")).toBeInTheDocument();
    expect(screen.getByText("handbook.pdf")).toBeInTheDocument();
    expect(screen.getByText("Chapter one says…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Example" })).toHaveAttribute("href", "https://example.com/a");
  });

  it("shows nothing when the sources are unusable", () => {
    const { container } = render(
      <I18nProvider language="en">
        <SourcesList sources={[null, 5]} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
