import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatOptionsBar from "./ChatOptionsBar";
import { I18nProvider } from "../lib/i18n";
import { emptySettings } from "../lib/chatOptions";
import type { OpenWebUiModel } from "../lib/openWebUiClient";

const model = (webSearch = true): OpenWebUiModel => ({
  id: "m",
  name: "M",
  description: null,
  tags: [],
  workspace: false,
  capabilities: { vision: true, webSearch, imageGeneration: true, codeInterpreter: true },
});

function renderBar(over: Partial<React.ComponentProps<typeof ChatOptionsBar>> = {}) {
  const onChange = vi.fn();
  render(
    <I18nProvider language="en">
      <ChatOptionsBar
        settings={emptySettings()}
        onChange={onChange}
        model={model()}
        serverFeatures={null}
        tools={[]}
        {...over}
      />
    </I18nProvider>,
  );
  return onChange;
}

afterEach(cleanup);

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Options" }));

describe("ChatOptionsBar", () => {
  it("offers only the switches the model and the server support", () => {
    renderBar({
      model: model(false),
      serverFeatures: { webSearch: true, imageGeneration: false, codeInterpreter: null, memory: null },
    });
    openMenu();
    expect(screen.queryByRole("switch", { name: "Web search" })).toBeNull(); // model can't
    expect(screen.queryByRole("switch", { name: "Images" })).toBeNull(); // server has it off
    expect(screen.getByRole("switch", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Memory" })).toBeInTheDocument();
  });

  it("flips a switch and reports the new settings", () => {
    const onChange = renderBar();
    openMenu();
    const button = screen.getByRole("switch", { name: "Web search" });
    expect(button).toHaveAttribute("aria-checked", "false");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].features.webSearch).toBe(true);
  });

  it("lists tools and toggles them by id", () => {
    const onChange = renderBar({ tools: [{ id: "calc", name: "Calculator", description: "Does sums" }] });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByLabelText("Calculator"));
    expect(onChange.mock.calls[0][0].features.toolIds).toEqual(["calc"]);
  });

  it("commits the system prompt and numbers when the field is left, and clears an empty number", () => {
    const onChange = renderBar();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Chat settings" }));

    const system = screen.getByPlaceholderText("Applies to this chat, after the folder's prompt.");
    fireEvent.change(system, { target: { value: "Be brief" } });
    expect(onChange).not.toHaveBeenCalled(); // typing alone doesn't save
    fireEvent.blur(system);
    expect(onChange.mock.calls[0][0].params.system).toBe("Be brief");

    const temperature = screen.getByLabelText("Temperature");
    fireEvent.change(temperature, { target: { value: "0.3" } });
    fireEvent.blur(temperature);
    expect(onChange.mock.calls[1][0].params.temperature).toBe(0.3);
  });

  it("splits stop words at commas and resets only the settings", () => {
    const onChange = renderBar();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Chat settings" }));
    const stop = screen.getByLabelText("Stop words");
    fireEvent.change(stop, { target: { value: "END, STOP ,," } });
    fireEvent.blur(stop);
    expect(onChange.mock.calls[0][0].params.stop).toEqual(["END", "STOP"]);
  });
});
