import { describe, expect, it } from "vite-plus/test";

import { arrange, isLayoutMode, tileColumns, LAYOUT_GUTTER } from "./arrange";

const box = (w: number, h: number) => ({ w, h });

describe("arrange", () => {
  it("places nothing in a free frame — the panels are where you put them", () => {
    expect(arrange("free", [box(100, 100), box(100, 100)])).toEqual([]);
  });

  it("places nothing when the frame is empty", () => {
    expect(arrange("row", [])).toEqual([]);
  });

  it("puts a row side by side, in order, at their own sizes", () => {
    expect(arrange("row", [box(100, 50), box(200, 80)], 10)).toEqual([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 110, y: 0, w: 200, h: 80 },
    ]);
  });

  it("stacks a column", () => {
    expect(arrange("column", [box(100, 50), box(100, 80)], 10)).toEqual([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 60, w: 100, h: 80 },
    ]);
  });

  describe("tile", () => {
    // Nobody writes grid(10, 10); a hundred panels are ten across because that
    // is what a hundred wants.
    it("is as square as the count allows", () => {
      expect(tileColumns(0)).toBe(0);
      expect(tileColumns(1)).toBe(1);
      expect(tileColumns(4)).toBe(2);
      expect(tileColumns(5)).toBe(3);
      expect(tileColumns(100)).toBe(10);
    });

    it("lays four equal panels out two by two", () => {
      expect(arrange("tile", [box(10, 10), box(10, 10), box(10, 10), box(10, 10)], 5)).toEqual([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 15, y: 0, w: 10, h: 10 },
        { x: 0, y: 15, w: 10, h: 10 },
        { x: 15, y: 15, w: 10, h: 10 },
      ]);
    });

    // A grid of unequal panels has to line up rather than overlap, so a column
    // is as wide as its widest member and a row as tall as its tallest.
    it("sizes each row and column to its largest member", () => {
      const placed = arrange("tile", [box(10, 40), box(30, 10), box(10, 10), box(10, 10)], 0);
      expect(placed[1]?.x).toBe(10);
      expect(placed[2]?.y).toBe(40);
      expect(placed[3]?.x).toBe(10);
    });

    it("leaves a short last row where it lands", () => {
      const placed = arrange("tile", [box(10, 10), box(10, 10), box(10, 10)], 0);
      expect(placed).toHaveLength(3);
      expect(placed[2]).toEqual({ x: 0, y: 10, w: 10, h: 10 });
    });
  });

  it("defaults to the frame gutter", () => {
    const [, second] = arrange("row", [box(100, 10), box(100, 10)]);
    expect(second?.x).toBe(100 + LAYOUT_GUTTER);
  });
});

describe("isLayoutMode", () => {
  it("knows the four", () => {
    expect(isLayoutMode("free")).toBe(true);
    expect(isLayoutMode("tile")).toBe(true);
    expect(isLayoutMode("kanban")).toBe(false);
  });
});
