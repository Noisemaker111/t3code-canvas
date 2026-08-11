import { describe, expect, it } from "vite-plus/test";

import { useCanvasStationStore } from "./canvasStationStore";

describe("requestPanel", () => {
  it("focuses by default — a thread picked out of a list is an open", () => {
    useCanvasStationStore.getState().requestPanel({ kind: "thread", entityId: "abc" });
    expect(useCanvasStationStore.getState().requestedPanel).toEqual({
      ref: { kind: "thread", entityId: "abc" },
      at: null,
      focus: true,
      near: null,
    });
  });

  it("carries the request point and an unfocused add", () => {
    useCanvasStationStore
      .getState()
      .requestPanel({ kind: "terminal", entityId: "" }, { at: { x: 10, y: 20 }, focus: false });
    expect(useCanvasStationStore.getState().requestedPanel).toEqual({
      ref: { kind: "terminal", entityId: "" },
      at: { x: 10, y: 20 },
      focus: false,
      near: null,
    });
  });
});

/**
 * Adding a component drops it on the canvas; it never opens it. This trips the
 * build if an add path goes back to requesting the station, which fullscreened
 * whatever you just added over the page you were reading.
 */
describe("adds stay unfocused", () => {
  const sources = import.meta.glob(
    ["./components/CommandPalette.tsx", "./components/canvas/panels/CanvasContextMenu.tsx"],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  it("passes focus: false wherever a panel is added", () => {
    const calls = Object.values(sources).flatMap((source) =>
      source
        .split("requestPanel({")
        .slice(1)
        .map((rest) => rest.slice(0, 120)),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("focus: false");
  });
});
