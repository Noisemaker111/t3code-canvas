import { describe, expect, it } from "vite-plus/test";

import {
  closableStations,
  closeLabel,
  countedLabel,
  frameForSelection,
  openableStation,
  promptCardTitle,
  selectionPromptText,
} from "./canvasContextActions";
import type { StationRef } from "./panelStations";

const station = (ref: StationRef, label: string) => ({ ref, label });

describe("selectionPromptText", () => {
  it("joins the selected shapes' text, blanks dropped", () => {
    expect(
      selectionPromptText([
        { id: "a", text: "  ship the menu  " },
        { id: "b", text: "   " },
        { id: "c", text: "with tests" },
      ]),
    ).toBe("ship the menu\n\nwith tests");
  });

  it("ignores stations — a page on the canvas is not a prompt", () => {
    expect(
      selectionPromptText([
        {
          id: "a",
          station: station({ kind: "thread", entityId: "t1" }, "Thread t1"),
          text: "Thread t1",
        },
        { id: "b", text: "the note" },
      ]),
    ).toBe("the note");
  });

  it("is empty when nothing selected carries text", () => {
    expect(selectionPromptText([{ id: "a" }, { id: "b", text: "\n\n" }])).toBe("");
  });
});

describe("promptCardTitle", () => {
  it("takes the first real line", () => {
    expect(promptCardTitle("\n\n  fix the composer\nand the board\n")).toBe("fix the composer");
  });

  it("clips a long line with an ellipsis", () => {
    const title = promptCardTitle("x".repeat(400));
    expect(title).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("is empty for an empty body", () => {
    expect(promptCardTitle("   \n ")).toBe("");
  });
});

describe("closableStations", () => {
  it("keeps the stations a human may close", () => {
    const closable = closableStations([
      { id: "a", station: station({ kind: "composer", entityId: "" }, "Capture") },
      { id: "b", station: station({ kind: "terminal", entityId: "term-1" }, "term-1") },
      { id: "c", station: station({ kind: "frame", entityId: "shape:f1" }, "IDE") },
      { id: "d", text: "a note" },
      // A column is a component: closing one removes the column.
      { id: "e", station: station({ kind: "column", entityId: "active" }, "Active") },
    ]);
    expect(closable.map((shape) => shape.id)).toEqual(["b", "c", "e"]);
  });

  it("is empty when the selection is all persistent panels", () => {
    expect(
      closableStations([
        { id: "a", station: station({ kind: "composer", entityId: "" }, "Capture") },
      ]),
    ).toHaveLength(0);
  });
});

describe("openableStation", () => {
  it("answers with the one selected station", () => {
    expect(
      openableStation([
        { id: "a", text: "note" },
        { id: "b", station: station({ kind: "settings", entityId: "hermes" }, "Settings") },
      ]),
    ).toEqual({ ref: { kind: "settings", entityId: "hermes" }, label: "Settings" });
  });

  it("answers null when two stations are selected", () => {
    expect(
      openableStation([
        { id: "a", station: station({ kind: "settings", entityId: "" }, "Settings") },
        { id: "b", station: station({ kind: "hermes", entityId: "" }, "Hermes") },
      ]),
    ).toBeNull();
  });
});

describe("closeLabel", () => {
  it("names the one station, counts a pile of them", () => {
    const one = { id: "a", station: station({ kind: "terminal", entityId: "term-1" }, "term-1") };
    const two = { id: "b", station: station({ kind: "hermes", entityId: "" }, "Hermes") };
    expect(closeLabel([one])).toBe("Close term-1");
    expect(closeLabel([one, two])).toBe("Close 2 stations");
  });
});

describe("countedLabel", () => {
  it("pluralizes the noun and shows the count", () => {
    expect(countedLabel("Remove", "background", 1)).toBe("Remove background");
    expect(countedLabel("Remove", "background", 3)).toBe("Remove 3 backgrounds");
  });
});

describe("frameForSelection", () => {
  const frame = { id: "frame:a", label: "Checkout flow" };

  it("names the frame a whole selection is standing in", () => {
    expect(
      frameForSelection([
        { id: "one", frame, lockedIn: false },
        { id: "two", frame, lockedIn: false },
      ]),
    ).toEqual({
      frameId: "frame:a",
      label: "Checkout flow",
      shapeIds: ["one", "two"],
      locked: false,
    });
  });

  it("says Release only once every one of them is locked in", () => {
    expect(
      frameForSelection([
        { id: "one", frame, lockedIn: true },
        { id: "two", frame, lockedIn: true },
      ])?.locked,
    ).toBe(true);
    expect(
      frameForSelection([
        { id: "one", frame, lockedIn: true },
        { id: "two", frame, lockedIn: false },
      ])?.locked,
    ).toBe(false);
  });

  // Half a selection quietly locked in is worse than no item at all.
  it("offers nothing for a selection spread over two frames, or over none", () => {
    expect(
      frameForSelection([
        { id: "one", frame, lockedIn: false },
        { id: "two", frame: { id: "frame:b", label: "Mobile" }, lockedIn: false },
      ]),
    ).toBeNull();
    expect(frameForSelection([{ id: "one", frame: null, lockedIn: false }])).toBeNull();
    expect(frameForSelection([])).toBeNull();
  });
});
