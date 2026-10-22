import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Composer from "./Composer";
import { I18nProvider } from "../lib/i18n";
import type { LibraryPrompt } from "../lib/library";

const prompts: LibraryPrompt[] = [
  { id: "1", command: "summarize", name: "Summarize", content: "Summarize this text:\n{{CLIPBOARD}}" },
  { id: "2", command: "greet", name: "Greeting", content: "Write a greeting for {{recipient}} on {{CURRENT_DATE}}." },
  { id: "3", command: "plain", name: "Plain", content: "Just a plain prompt." },
];

vi.mock("../lib/useLibraryPrompts", () => ({ useLibraryPrompts: () => prompts }));
vi.mock("../lib/settingsStore", () => ({ getAppPrefs: vi.fn(async () => ({ displayName: "Mara" })) }));

afterEach(cleanup);

function renderComposer() {
  const onSend = vi.fn();
  render(
    <I18nProvider language="en">
      <Composer onSend={onSend} disabled={false} attachments={[]} />
    </I18nProvider>,
  );
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { box, onSend };
}

const type = (box: HTMLTextAreaElement, text: string) => fireEvent.change(box, { target: { value: text } });

describe("prompt palette", () => {
  it("opens for a slash command and filters while typing", () => {
    const { box } = renderComposer();
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "/");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    type(box, "/gre");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["/greetGreeting"]);
    type(box, "/gre now"); // a space ends the command
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "hello /gre"); // only at the start of the message
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("inserts a plain prompt with Enter instead of sending the message", async () => {
    const { box, onSend } = renderComposer();
    type(box, "/pla");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("Just a plain prompt."));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves through the list with the arrow keys and wraps around", async () => {
    const { box } = renderComposer();
    type(box, "/");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("Just a plain prompt."));
  });

  it("closes with Escape and leaves the text alone", () => {
    const { box } = renderComposer();
    type(box, "/sum");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("/sum");
  });

  it("asks for the prompt's own variables and fills the system ones itself", async () => {
    const { box } = renderComposer();
    type(box, "/greet");
    fireEvent.keyDown(box, { key: "Tab" });

    const field = await screen.findByRole("textbox", { name: "recipient" });
    fireEvent.change(field, { target: { value: "Anna" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(box.value).toMatch(/^Write a greeting for Anna on \d{4}-\d{2}-\d{2}\.$/));
  });

  it("fills the clipboard variable, and carries on when the clipboard cannot be read", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "copied words") },
    });
    const { box } = renderComposer();
    type(box, "/summ");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("Summarize this text:\ncopied words"));

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    type(box, "/summ");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("Summarize this text:\n"));
  });
});
