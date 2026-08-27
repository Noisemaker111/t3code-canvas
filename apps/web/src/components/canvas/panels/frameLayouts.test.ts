import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_LAYOUT_CONTEXT,
  FRAME_LAYOUT_IDS,
  frameLayout,
  isFrameLayoutId,
  layoutContentBox,
  type FrameLayoutContext,
} from "./frameLayouts";
import {
  appendToColumnRow,
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  frameForLayout,
  placeBesideInFrame,
  presetLayoutId,
} from "./panelFrames";
import { panelManifest } from "./panelRegistry";
import { SEED_COLUMN_IDS } from "./boardColumns";

function context(patch: Partial<FrameLayoutContext> = {}): FrameLayoutContext {
  return { ...EMPTY_LAYOUT_CONTEXT, ...patch };
}

describe("frame layouts", () => {
  it("every layout id is a frame preset that resolves back to it", () => {
    for (const id of FRAME_LAYOUT_IDS) {
      expect(isFrameLayoutId(id)).toBe(true);
      expect(presetLayoutId(id)).toBe(id);
    }
    expect(presetLayoutId("custom")).toBeNull();
    expect(presetLayoutId("desktop")).toBeNull();
  });

  it("no layout names a panel kind the registry does not have", () => {
    for (const id of FRAME_LAYOUT_IDS) {
      const placements = frameLayout(id).build(
        context({ columnIds: ["prompts", "active"], threadIds: ["thread-1"] }),
      );
      expect(placements.length).toBeGreaterThan(0);
      for (const placement of placements) {
        expect(() => panelManifest(placement.ref.kind)).not.toThrow();
        expect(placement.box.w).toBeGreaterThan(0);
        expect(placement.box.h).toBeGreaterThan(0);
      }
    }
  });

  it("a layout places every panel it names once", () => {
    for (const id of FRAME_LAYOUT_IDS) {
      const placements = frameLayout(id).build(
        context({ columnIds: ["a", "b", "c"], threadIds: ["t"] }),
      );
      const keys = placements.map((p) => `${p.ref.kind}:${p.ref.entityId}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("kanban layout", () => {
  it("is one column panel per configured column, in order, plus the composer", () => {
    const placements = frameLayout("kanban").build(
      context({ columnIds: ["ideas", "research", "implement", "review", "done"] }),
    );
    const columns = placements.filter((p) => p.ref.kind === "column");
    expect(columns.map((p) => p.ref.entityId)).toEqual([
      "ideas",
      "research",
      "implement",
      "review",
      "done",
    ]);
    // Left to right, no overlap.
    for (let i = 1; i < columns.length; i += 1) {
      const previous = columns[i - 1]!;
      expect(columns[i]!.box.x).toBeGreaterThanOrEqual(previous.box.x + previous.box.w);
    }
    expect(placements.filter((p) => p.ref.kind === "composer")).toHaveLength(1);
  });

  it("a board with more columns gets a wider frame, never thinner columns", () => {
    const four = layoutContentBox(
      frameLayout("kanban").build(context({ columnIds: ["a", "b", "c", "d"] })),
    );
    const six = layoutContentBox(
      frameLayout("kanban").build(context({ columnIds: ["a", "b", "c", "d", "e", "f"] })),
    );
    expect(six!.w).toBeGreaterThan(four!.w);
    expect(six!.h).toBe(four!.h);
  });

  it("a canvas with no columns yet lays out the seed row, never an empty frame", () => {
    const placements = frameLayout("kanban").build(context());
    expect(placements.filter((p) => p.ref.kind === "column").map((p) => p.ref.entityId)).toEqual([
      ...SEED_COLUMN_IDS,
    ]);
  });
});

describe("agents layout", () => {
  it("is the list and Hermes down the left with the conversation beside them", () => {
    const placements = frameLayout("agents").build(context({ threadIds: ["thread-9", "other"] }));
    const list = placements.find((p) => p.ref.kind === "threads")!;
    const hermes = placements.find((p) => p.ref.kind === "hermes")!;
    const chat = placements.find((p) => p.ref.kind === "thread")!;
    expect(chat.ref.entityId).toBe("thread-9");
    expect(list.box.x).toBe(hermes.box.x);
    expect(hermes.box.y).toBeGreaterThanOrEqual(list.box.y + list.box.h);
    expect(chat.box.x).toBeGreaterThanOrEqual(list.box.x + list.box.w);
  });

  it("with nothing running it is the list and Hermes — never an empty thread panel", () => {
    const placements = frameLayout("agents").build(context());
    expect(placements.some((p) => p.ref.kind === "thread")).toBe(false);
    expect(placements.map((p) => p.ref.kind)).toEqual(["threads", "hermes"]);
  });
});

describe("ide layout", () => {
  it("is files, editor, terminal and git, all bound to the same project", () => {
    const placements = frameLayout("ide").build(context({ projectId: "proj-7" }));
    const byKind = new Map(placements.map((p) => [p.ref.kind, p]));
    expect([...byKind.keys()].toSorted()).toEqual(["editor", "explorer", "git", "terminal"]);
    for (const kind of ["explorer", "editor", "git"] as const) {
      expect(byKind.get(kind)!.ref.entityId).toBe("proj-7");
    }
    const editor = byKind.get("editor")!;
    const terminal = byKind.get("terminal")!;
    expect(terminal.box.x).toBe(editor.box.x);
    expect(terminal.box.y).toBeGreaterThanOrEqual(editor.box.y + editor.box.h);
    expect(byKind.get("git")!.box.x).toBeGreaterThanOrEqual(editor.box.x + editor.box.w);
  });

  it("two IDE frames over two projects address different panels", () => {
    const a = frameLayout("ide").build(context({ projectId: "one" }));
    const b = frameLayout("ide").build(context({ projectId: "two" }));
    const ids = (placements: typeof a) =>
      placements.filter((p) => p.ref.kind === "explorer").map((p) => p.ref.entityId);
    expect(ids(a)).not.toEqual(ids(b));
  });
});

describe("frameForLayout", () => {
  it("draws the border around the composition and pads every panel inside it", () => {
    const placements = frameLayout("kanban").build(context({ columnIds: ["a", "b"] }));
    const content = layoutContentBox(placements)!;
    const built = frameForLayout({ placements, at: { x: 0, y: 0 } });

    expect(built.frame.w).toBe(content.w + FRAME_PADDING * 2);
    expect(built.frame.h).toBe(content.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT);
    expect(built.panels).toHaveLength(placements.length);

    // Every panel stands inside the border, under the title bar.
    const left = built.frame.x;
    const top = built.frame.y + FRAME_HEADER_HEIGHT;
    for (const panel of built.panels) {
      expect(panel.box.x).toBeGreaterThanOrEqual(left);
      expect(panel.box.y).toBeGreaterThanOrEqual(top);
      expect(panel.box.x + panel.box.w).toBeLessThanOrEqual(left + built.frame.w);
      expect(panel.box.y + panel.box.h).toBeLessThanOrEqual(built.frame.y + built.frame.h);
    }
  });

  it("centres the frame on the point the drop happened at", () => {
    const placements = frameLayout("agents").build(context());
    const built = frameForLayout({ placements, at: { x: 500, y: -200 } });
    expect(built.frame.x + built.frame.w / 2).toBe(500);
    expect(built.frame.y).toBe(-200 - FRAME_HEADER_HEIGHT / 2);
  });

  it("keeps the layout's own offsets — the frame never re-lays-out what is in it", () => {
    const placements = frameLayout("ide").build(context());
    const built = frameForLayout({ placements, at: { x: 40, y: 40 } });
    const first = placements[0]!;
    const second = placements[1]!;
    expect(built.panels[1]!.box.x - built.panels[0]!.box.x).toBe(second.box.x - first.box.x);
    expect(built.panels[1]!.box.w).toBe(second.box.w);
  });
});

describe("placeBesideInFrame", () => {
  const content = { x: 0, y: 0, w: 1000, h: 600 };
  const size = { w: 500, h: 500 };
  const minSize = { w: 300, h: 200 };

  it("puts it to the right of the panel that asked, inside the border", () => {
    const box = placeBesideInFrame({
      content,
      source: { x: 0, y: 0, w: 300, h: 600 },
      size,
      minSize,
    })!;
    expect(box.x).toBeGreaterThanOrEqual(300);
    expect(box.x + box.w).toBeLessThanOrEqual(content.w);
  });

  it("falls under the panel when the right of the frame is too narrow", () => {
    const box = placeBesideInFrame({
      content,
      source: { x: 0, y: 0, w: 900, h: 300 },
      size,
      minSize,
    })!;
    expect(box.y).toBeGreaterThanOrEqual(300);
    expect(box.x).toBe(0);
  });

  it("answers null when the frame has no room, so the caller uses the panel's own address", () => {
    expect(
      placeBesideInFrame({
        content,
        source: { x: 0, y: 0, w: 1000, h: 600 },
        size,
        minSize,
      }),
    ).toBeNull();
  });
});

describe("appendToColumnRow", () => {
  const last = { x: 100, y: 60, w: 350, h: 840 };
  const frame = { x: 0, y: 0, w: 500, h: 940 };

  it("puts the new column on the end of the row, at its neighbours' height", () => {
    const { panel } = appendToColumnRow({ last, frame, width: 350 });
    expect(panel.x).toBeGreaterThanOrEqual(last.x + last.w);
    expect(panel.y).toBe(last.y);
    expect(panel.h).toBe(last.h);
    expect(panel.w).toBe(350);
  });

  it("grows the frame to hold it, padding included", () => {
    const grown = appendToColumnRow({ last, frame, width: 350 });
    expect(grown.frame.x).toBe(frame.x);
    expect(grown.frame.h).toBe(frame.h);
    expect(grown.frame.x + grown.frame.w).toBeGreaterThanOrEqual(
      grown.panel.x + grown.panel.w + FRAME_PADDING,
    );
  });

  it("never shrinks a frame that already had the room", () => {
    const wide = { x: 0, y: 0, w: 4000, h: 940 };
    expect(appendToColumnRow({ last, frame: wide, width: 350 }).frame.w).toBe(wide.w);
  });
});

describe("a layout this build does not have", () => {
  // FRAME_LAYOUT_IDS was the fourth closed union. A frame naming a composition
  // this build lacks keeps its name and arranges nothing, which is a `free`
  // frame — its panels are where they were put.
  it("arranges nothing rather than crashing", () => {
    const unknown = frameLayout("moodboard");
    expect(unknown.build(EMPTY_LAYOUT_CONTEXT)).toEqual([]);
    expect(isFrameLayoutId("moodboard")).toBe(false);
  });
});
