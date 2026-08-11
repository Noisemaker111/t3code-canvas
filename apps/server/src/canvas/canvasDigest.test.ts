import { describe, expect, it } from "@effect/vitest";

import { digestSnapshot } from "./canvasDigest.ts";

/**
 * Snapshots are written by tldraw, so these fixtures mimic its record layout
 * rather than a schema of ours: a store map keyed by id, children positioned
 * relative to their frame.
 */
function snapshot(records: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({
    document: {
      store: Object.fromEntries(records.map((record) => [record.id, record])),
    },
  });
}

const frame = (id: string, name: string, x: number, y: number) => ({
  id,
  typeName: "shape",
  type: "frame",
  x,
  y,
  parentId: "page:page",
  props: { w: 1_200, h: 800, name },
});

const box = (id: string, text: string, parentId: string, x: number, y: number) => ({
  id,
  typeName: "shape",
  type: "geo",
  x,
  y,
  parentId,
  props: { text },
});

describe("digestSnapshot", () => {
  it("resolves a shape inside a frame to page coordinates", () => {
    const json = snapshot([
      frame("shape:frame-a", "auth", 1_000, 500),
      box("shape:box", "auth flow", "shape:frame-a", 60, 40),
    ]);

    const digest = digestSnapshot(json);
    const found = digest.shapes.find((shape) => shape.text === "auth flow");

    expect(found?.x).toBe(1_060);
    expect(found?.y).toBe(540);
  });

  it("reports every shape on the surface, framed or loose", () => {
    const json = snapshot([
      frame("shape:frame-a", "auth", 0, 0),
      box("shape:in-a", "mine", "shape:frame-a", 10, 10),
      box("shape:loose", "on open canvas", "page:page", 5_000, 5_000),
    ]);

    const digest = digestSnapshot(json);

    expect(digest.shapes.map((shape) => shape.text)).toEqual(["mine", "on open canvas"]);
    expect(digest.untitledCount).toBe(1);
  });

  it("leaves a shape on open canvas at its own coordinates", () => {
    const digest = digestSnapshot(snapshot([box("shape:loose", "sketch", "page:page", 12, 34)]));

    expect(digest.shapes[0]?.x).toBe(12);
  });

  it("survives a snapshot it cannot parse", () => {
    expect(digestSnapshot("{not json").shapes).toEqual([]);
    expect(digestSnapshot(null).shapeCount).toBe(0);
  });
});
