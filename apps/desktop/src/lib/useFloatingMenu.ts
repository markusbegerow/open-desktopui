import { useLayoutEffect, useEffect, useRef, useState, CSSProperties, RefObject } from "react";

export interface FloatingMenuOptions {
  axis?: "vertical" | "horizontal";
  placement?: "up" | "down" | "left" | "right" | "auto";
  align?: "left" | "right" | "top";
  gap?: number;
}

const EDGE_PADDING = 8;

// Just the shape of DOMRect this needs — lets tests pass plain objects
// instead of constructing real DOMRects.
export interface FloatingRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingPosition {
  top: number;
  left: number;
}

// Pure clamp/flip arithmetic pulled out of the hook's `useLayoutEffect` below
// so it's unit-testable with synthetic rects — no real layout/DOM needed.
export function computeFloatingPosition(
  triggerRect: FloatingRect,
  menuRect: FloatingRect,
  viewport: { width: number; height: number },
  opts: Required<Pick<FloatingMenuOptions, "axis" | "placement" | "align" | "gap">>,
): FloatingPosition {
  const { axis, placement, align, gap } = opts;
  const vw = viewport.width;
  const vh = viewport.height;

  let top: number;
  let left: number;

  if (axis === "vertical") {
    const roomBelow = vh - triggerRect.bottom;
    const roomAbove = triggerRect.top;
    const openUp = placement === "up" || (placement === "auto" && roomBelow < menuRect.height && roomAbove > roomBelow);
    top = openUp ? triggerRect.top - gap - menuRect.height : triggerRect.bottom + gap;
    left = align === "left" ? triggerRect.left : triggerRect.right - menuRect.width;
  } else {
    const roomRight = vw - triggerRect.right;
    const roomLeft = triggerRect.left;
    const openLeft = placement === "left" || (placement === "auto" && roomRight < menuRect.width && roomLeft > roomRight);
    left = openLeft ? triggerRect.left - gap - menuRect.width : triggerRect.right + gap;
    top = align === "top" ? triggerRect.top : triggerRect.bottom - menuRect.height;
  }

  top = Math.min(Math.max(top, EDGE_PADDING), vh - menuRect.height - EDGE_PADDING);
  left = Math.min(Math.max(left, EDGE_PADDING), vw - menuRect.width - EDGE_PADDING);

  return { top, left };
}

export function useFloatingMenu<T extends HTMLElement = HTMLElement, M extends HTMLElement = HTMLElement>(
  open: boolean,
  onDismiss: () => void,
  opts: FloatingMenuOptions = {}
): { triggerRef: RefObject<T | null>; menuRef: RefObject<M | null>; style: CSSProperties } {
  const { axis = "vertical", placement = "down", align = "right", gap = 4 } = opts;
  const triggerRef = useRef<T>(null);
  const menuRef = useRef<M>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: -9999, left: -9999, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const { top, left } = computeFloatingPosition(
      triggerRect,
      menuRect,
      { width: window.innerWidth, height: window.innerHeight },
      { axis, placement, align, gap },
    );

    setStyle({ position: "fixed", top, left, visibility: "visible" });
  }, [open, axis, placement, align, gap]);

  // Callers pass `onDismiss` as a fresh inline function every render.
  // Keeping it out of the effect below (via this ref) is load-bearing, not
  // just tidiness: the effect's own `setStyle` call re-renders the owning
  // component, which would recreate `onDismiss` and re-trigger the effect,
  // which would call `setStyle` again — an infinite loop that fired
  // continuously from the very first mount regardless of `open`.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!open) {
      setStyle({ position: "fixed", top: -9999, left: -9999, visibility: "hidden" });
      return;
    }
    function handleDismiss(e: Event) {
      // A scroll inside the menu's own content (e.g. a capped max-height
      // list) isn't a reason to dismiss — only dismiss when something
      // *outside* the menu scrolled, which could move the trigger out from
      // under it and make the current position stale.
      if (menuRef.current?.contains(e.target as Node)) return;
      onDismissRef.current();
    }
    window.addEventListener("scroll", handleDismiss, true);
    window.addEventListener("resize", handleDismiss);
    return () => {
      window.removeEventListener("scroll", handleDismiss, true);
      window.removeEventListener("resize", handleDismiss);
    };
  }, [open]);

  return { triggerRef, menuRef, style };
}
