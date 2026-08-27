import { describe, expect, it } from "@effect/vitest";

import { addFrameEntries, addPanelEntries, addPanelPlacement } from "./addMenu";
import { FRAME_LAYOUT_IDS } from "./frameLayouts";

describe("addFrameEntries", () => {
  it("offers every laid-out frame this build ships", () => {
    const presets = addFrameEntries().map((entry) => entry.preset);
    for (const layout of FRAME_LAYOUT_IDS) expect(presets).toContain(layout);
  });

  it("gives the laid-out frames their layout's own summary", () => {
    const ide = addFrameEntries().find((entry) => entry.preset === "ide");
    expect(ide?.detail).toBe("Files, editor, terminal, git");
  });

  it("says an empty frame is empty, so composing one is a row you can find", () => {
    const custom = addFrameEntries().find((entry) => entry.preset === "custom");
    expect(custom?.detail).toMatch(/add components/i);
  });

  it("sizes the screen frames by their content area, not their box", () => {
    const mobile = addFrameEntries().find((entry) => entry.preset === "mobile");
    expect(mobile?.detail).toBe("390 × 844");
  });

  it("never offers the frames the canvas draws itself", () => {
    const presets = addFrameEntries().map((entry) => entry.preset);
    expect(presets).not.toContain("board");
    expect(presets).not.toContain("threads");
  });
});

describe("addPanelEntries", () => {
  it("offers the components the registry marks addable", () => {
    const kinds = addPanelEntries().map((entry) => entry.kind);
    expect(kinds).toContain("terminal");
    expect(kinds).toContain("column");
    expect(kinds).not.toContain("editor");
  });
});

describe("addPanelPlacement", () => {
  const content = { x: 100, y: 200, w: 400, h: 300 };

  it("drops a component into the frame you are standing in", () => {
    expect(
      addPanelPlacement({
        station: { kind: "frame", entityId: "shape:a" },
        frameContent: content,
      }),
    ).toEqual({ at: { x: 300, y: 350 }, focus: false });
  });

  it("makes it the page you are on when no frame is holding you", () => {
    expect(addPanelPlacement({ station: null, frameContent: null })).toEqual({
      at: null,
      focus: true,
    });
    expect(
      addPanelPlacement({ station: { kind: "column", entityId: "prompts" }, frameContent: null }),
    ).toEqual({ at: null, focus: true });
  });

  it("falls back to focusing when the frame's box cannot be read", () => {
    expect(
      addPanelPlacement({ station: { kind: "frame", entityId: "shape:gone" }, frameContent: null }),
    ).toEqual({ at: null, focus: true });
  });
});
