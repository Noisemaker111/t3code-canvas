import type { CanvasInjection, CanvasInjectionSpec } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  FRAME_PADDING,
  gridColumns,
  layoutInjection,
  NODE_GAP_X,
  NODE_HEIGHT,
  NODE_WIDTH,
  nextOrigin,
  pendingInOrder,
} from "./canvasLayout";

const ORIGIN = { x: 0, y: 0, w: 0, h: 0 };

function spec(partial: Partial<CanvasInjectionSpec> = {}): CanvasInjectionSpec {
  return { title: "Diagram", nodes: [], edges: [], ...partial } as CanvasInjectionSpec;
}

function node(key: string, extra: Record<string, unknown> = {}) {
  return { key, text: key, ...extra } as CanvasInjectionSpec["nodes"][number];
}

describe("gridColumns", () => {
  it("keeps small diagrams on one row", () => {
    expect(gridColumns(1)).toBe(1);
    expect(gridColumns(4)).toBe(2);
  });

  it("caps at four columns so a big diagram stays readable", () => {
    expect(gridColumns(64)).toBe(4);
  });

  it("survives an empty diagram", () => {
    expect(gridColumns(0)).toBe(1);
  });
});

describe("layoutInjection", () => {
  it("lays unpositioned nodes out in a grid", () => {
    const layout = layoutInjection(spec({ nodes: [node("a"), node("b")] }), ORIGIN);
    expect(layout.nodes[0]?.x).toBe(0);
    expect(layout.nodes[1]?.x).toBe(NODE_WIDTH + NODE_GAP_X);
    expect(layout.nodes[0]?.y).toBe(layout.nodes[1]?.y);
  });

  it("honors coordinates a node supplies and grids only the rest", () => {
    const layout = layoutInjection(
      spec({ nodes: [node("a", { x: 900, y: 900 }), node("b")] }),
      ORIGIN,
    );
    expect(layout.nodes[0]).toMatchObject({ x: 900, y: 900 });
    expect(layout.nodes[1]?.x).toBe(NODE_WIDTH + NODE_GAP_X);
  });

  it("wraps the frame around every node with padding", () => {
    const layout = layoutInjection(spec({ nodes: [node("a")] }), ORIGIN);
    expect(layout.frame).toEqual({
      x: -FRAME_PADDING,
      y: -FRAME_PADDING,
      w: NODE_WIDTH + FRAME_PADDING * 2,
      h: NODE_HEIGHT + FRAME_PADDING * 2,
    });
  });

  it("reserves room below the nodes only when there is a note", () => {
    const without = layoutInjection(spec({ nodes: [node("a")] }), ORIGIN);
    const withNote = layoutInjection(spec({ nodes: [node("a")], note: "why" }), ORIGIN);
    expect(without.note).toBeNull();
    expect(withNote.note).not.toBeNull();
    expect(withNote.frame.h).toBeGreaterThan(without.frame.h);
  });

  it("treats a blank note as no note", () => {
    expect(layoutInjection(spec({ nodes: [node("a")], note: "   " }), ORIGIN).note).toBeNull();
  });

  it("still produces a focusable frame for an empty diagram", () => {
    const layout = layoutInjection(spec(), ORIGIN);
    expect(layout.nodes).toEqual([]);
    expect(layout.focus.w).toBeGreaterThan(0);
  });
});

describe("nextOrigin", () => {
  it("starts at the origin when the page is empty", () => {
    expect(nextOrigin(null)).toEqual(ORIGIN);
  });

  it("stacks the next drawing clear of what is already there", () => {
    const next = nextOrigin({ x: 10, y: 20, w: 100, h: 200 });
    expect(next.x).toBe(10);
    expect(next.y).toBeGreaterThan(220);
  });
});

describe("pendingInOrder", () => {
  const injection = (id: string, createdAt: string, appliedAt: string | null): CanvasInjection =>
    ({ id, docId: "board", spec: spec(), createdAt, appliedAt }) as unknown as CanvasInjection;

  it("drops what a browser already drew", () => {
    const pending = pendingInOrder([
      injection("a", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
      injection("b", "2026-01-01T00:00:01.000Z", null),
    ]);
    expect(pending.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("replays a backlog oldest first", () => {
    const pending = pendingInOrder([
      injection("late", "2026-01-02T00:00:00.000Z", null),
      injection("early", "2026-01-01T00:00:00.000Z", null),
    ]);
    expect(pending.map((entry) => entry.id)).toEqual(["early", "late"]);
  });
});
