import { describe, expect, it } from "@effect/vitest";

import { panelDragTarget, passedDragThreshold, type PanelDragOrigin } from "./panelDrag";

const origin: PanelDragOrigin = {
  pointer: { x: 100, y: 100 },
  shape: { x: 400, y: -2000 },
  zoom: 0.5,
};

describe("panelDragTarget", () => {
  it("converts screen movement to page units at the camera's zoom", () => {
    expect(panelDragTarget(origin, { x: 150, y: 80 })).toEqual({ x: 500, y: -2040 });
  });

  it("moves the shape one page unit per screen pixel at 1:1", () => {
    expect(panelDragTarget({ ...origin, zoom: 1 }, { x: 110, y: 110 })).toEqual({
      x: 410,
      y: -1990,
    });
  });

  it("treats a zero or negative zoom as 1:1 instead of dividing by it", () => {
    expect(panelDragTarget({ ...origin, zoom: 0 }, { x: 110, y: 100 })).toEqual({
      x: 410,
      y: -2000,
    });
  });
});

describe("passedDragThreshold", () => {
  it("is a click until the pointer leaves the threshold", () => {
    expect(passedDragThreshold(origin, { x: 101, y: 101 })).toBe(false);
    expect(passedDragThreshold(origin, { x: 104, y: 100 })).toBe(true);
  });
});
