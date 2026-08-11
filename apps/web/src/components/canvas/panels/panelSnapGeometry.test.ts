import { describe, expect, it } from "@effect/vitest";

import { frameSnapPoints, panelSnapPoints } from "./panelSnapGeometry";

const has = (points: ReadonlyArray<{ x: number; y: number }>, x: number, y: number) =>
  points.some((point) => point.x === x && point.y === y);

describe("panelSnapPoints", () => {
  it("offers the content box under the title bar, not only the outer box", () => {
    const points = panelSnapPoints({ w: 400, h: 300, titleBarHeight: 32 });
    expect(has(points, 0, 0)).toBe(true);
    expect(has(points, 400, 300)).toBe(true);
    // Where the page inside the panel starts, and its centre.
    expect(has(points, 0, 32)).toBe(true);
    expect(has(points, 200, 166)).toBe(true);
  });

  it("offers each point once", () => {
    const points = panelSnapPoints({ w: 400, h: 300, titleBarHeight: 32 });
    const keys = points.map((point) => `${point.x}:${point.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is the outer box alone when the panel is rolled up to its bar", () => {
    expect(panelSnapPoints({ w: 400, h: 32, titleBarHeight: 32 })).toHaveLength(9);
  });
});

describe("frameSnapPoints", () => {
  it("offers the box the panels standing in it occupy", () => {
    const points = frameSnapPoints({ w: 500, h: 400, headerHeight: 32, padding: 32 });
    expect(has(points, 0, 0)).toBe(true);
    // Inside the margin, under the bar: the top-left a panel stands at.
    expect(has(points, 32, 64)).toBe(true);
    expect(has(points, 468, 368)).toBe(true);
  });

  it("is the outer box alone when the margins leave no room", () => {
    const points = frameSnapPoints({ w: 40, h: 40, headerHeight: 32, padding: 32 });
    expect(points).toHaveLength(9);
  });
});
