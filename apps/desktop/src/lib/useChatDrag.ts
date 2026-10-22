import { PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";

// Dragging a chat in the sidebar onto a folder (or back to "Chats").
//
// This uses pointer events on purpose: the app's webview has Tauri's file-drop
// handler on (for dropping files into a chat), and with it on, HTML5
// dragstart/drop events inside the page do not fire on Windows.

/** `data-drop-folder` value of the drop target that means "no folder". */
export const NO_FOLDER = "none";
export const DRAG_THRESHOLD = 5;
const HOVER_EXPAND_MS = 600;

export function exceedsThreshold(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;
}

/** The folder id (or NO_FOLDER) of the drop target under the point, if any. */
export function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const target = el?.closest<HTMLElement>("[data-drop-folder]");
  return target?.dataset.dropFolder ?? null;
}

export interface DragGhost {
  title: string;
  x: number;
  y: number;
}

interface Options {
  /** `folderId` is null when dropped on "Chats" (take the chat out of its folder). */
  onDrop: (conversationId: string, folderId: string | null) => void;
  /** The pointer rested on a folder for a moment; the sidebar opens it. */
  onHoverFolder?: (folderId: string) => void;
}

export function useChatDrag({ onDrop, onHoverFolder }: Options) {
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [overTarget, setOverTarget] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const callbacks = useRef({ onDrop, onHoverFolder });
  callbacks.current = { onDrop, onHoverFolder };

  const startDrag = useCallback((e: ReactPointerEvent, id: string, title: string) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const origin = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let target: string | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;

    const setTarget = (next: string | null) => {
      if (next === target) return;
      target = next;
      setOverTarget(next);
      clearTimeout(hoverTimer);
      if (next && next !== NO_FOLDER) {
        hoverTimer = setTimeout(() => callbacks.current.onHoverFolder?.(next), HOVER_EXPAND_MS);
      }
    };

    const onMove = (ev: PointerEvent) => {
      const point = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (!exceedsThreshold(origin, point)) return;
        dragging = true;
        document.body.classList.add("is-dragging");
      }
      setGhost({ title, ...point });
      setTarget(dropTargetAt(point.x, point.y));
    };

    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(hoverTimer);
      document.body.classList.remove("is-dragging");
      setGhost(null);
      setOverTarget(null);
      if (!dragging) return;
      // The click that follows a drag's pointer-up must not open the chat.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (drop && target) callbacks.current.onDrop(id, target === NO_FOLDER ? null : target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
  }, []);

  /** True once for the click that ends a drag; the caller then skips its click action. */
  const consumeClick = useCallback(() => {
    const was = suppressClick.current;
    suppressClick.current = false;
    return was;
  }, []);

  return { ghost, overTarget, startDrag, consumeClick };
}
