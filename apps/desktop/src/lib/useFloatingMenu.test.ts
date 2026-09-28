import { describe, expect, it } from "vitest";
import { computeFloatingPosition, FloatingRect } from "./useFloatingMenu";

function rect(partial: Partial<FloatingRect>): FloatingRect {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...partial };
}

const viewport = { width: 1000, height: 800 };

describe("computeFloatingPosition", () => {
  it("opens downward, right-aligned, by default when there's room", () => {
    const trigger = rect({ top: 100, bottom: 130, left: 200, right: 260 });
    const menu = rect({ width: 150, height: 200 });
    const pos = computeFloatingPosition(trigger, menu, viewport, {
      axis: "vertical",
      placement: "down",
      align: "right",
      gap: 4,
    });
    expect(pos.top).toBe(130 + 4);
    expect(pos.left).toBe(260 - 150);
  });

  it("auto-flips upward when there's more room above than below", () => {
    // Trigger near the bottom of a short viewport, tall menu.
    const trigger = rect({ top: 750, bottom: 780, left: 100, right: 160 });
    const menu = rect({ width: 150, height: 300 });
    const pos = computeFloatingPosition(trigger, menu, viewport, {
      axis: "vertical",
      placement: "auto",
      align: "right",
      gap: 4,
    });
    expect(pos.top).toBe(750 - 4 - 300);
  });

  it("clamps to the viewport edge instead of rendering off-screen", () => {
    // Trigger right at the left edge, menu wider than the space to its left.
    const trigger = rect({ top: 100, bottom: 130, left: 2, right: 50 });
    const menu = rect({ width: 300, height: 100 });
    const pos = computeFloatingPosition(trigger, menu, viewport, {
      axis: "vertical",
      placement: "down",
      align: "left",
      gap: 4,
    });
    expect(pos.left).toBeGreaterThanOrEqual(8); // EDGE_PADDING
  });

  it("supports the horizontal axis (left/right flip)", () => {
    const trigger = rect({ top: 100, bottom: 130, left: 900, right: 950 });
    const menu = rect({ width: 150, height: 80 });
    const pos = computeFloatingPosition(trigger, menu, viewport, {
      axis: "horizontal",
      placement: "auto",
      align: "top",
      gap: 4,
    });
    // Not enough room to the right (1000 - 950 = 50 < 150), plenty to the
    // left (900) — should flip left of the trigger.
    expect(pos.left).toBe(900 - 4 - 150);
  });
});
