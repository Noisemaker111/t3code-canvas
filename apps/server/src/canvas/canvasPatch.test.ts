import { describe, expect, it } from "@effect/vitest";

import { applySnapshotPatch } from "./canvasPatch.ts";

const shape = (id: string, x: number) => ({
  id,
  typeName: "shape",
  type: "geo",
  x,
  y: 0,
  props: {},
});

const snapshot = (store: Record<string, unknown>, session: unknown = { currentPageId: "page:1" }) =>
  JSON.stringify({ document: { store, schema: { schemaVersion: 2 } }, session });

const parse = (raw: string | null) =>
  raw === null ? null : (JSON.parse(raw) as Record<string, any>);

describe("applySnapshotPatch", () => {
  it("merges a changed record without touching the rest", () => {
    const stored = snapshot({ "shape:a": shape("shape:a", 0), "shape:b": shape("shape:b", 10) });
    const next = parse(
      applySnapshotPatch(stored, {
        putJson: JSON.stringify({ "shape:a": shape("shape:a", 99) }),
        removeIds: [],
      }),
    );
    expect(next?.document.store["shape:a"].x).toBe(99);
    expect(next?.document.store["shape:b"].x).toBe(10);
    expect(next?.document.schema).toEqual({ schemaVersion: 2 });
  });

  it("adds a record the document did not have", () => {
    const stored = snapshot({ "shape:a": shape("shape:a", 0) });
    const next = parse(
      applySnapshotPatch(stored, {
        putJson: JSON.stringify({ "shape:new": shape("shape:new", 5) }),
        removeIds: [],
      }),
    );
    expect(Object.keys(next?.document.store ?? {})).toEqual(["shape:a", "shape:new"]);
  });

  it("drops removed ids", () => {
    const stored = snapshot({ "shape:a": shape("shape:a", 0), "shape:b": shape("shape:b", 10) });
    const next = parse(
      applySnapshotPatch(stored, { putJson: "{}", removeIds: ["shape:b", "shape:gone"] }),
    );
    expect(Object.keys(next?.document.store ?? {})).toEqual(["shape:a"]);
  });

  // Only the document scope reaches the browser's save listener, so a patch
  // must not disturb the session the camera lives in.
  it("carries the session half through untouched", () => {
    const stored = snapshot({ "shape:a": shape("shape:a", 0) });
    const next = parse(applySnapshotPatch(stored, { putJson: "{}", removeIds: ["shape:a"] }));
    expect(next?.session).toEqual({ currentPageId: "page:1" });
  });

  // Every refusal below reaches the browser as `saved: false`, which is its cue
  // to send the whole document. Guessing instead would write over real work.
  it("refuses when there is nothing stored to patch", () => {
    expect(applySnapshotPatch(null, { putJson: "{}", removeIds: [] })).toBeNull();
    expect(applySnapshotPatch("", { putJson: "{}", removeIds: [] })).toBeNull();
  });

  it("refuses unparseable stored JSON or patch JSON", () => {
    expect(applySnapshotPatch("{not json", { putJson: "{}", removeIds: [] })).toBeNull();
    expect(applySnapshotPatch(snapshot({}), { putJson: "{not json", removeIds: [] })).toBeNull();
  });

  it("refuses a layout without the record map where this build writes it", () => {
    expect(
      applySnapshotPatch(JSON.stringify({ store: { "shape:a": shape("shape:a", 0) } }), {
        putJson: "{}",
        removeIds: [],
      }),
    ).toBeNull();
  });

  it("refuses a put that is not a map of records", () => {
    const stored = snapshot({ "shape:a": shape("shape:a", 0) });
    expect(
      applySnapshotPatch(stored, { putJson: JSON.stringify([1, 2]), removeIds: [] }),
    ).toBeNull();
    expect(
      applySnapshotPatch(stored, { putJson: JSON.stringify({ "shape:a": 7 }), removeIds: [] }),
    ).toBeNull();
    expect(
      applySnapshotPatch(stored, {
        putJson: JSON.stringify({ "shape:a": { id: "shape:a" } }),
        removeIds: [],
      }),
    ).toBeNull();
  });
});
