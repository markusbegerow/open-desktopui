import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_FOLDER, dropTargetAt, exceedsThreshold, useChatDrag } from "./useChatDrag";

function Harness({ onDrop, onClickChat }: { onDrop: (id: string, folder: string | null) => void; onClickChat: () => void }) {
  const { startDrag, consumeClick, overTarget } = useChatDrag({ onDrop });
  return (
    <div>
      <button
        onPointerDown={(e) => startDrag(e, "chat-1", "A chat")}
        onClick={() => {
          if (!consumeClick()) onClickChat();
        }}
      >
        chat
      </button>
      <div data-drop-folder="f1">folder</div>
      <div data-drop-folder={NO_FOLDER}>recent</div>
      <output>{overTarget ?? "-"}</output>
    </div>
  );
}

// jsdom has no layout: the point decides which element "is under the pointer".
function pointAt(el: Element | null) {
  document.elementFromPoint = vi.fn(() => el);
}

afterEach(() => {
  cleanup();
  document.body.classList.remove("is-dragging");
});

describe("drag helpers", () => {
  it("starts a drag only after the pointer moved a few pixels", () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 5, y: 1 })).toBe(true);
  });

  it("finds the folder drop target under a point", () => {
    render(<div data-drop-folder="f9"><span data-testid="inner">x</span></div>);
    pointAt(screen.getByTestId("inner"));
    expect(dropTargetAt(1, 1)).toBe("f9");
    pointAt(document.body);
    expect(dropTargetAt(1, 1)).toBeNull();
  });
});

describe("useChatDrag", () => {
  function drag(to: Element | null, moveBy = 40) {
    const onDrop = vi.fn();
    const onClickChat = vi.fn();
    render(<Harness onDrop={onDrop} onClickChat={onClickChat} />);
    const chat = screen.getByText("chat");
    fireEvent.pointerDown(chat, { button: 0, clientX: 10, clientY: 10, pointerType: "mouse" });
    pointAt(to);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10 + moveBy, clientY: 10 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 10 + moveBy, clientY: 10 }));
    });
    fireEvent.click(chat);
    return { onDrop, onClickChat };
  }

  it("a drag released over nothing moves nothing, and the click that follows does not open the chat", () => {
    const { onDrop, onClickChat } = drag(null);
    expect(onDrop).not.toHaveBeenCalled(); // dropped on nothing
    expect(onClickChat).not.toHaveBeenCalled(); // but the drag still swallowed the click
  });

  it("reports the folder id on a drop", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} onClickChat={vi.fn()} />);
    fireEvent.pointerDown(screen.getByText("chat"), { button: 0, clientX: 0, clientY: 0, pointerType: "mouse" });
    pointAt(screen.getByText("folder"));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 30 }));
    });
    expect(screen.getByRole("status").textContent).toBe("f1");
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 30, clientY: 30 }));
    });
    expect(onDrop).toHaveBeenCalledWith("chat-1", "f1");
  });

  it("drops on the recent list as 'no folder'", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} onClickChat={vi.fn()} />);
    fireEvent.pointerDown(screen.getByText("chat"), { button: 0, clientX: 0, clientY: 0, pointerType: "mouse" });
    pointAt(screen.getByText("recent"));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 30 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 30, clientY: 30 }));
    });
    expect(onDrop).toHaveBeenCalledWith("chat-1", null);
  });

  it("a plain click is still a click", () => {
    const { onDrop, onClickChat } = drag(null, 0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClickChat).toHaveBeenCalledTimes(1);
  });
});
