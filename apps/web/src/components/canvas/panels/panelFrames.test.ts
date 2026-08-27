import { SEED_COLUMN_IDS } from "./boardColumns";
import { describe, expect, it } from "@effect/vitest";

import {
  FRAME_HEADER_HEIGHT,
  FRAME_MIN_SIZE,
  FRAME_PADDING,
  FRAME_PRESET_IDS,
  FRAME_PRESETS,
  FRAME_SIZE_IDS,
  FRAME_SIZES,
  FRAME_GRAB_RATIO,
  anchoredByLockedFrames,
  frameAround,
  frameChildMoves,
  frameContentBox,
  frameContentsSummary,
  frameGrabsBox,
  frameMembers,
  framePreset,
  frameSize,
  frameSizeLabel,
  framesToSendBack,
  frameToFit,
  isInsideFrame,
  isPhoneFrame,
  legacyFrameStations,
  matchFrameSize,
  REMOVED_GALLERY_FRAME_TITLE,
  staleEmptyGalleryFrameIds,
} from "./panelFrames";
import { KANBAN_REGION_SIZE, type Box } from "./panelStations";

describe("frameContentBox", () => {
  it("takes the title bar off the top", () => {
    expect(frameContentBox({ x: 10, y: 20, w: 400, h: 300 })).toEqual({
      x: 10,
      y: 20 + FRAME_HEADER_HEIGHT,
      w: 400,
      h: 300 - FRAME_HEADER_HEIGHT,
    });
  });

  it("never reports a negative content height", () => {
    expect(frameContentBox({ x: 0, y: 0, w: 100, h: 10 }).h).toBe(0);
  });
});

describe("frameAround", () => {
  it("pads the panels it is drawn around and puts the bar above them", () => {
    expect(frameAround({ x: 100, y: 200, w: 1000, h: 800 })).toEqual({
      x: 100 - FRAME_PADDING,
      y: 200 - FRAME_PADDING - FRAME_HEADER_HEIGHT,
      w: 1000 + FRAME_PADDING * 2,
      h: 800 + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT,
    });
  });

  it("leaves the content exactly where it was — a frame never re-lays one out", () => {
    const content: Box = { x: 0, y: 0, w: 900, h: 600 };
    expect(isInsideFrame(frameContentBox(frameAround(content)), content)).toBe(true);
  });

  it("never comes out smaller than a frame's own chrome needs", () => {
    const box = frameAround({ x: 0, y: 0, w: 10, h: 10 });
    expect(box.w).toBe(FRAME_MIN_SIZE.w);
    expect(box.h).toBe(FRAME_MIN_SIZE.h);
  });
});

describe("frame presets", () => {
  it("gives every preset a label and a size, and nothing else to configure", () => {
    for (const id of FRAME_PRESET_IDS) {
      const preset = framePreset(id);
      expect(preset.id).toBe(id);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.size.w).toBeGreaterThanOrEqual(FRAME_MIN_SIZE.w);
      expect(Object.keys(preset).toSorted()).toEqual(["id", "label", "size"]);
    }
    expect(Object.keys(FRAME_PRESETS).length).toBe(FRAME_PRESET_IDS.length);
  });

  it("sizes the Board preset to the kanban region plus its padding", () => {
    expect(framePreset("board").size).toEqual({
      w: KANBAN_REGION_SIZE.w + FRAME_PADDING * 2,
      h: KANBAN_REGION_SIZE.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT,
    });
  });
});

describe("frame screen sizes", () => {
  it("offers the screens the board is designed against", () => {
    expect(frameSize("1920x1080").size).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("2560x1440").size).toEqual({ w: 2560, h: 1440 });
    expect(frameSize("1280x720").size).toEqual({ w: 1280, h: 720 });
    expect(frameSize("390x844").size).toEqual({ w: 390, h: 844 });
    expect(frameSize("430x932").size).toEqual({ w: 430, h: 932 });
    for (const id of FRAME_SIZE_IDS) {
      expect(frameSize(id).id).toBe(id);
      expect(frameSize(id).label.length).toBeGreaterThan(0);
    }
    expect(Object.keys(FRAME_SIZES).length).toBe(FRAME_SIZE_IDS.length);
  });

  it("sizes the desktop and mobile presets to their screens plus the title bar", () => {
    expect(framePreset("desktop").size).toEqual({ w: 1920, h: 1080 + FRAME_HEADER_HEIGHT });
    expect(framePreset("mobile").size).toEqual({ w: 390, h: 844 + FRAME_HEADER_HEIGHT });
  });

  it("matches a content size back to its preset, and says Custom otherwise", () => {
    expect(matchFrameSize({ w: 1920, h: 1080 })).toBe("1920x1080");
    expect(matchFrameSize({ w: 390.4, h: 843.9 })).toBe("390x844");
    expect(matchFrameSize({ w: 1700, h: 1000 })).toBeNull();
  });

  it("labels a size in canvas units", () => {
    expect(frameSizeLabel({ w: 1920.4, h: 1080 })).toBe("1920 × 1080");
  });

  it("calls anything narrower than the app's phone fold a phone", () => {
    expect(isPhoneFrame(frameSize("390x844").size)).toBe(true);
    expect(isPhoneFrame(frameSize("430x932").size)).toBe(true);
    expect(isPhoneFrame(frameSize("1280x720").size)).toBe(false);
    expect(isPhoneFrame(frameSize("1920x1080").size)).toBe(false);
  });
});

describe("frameToFit", () => {
  const at = (id: string, x: number, y: number, w = 1920, h = 1080, presence = 0.5) => ({
    id,
    box: { x, y, w, h },
    presence,
  });

  it("fits nothing on a desktop-width window", () => {
    expect(frameToFit({ screenWidth: 1440, frames: [at("desktop", 0, 0)] })).toBeNull();
  });

  it("fits nothing when no frame is on screen", () => {
    expect(
      frameToFit({ screenWidth: 390, frames: [at("desktop", 0, 0, 1920, 1080, 0.01)] }),
    ).toBeNull();
    expect(frameToFit({ screenWidth: 390, frames: [] })).toBeNull();
  });

  it("prefers the phone frame on a phone-width window", () => {
    const phone = at("phone", 3000, 0, 390, 844);
    expect(frameToFit({ screenWidth: 390, frames: [at("desktop", 0, 0), phone] })).toBe("phone");
  });

  it("falls back to the largest, then topmost, then leftmost, then id", () => {
    expect(
      frameToFit({
        screenWidth: 390,
        frames: [at("laptop", 0, 0, 1280, 720), at("desktop", 0, 2000)],
      }),
    ).toBe("desktop");
    expect(frameToFit({ screenWidth: 390, frames: [at("b", 0, 900), at("a", 0, 0)] })).toBe("a");
    expect(frameToFit({ screenWidth: 390, frames: [at("b", 0, 0), at("a", 0, 0)] })).toBe("a");
  });
});

describe("legacyFrameStations", () => {
  it("hands back every page a slot held", () => {
    expect(
      legacyFrameStations({
        query: "none",
        slots: [
          {
            panels: [
              { kind: "explorer", entityId: "proj" },
              { kind: "prs", entityId: "a/b" },
            ],
          },
          { panels: [{ kind: "hermes", entityId: "" }] },
        ],
      }),
    ).toEqual([
      { kind: "explorer", entityId: "proj" },
      { kind: "prs", entityId: "a/b" },
      { kind: "hermes", entityId: "" },
    ]);
  });

  // The kanban query pinned the columns in without their appearing in a slot,
  // so reading the slots alone would drop the board on load.
  it("counts the columns a kanban query pinned in", () => {
    const refs = legacyFrameStations({
      query: "kanban",
      slots: [{ panels: [{ kind: "composer", entityId: "" }] }],
    });
    expect(refs.map((ref) => ref.kind)).toEqual([
      "composer",
      ...SEED_COLUMN_IDS.map(() => "column"),
    ]);
  });

  it("answers nothing for a frame that never held a page", () => {
    expect(legacyFrameStations({ query: "none", slots: [] })).toEqual([]);
  });
});

describe("staleEmptyGalleryFrameIds", () => {
  it("drops an empty frame titled Dev gallery", () => {
    expect(
      staleEmptyGalleryFrameIds([
        { id: "g", title: REMOVED_GALLERY_FRAME_TITLE, childCount: 0 },
        { id: "keep", title: "Frame", childCount: 0 },
        { id: "full", title: REMOVED_GALLERY_FRAME_TITLE, childCount: 2 },
      ]),
    ).toEqual(["g"]);
  });

  it("never drops a user-named empty frame", () => {
    expect(staleEmptyGalleryFrameIds([{ id: "mine", title: "Scratch", childCount: 0 }])).toEqual(
      [],
    );
  });
});

describe("frame spatial membership", () => {
  it("adopts only what stands fully inside", () => {
    const content: Box = { x: 0, y: 0, w: 1000, h: 800 };
    expect(isInsideFrame(content, { x: 10, y: 10, w: 100, h: 100 })).toBe(true);
    expect(isInsideFrame(content, { x: -10, y: 10, w: 100, h: 100 })).toBe(false);
    expect(isInsideFrame(content, { x: 950, y: 10, w: 100, h: 100 })).toBe(false);
  });

  it("moves children by exactly the frame's delta", () => {
    const moved = frameChildMoves([{ x: 10, y: 20 }], { x: 5, y: -7 });
    expect(moved).toEqual([{ x: 15, y: 13 }]);
  });
});

describe("frameGrabsBox", () => {
  const content: Box = { x: 0, y: 0, w: 1000, h: 800 };

  it("carries what stands wholly inside", () => {
    expect(frameGrabsBox(content, { x: 10, y: 10, w: 100, h: 100 })).toBe(true);
  });

  // The complaint this exists for: a page nudged a few units past the border
  // used to be left standing on the canvas when the frame moved.
  it("carries a page that overhangs the border", () => {
    expect(frameGrabsBox(content, { x: -8, y: -8, w: 400, h: 300 })).toBe(true);
    expect(frameGrabsBox(content, { x: 940, y: 10, w: 100, h: 100 })).toBe(true);
  });

  it("leaves behind a shape that is mostly outside", () => {
    expect(frameGrabsBox(content, { x: 960, y: 10, w: 100, h: 100 })).toBe(false);
    expect(frameGrabsBox(content, { x: 2000, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it("draws the line at half the shape's own area", () => {
    expect(FRAME_GRAB_RATIO).toBe(0.5);
    expect(frameGrabsBox(content, { x: -50, y: 0, w: 100, h: 100 })).toBe(true);
    expect(frameGrabsBox(content, { x: -51, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it("carries an area-less shape by its middle", () => {
    expect(frameGrabsBox(content, { x: 100, y: 400, w: 300, h: 0 })).toBe(true);
    expect(frameGrabsBox(content, { x: 1200, y: 400, w: 300, h: 0 })).toBe(false);
  });
});

describe("frameMembers", () => {
  const content: Box = { x: 0, y: 0, w: 1000, h: 800 };
  const inside = { x: 10, y: 10, w: 100, h: 100 };
  const outside = { x: 5000, y: 5000, w: 100, h: 100 };

  it("carries what stands in it, in the order it was given", () => {
    expect(
      frameMembers({
        frameId: "f",
        content,
        candidates: [
          { id: "a", box: inside, pinnedTo: null },
          { id: "b", box: outside, pinnedTo: null },
          { id: "c", box: inside, pinnedTo: null },
        ],
      }),
    ).toEqual(["a", "c"]);
  });

  it("carries what is locked in wherever it stands", () => {
    expect(
      frameMembers({
        frameId: "f",
        content,
        candidates: [{ id: "a", box: outside, pinnedTo: "f" }],
      }),
    ).toEqual(["a"]);
  });

  // Two frames drawn over one another must not both drag the same page around.
  it("leaves what another frame has locked in", () => {
    expect(
      frameMembers({
        frameId: "f",
        content,
        candidates: [{ id: "a", box: inside, pinnedTo: "other" }],
      }),
    ).toEqual([]);
  });
});

describe("anchoredByLockedFrames", () => {
  const board = { id: "board", holding: ["prompts", "active", "capture"] };

  // The bug: selecting the locked Board frame and the columns standing in it,
  // then dragging, walked the columns out from under their own border.
  it("holds a locked frame's pages still while the frame cannot move", () => {
    expect([
      ...anchoredByLockedFrames({
        moving: ["board", "prompts", "active", "capture"],
        lockedFrames: [board],
      }),
    ]).toEqual(["prompts", "active", "capture"]);
  });

  it("lets a page be dragged out of a locked frame on its own", () => {
    expect(anchoredByLockedFrames({ moving: ["prompts"], lockedFrames: [board] }).size).toBe(0);
  });

  it("leaves everything the locked frame is not holding free to move", () => {
    expect([
      ...anchoredByLockedFrames({
        moving: ["board", "prompts", "elsewhere"],
        lockedFrames: [board],
      }),
    ]).toEqual(["prompts"]);
  });

  it("anchors nothing when no locked frame is moving", () => {
    expect(anchoredByLockedFrames({ moving: ["prompts"], lockedFrames: [] }).size).toBe(0);
  });
});

describe("frameContentsSummary", () => {
  it("says what the lock is doing, and never says 1 shapes", () => {
    expect(frameContentsSummary(0, false)).toBe("Nothing standing in this frame yet");
    expect(frameContentsSummary(1, false)).toContain("1 shape standing");
    expect(frameContentsSummary(3, false)).toContain("3 shapes standing");
    expect(frameContentsSummary(1, true)).toContain("1 shape locked in");
    expect(frameContentsSummary(3, true)).toContain("3 shapes locked in");
  });
});

describe("framesToSendBack", () => {
  const shapes = (order: string) =>
    [...order].map((char, index) => ({ id: `${char}${index}`, isFrame: char === "F" }));

  it("names every frame when one is painted over a shape", () => {
    // The Board frame above one column and below the other three: the column
    // under it is the one that stops taking clicks and drags.
    expect(framesToSendBack(shapes("pFppp"))).toEqual(["F1"]);
  });

  it("names every frame, so the order between them is kept", () => {
    expect(framesToSendBack(shapes("FpFp"))).toEqual(["F0", "F2"]);
  });

  it("leaves a canvas whose frames are already at the back alone", () => {
    expect(framesToSendBack(shapes("FFppp"))).toEqual([]);
  });

  it("has nothing to do on a canvas of only frames, or none", () => {
    expect(framesToSendBack(shapes("FFF"))).toEqual([]);
    expect(framesToSendBack(shapes("ppp"))).toEqual([]);
    expect(framesToSendBack([])).toEqual([]);
  });
});

/**
 * The frame is the ONE screen primitive, and it is a border. This trips the
 * build if anyone reintroduces a second one — `t3-viewport` is a retired shape
 * only the snapshot reader and the load-time conversion may touch — or brings
 * back the docking layer that made a frame stretch the panels inside it.
 */
describe("frames stay one primitive, and stay borders", () => {
  const sources = import.meta.glob(["../**/*.tsx", "../**/*.ts", "!../**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  // Every frame-creating pass used to end with its own "put it behind the
  // panels" line, and the two in BoardCanvas sent *every* shape on the page to
  // the back — which reorders nothing, so the frame stayed on top of whatever
  // was under it. `registerFrameBackdrop` is the one place that rule lives now.
  it("leaves the frames-go-behind rule to one place", () => {
    const allowed = new Set(["FrameShapeUtil.tsx"]);
    for (const [path, source] of Object.entries(sources)) {
      const name = path.split("/").at(-1) ?? path;
      if (allowed.has(name)) continue;
      expect(source, `${name} must leave z-order to registerFrameBackdrop`).not.toContain(
        "sendToBack",
      );
    }
  });

  it("keeps t3-viewport confined to the reader and the conversion", () => {
    const allowed = new Set(["ViewportShapeUtil.tsx", "BoardCanvas.tsx"]);
    for (const [path, source] of Object.entries(sources)) {
      const name = path.split("/").at(-1) ?? path;
      if (allowed.has(name)) continue;
      expect(source, `${name} must not touch the retired t3-viewport shape`).not.toContain(
        "t3-viewport",
      );
      expect(source, `${name} must not import the snapshot reader`).not.toContain(
        "ViewportShapeUtil",
      );
    }
  });

  it("keeps the desktop and mobile screens as frame presets", () => {
    expect(FRAME_PRESET_IDS).toContain("desktop");
    expect(FRAME_PRESET_IDS).toContain("mobile");
  });

  // A frame draws no page, so no slot list, no tab strip and no bound grid may
  // come back: those are what stretched the kanban columns to fill a frame.
  // `FrameShapeUtil` is spared for the props it still drains off old canvases.
  it("keeps docking and tiling out of the frame layer", () => {
    const banned = ["FrameSlot", "dockIntoFrame", "frameSlotBoxes", "gridCellBoxes", "FrameQuery"];
    const allowed = new Set(["FrameShapeUtil.tsx"]);
    for (const [path, source] of Object.entries(sources)) {
      const name = path.split("/").at(-1) ?? path;
      if (allowed.has(name)) continue;
      for (const symbol of banned) {
        expect(source, `${name} must not bring back frame docking (${symbol})`).not.toContain(
          symbol,
        );
      }
    }
  });
});
