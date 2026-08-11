import { describe, expect, it } from "@effect/vitest";

import {
  BARE_RESERVE,
  boxesOverlap,
  clearOfPanels,
  nextFreeSlot,
  THREAD_LANE_SLOTS,
  threadLaneBox,
  CHROME_RESERVE,
  chromeReserve,
  LIVE_PRESENCE,
  MOBILE_RESERVE,
  desiredStations,
  isPanelLive,
  isPanelStation,
  PANEL_KINDS,
  isKanbanRegionKind,
  keptThreadPanels,
  missingStations,
  nextPanelSlot,
  panelIdentity,
  seedStations,
  panelPresence,
  panelPlacement,
  parseStationKey,
  sameStation,
  screenBox,
  staleStations,
  stationCamera,
  stationKey,
  unionBoxes,
} from "./panelStations";
import { frameAround } from "./panelFrames";
import { SEED_COLUMN_IDS } from "./boardColumns";

describe("stationKey", () => {
  it("round-trips a plain station", () => {
    expect(parseStationKey(stationKey({ kind: "board", entityId: "" }))).toEqual({
      kind: "board",
      entityId: "",
    });
  });

  it("round-trips an entity station", () => {
    expect(parseStationKey(stationKey({ kind: "thread", entityId: "t_1:2" }))).toEqual({
      kind: "thread",
      entityId: "t_1:2",
    });
  });

  it("rejects a kind this build does not have a panel for", () => {
    expect(parseStationKey("preview")).toBeNull();
    expect(parseStationKey("")).toBeNull();
    expect(parseStationKey(null)).toBeNull();
  });

  it("round-trips a frame station, shape-id colon and all", () => {
    expect(parseStationKey(stationKey({ kind: "frame", entityId: "shape:a1" }))).toEqual({
      kind: "frame",
      entityId: "shape:a1",
    });
  });

  it("rejects a frame station with no shape id", () => {
    expect(parseStationKey("frame")).toBeNull();
    expect(parseStationKey("frame:")).toBeNull();
  });
});

describe("sameStation", () => {
  it("treats free roam as equal only to free roam", () => {
    expect(sameStation(null, null)).toBe(true);
    expect(sameStation(null, { kind: "board", entityId: "" })).toBe(false);
  });

  it("separates two threads", () => {
    expect(sameStation({ kind: "thread", entityId: "a" }, { kind: "thread", entityId: "b" })).toBe(
      false,
    );
  });
});

describe("isPanelStation", () => {
  it("sends a sectioned settings station to the settings panel", () => {
    expect(
      isPanelStation({ kind: "settings", entityId: "hermes" }, { kind: "settings", entityId: "" }),
    ).toBe(true);
  });

  it("keeps threads apart", () => {
    expect(
      isPanelStation({ kind: "thread", entityId: "a" }, { kind: "thread", entityId: "b" }),
    ).toBe(false);
  });

  it("matches free roam against no panel at all", () => {
    expect(isPanelStation(null, null)).toBe(true);
    expect(isPanelStation(null, { kind: "board", entityId: "" })).toBe(false);
  });
});

describe("panelPlacement", () => {
  it("lines the board up on x with the others clear of it", () => {
    const board = panelPlacement({ kind: "board", entityId: "" });
    const hermes = panelPlacement({ kind: "hermes", entityId: "" });
    const settings = panelPlacement({ kind: "settings", entityId: "" });
    expect(board.x).toBe(0);
    expect(hermes.x).toBeGreaterThan(board.x + board.w);
    expect(settings.x + settings.w).toBeLessThan(board.x);
  });

  it("queues thread panels in a row below the board", () => {
    const board = panelPlacement({ kind: "board", entityId: "" });
    const first = panelPlacement({ kind: "thread", entityId: "a" }, 0);
    const second = panelPlacement({ kind: "thread", entityId: "b" }, 1);
    expect(first.y).toBeGreaterThan(board.y + board.h);
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x + first.w);
  });

  // Drawings land from (0, 0) downward; a panel reaching into that would sit on
  // top of whatever a thread drew.
  it("keeps every panel clear of the drawing space", () => {
    for (const kind of PANEL_KINDS) {
      for (const slot of [0, 1, 4]) {
        const box = panelPlacement({ kind, entityId: "a" }, slot);
        expect(box.y + box.h).toBeLessThanOrEqual(0);
      }
    }
  });

  // Migrated canvases keep Hermes and threads where they are; the columns and
  // the composer must land inside the footprint the board panel vacated.
  it("keeps the kanban region inside the old board footprint", () => {
    const board = panelPlacement({ kind: "board", entityId: "" });
    const composer = panelPlacement({ kind: "composer", entityId: "" });
    const columns = ["prompts", "active", "pr", "done"].map((id, slot) =>
      panelPlacement({ kind: "column", entityId: id }, slot),
    );
    const region = unionBoxes([...columns, composer]);
    expect(region).not.toBeNull();
    expect(region!.x).toBe(board.x);
    expect(region!.y).toBe(board.y);
    expect(region!.w).toBeLessThanOrEqual(board.w);
  });

  // By slot, not by name: which columns a board has is board settings, so the
  // caller says which one this is and a fifth column has a place to stand.
  it("lays the columns out left to right without overlap, composer beneath", () => {
    const prompts = panelPlacement({ kind: "column", entityId: "prompts" }, 0);
    const active = panelPlacement({ kind: "column", entityId: "active" }, 1);
    const composer = panelPlacement({ kind: "composer", entityId: "" });
    expect(active.x).toBeGreaterThan(prompts.x + prompts.w);
    expect(active.y).toBe(prompts.y);
    expect(composer.y).toBeGreaterThan(prompts.y + prompts.h);
  });

  // The workspace kinds are opened by the human, so they must not land on the
  // things they were opened to work on.
  it("keeps the workspace panels clear of the kanban region and the thread row", () => {
    const region = unionBoxes([
      ...["prompts", "active", "pr", "done"].map((id, slot) =>
        panelPlacement({ kind: "column", entityId: id }, slot),
      ),
      panelPlacement({ kind: "composer", entityId: "" }),
    ])!;
    const firstThread = panelPlacement({ kind: "thread", entityId: "a" }, 0);
    for (const kind of ["terminal", "explorer", "editor"] as const) {
      const box = panelPlacement({ kind, entityId: "" });
      expect(box.x + box.w).toBeLessThanOrEqual(Math.min(region.x, firstThread.x));
    }
  });

  it("queues workspace instances up without overlap", () => {
    const first = panelPlacement({ kind: "editor", entityId: "p:a.ts" }, 0);
    const second = panelPlacement({ kind: "editor", entityId: "p:b.ts" }, 1);
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.w);

    const firstTree = panelPlacement({ kind: "explorer", entityId: "p" }, 0);
    const secondTree = panelPlacement({ kind: "explorer", entityId: "q" }, 1);
    expect(secondTree.y).toBe(firstTree.y);
    expect(secondTree.x + secondTree.w).toBeLessThanOrEqual(firstTree.x);
  });

  it("keeps the editor row clear of the explorer row", () => {
    const editor = panelPlacement({ kind: "editor", entityId: "p:a.ts" }, 0);
    const explorer = panelPlacement({ kind: "explorer", entityId: "p" }, 0);
    expect(editor.y + editor.h).toBeLessThanOrEqual(explorer.y);
  });

  it("keeps the composer clear of the thread row", () => {
    const composer = panelPlacement({ kind: "composer", entityId: "" });
    const thread = panelPlacement({ kind: "thread", entityId: "a" }, 0);
    expect(composer.y + composer.h).toBeLessThan(thread.y);
  });
});

describe("unionBoxes", () => {
  it("is null for nothing", () => {
    expect(unionBoxes([])).toBeNull();
  });

  it("spans every box", () => {
    expect(
      unionBoxes([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: -5, w: 10, h: 10 },
      ]),
    ).toEqual({ x: 0, y: -5, w: 30, h: 15 });
  });
});

describe("isKanbanRegionKind", () => {
  it("covers exactly the panels the board station flies to", () => {
    expect(isKanbanRegionKind("column")).toBe(true);
    expect(isKanbanRegionKind("composer")).toBe(true);
    expect(isKanbanRegionKind("board")).toBe(false);
    expect(isKanbanRegionKind("thread")).toBe(false);
  });
});

describe("panelIdentity", () => {
  it("gives every instance of a kind its own panel", () => {
    expect(panelIdentity({ kind: "terminal", entityId: "t_1" })).toBe("terminal:t_1");
    expect(panelIdentity({ kind: "terminal", entityId: "t_2" })).not.toBe(
      panelIdentity({ kind: "terminal", entityId: "t_1" }),
    );
  });

  it("keeps one host console", () => {
    expect(panelIdentity({ kind: "terminal", entityId: "" })).toBe("terminal");
  });
});

describe("panelPresence", () => {
  const viewport = { x: 0, y: 0, w: 1600, h: 1000 };

  it("is 1 when the panel spans the screen", () => {
    expect(panelPresence({ x: -100, y: -100, w: 2000, h: 2000 }, viewport)).toBe(1);
  });

  it("is 0 when the panel is offscreen", () => {
    expect(panelPresence({ x: 2000, y: 0, w: 100, h: 100 }, viewport)).toBe(0);
  });

  // The case area got wrong: a thread panel filling the window top to bottom
  // covers under half its area on a wide screen, and has to read as live.
  it("counts a tall narrow panel by its height", () => {
    expect(panelPresence({ x: 350, y: 40, w: 900, h: 820 }, viewport)).toBeCloseTo(0.82);
  });

  // The Hermes panel sitting off the right edge while you are on the board: full
  // height, one strip showing, and not the thing you are looking at.
  it("discounts a panel hanging off the edge", () => {
    expect(panelPresence({ x: 1540, y: 0, w: 560, h: 1000 }, viewport)).toBeLessThan(LIVE_PRESENCE);
  });

  it("still counts a panel zoomed past the window edges", () => {
    expect(panelPresence({ x: -200, y: -100, w: 2000, h: 1200 }, viewport)).toBe(1);
  });

  it("falls off as the canvas zooms out", () => {
    expect(panelPresence({ x: 0, y: 0, w: 370, h: 230 }, viewport)).toBeCloseTo(0.23);
  });

  it("survives a viewport with no area", () => {
    expect(panelPresence({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
  });
});

describe("isPanelLive", () => {
  const base = { presence: 1, isEditing: false, toolId: "select" };

  it("hands the pointer over once the panel dominates the screen", () => {
    expect(isPanelLive(base)).toBe(true);
    expect(isPanelLive({ ...base, presence: LIVE_PRESENCE - 0.01 })).toBe(false);
  });

  it("keeps the pointer on the canvas while a drawing tool is up", () => {
    expect(isPanelLive({ ...base, toolId: "draw" })).toBe(false);
  });

  it("stays live while being edited, however far out you are", () => {
    expect(isPanelLive({ ...base, presence: 0, isEditing: true, toolId: "draw" })).toBe(true);
  });

  // A focused panel is drawn at window size outside the canvas transform, so
  // the camera it left behind says nothing about whether it takes the pointer.
  it("is live when focused, whatever the camera is doing", () => {
    expect(isPanelLive({ ...base, presence: 0, toolId: "draw", focused: true })).toBe(true);
  });
});

describe("screenBox", () => {
  it("matches the mapping tldraw applies to its own shape layer", () => {
    expect(screenBox({ x: 100, y: -2000, w: 800, h: 600 }, { x: -100, y: 2000, z: 0.5 })).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 300,
    });
  });

  it("round-trips a station camera back to where the camera put the panel", () => {
    const panel = { x: 100, y: -2000, w: 800, h: 600 };
    const camera = stationCamera(panel, { w: 1600, h: 1000 });
    const box = screenBox(panel, camera);
    expect(box.x).toBeCloseTo(
      CHROME_RESERVE.left + (1600 - CHROME_RESERVE.left - CHROME_RESERVE.right - box.w) / 2,
    );
    expect(box.y).toBeCloseTo(
      CHROME_RESERVE.top + (1000 - CHROME_RESERVE.top - CHROME_RESERVE.bottom - box.h) / 2,
    );
  });
});

describe("desiredStations", () => {
  // Force-presence is not a page you can close: anything in here comes back on
  // the next reconcile pass however it went away.
  // A column is a panel somebody put on the canvas, so nothing here force-
  // presences one. The only exception is a column the cards are sitting in:
  // closing that must not be how the cards in it become unreachable.
  it("force-presences the capture composer and nothing else", () => {
    expect(desiredStations([]).map(stationKey)).toEqual(["composer"]);
  });

  it("mints a panel for every column the cards are sitting in", () => {
    expect(desiredStations([], [], ["research", "done"]).map(stationKey)).toEqual([
      "column:research",
      "column:done",
      "composer",
    ]);
  });

  it("adds one panel per live shell a thread is running, once", () => {
    expect(
      desiredStations([], [], [], ["a/term-1", "a/term-1", "", "b/term-2"])
        .map(stationKey)
        .slice(-2),
    ).toEqual(["terminal:a/term-1", "terminal:b/term-2"]);
  });

  it("adds one panel per running thread, once", () => {
    expect(desiredStations(["a", "a", "", "b"]).map(stationKey).slice(-2)).toEqual([
      "thread:a",
      "thread:b",
    ]);
  });

  // The monolithic board panel from an older snapshot must read as stale so
  // the reconciler replaces it with the column panels.
  it("no longer wants a board panel", () => {
    const existing = [{ kind: "board", entityId: "" } as const, ...desiredStations([])];
    expect(staleStations(desiredStations([]), existing)).toEqual([{ kind: "board", entityId: "" }]);
  });

  // The regression this slice exists for: closing Hermes used to put it back.
  it("does not respawn a page the human closed", () => {
    const existing = seedStations().filter((ref) => ref.kind !== "hermes");
    expect(missingStations(desiredStations([]), existing)).toEqual([]);
    expect(staleStations(desiredStations([]), existing)).toEqual([]);
  });
});

describe("seedStations", () => {
  it("opens a fresh canvas on the board plus the fixed pages", () => {
    expect(seedStations().map(stationKey)).toEqual([
      "column:prompts",
      "column:active",
      "column:pr",
      "column:done",
      "composer",
      "hermes",
      "settings",
      "terminal",
      "explorer",
      "threads",
    ]);
  });
});

describe("nextPanelSlot", () => {
  it("counts the panels of that kind already on the page", () => {
    const existing = [
      { kind: "editor", entityId: "p:a.ts" } as const,
      { kind: "explorer", entityId: "p" } as const,
      { kind: "editor", entityId: "p:b.ts" } as const,
    ];
    expect(nextPanelSlot("editor", existing)).toBe(2);
    expect(nextPanelSlot("terminal", existing)).toBe(0);
  });
});

describe("missingStations", () => {
  it("keeps a thread's slot when an earlier thread already has a panel", () => {
    const desired = desiredStations(["a", "b"]);
    const missing = missingStations(desired, [
      ...desiredStations([]),
      { kind: "thread", entityId: "a" },
    ]);
    expect(missing).toEqual([{ ref: { kind: "thread", entityId: "b" }, threadIndex: 1 }]);
  });

  it("asks for nothing when the page is already complete", () => {
    const desired = desiredStations(["a"]);
    expect(missingStations(desired, desired)).toEqual([]);
  });
});

describe("staleStations", () => {
  // Archiving the card is what takes a thread off the board; its panel has to
  // go with it, or the canvas keeps showing the thing that was archived.
  it("reaps the panel of a thread the board no longer runs", () => {
    const existing = [...desiredStations(["a", "b"])];
    expect(staleStations(desiredStations(["a"]), existing)).toEqual([
      { kind: "thread", entityId: "b" },
    ]);
  });

  it("never reaps a fixed page", () => {
    expect(staleStations(desiredStations([]), desiredStations([]))).toEqual([]);
  });

  // A panel a human opened is theirs. Nothing desires a terminal or an editor,
  // and the reconciler must not read that as permission to delete one.
  it("never reaps a page a human opened", () => {
    const existing = [
      ...seedStations(),
      { kind: "terminal", entityId: "" } as const,
      { kind: "explorer", entityId: "p" } as const,
      { kind: "editor", entityId: "p:a.ts" } as const,
    ];
    expect(staleStations(desiredStations([]), existing)).toEqual([]);
  });

  // A shell a thread opened is the canvas's, not a human's: it goes when the
  // thread does. The console's own shells sit in the same kind and are a
  // human's — never touched, whatever the roster says.
  it("reaps a thread's shell with its thread, never the console's", () => {
    const existing = [
      { kind: "terminal", entityId: "" } as const,
      { kind: "terminal", entityId: "term-2" } as const,
      { kind: "terminal", entityId: "a/term-1" } as const,
    ];
    expect(staleStations(desiredStations([], [], [], []), existing)).toEqual([
      { kind: "terminal", entityId: "a/term-1" },
    ]);
  });

  // The panel appears the first time the thread uses the shell and then stays.
  // Reaping it when the command ends would clear the output out from under
  // whoever is reading it.
  it("keeps a thread's panels after the session behind them ends", () => {
    const existing = [
      { kind: "thread", entityId: "a" } as const,
      { kind: "terminal", entityId: "a/term-1" } as const,
      { kind: "browser", entityId: "a/tab-1" } as const,
      { kind: "terminal", entityId: "b/term-1" } as const,
    ];
    // Nothing is running any more, and thread `a` is still on the board.
    const desired = [...desiredStations(["a"]), ...keptThreadPanels(existing, ["a"])];
    expect(staleStations(desired, existing).map(stationKey)).toEqual(["terminal:b/term-1"]);
  });

  it("keeps the panel the camera is on", () => {
    const existing = [...desiredStations(["a"])];
    expect(staleStations(desiredStations([]), existing, { kind: "thread", entityId: "a" })).toEqual(
      [],
    );
  });

  it("reaps a duplicate-free set even when the board grew", () => {
    const existing = [...desiredStations(["a"])];
    expect(staleStations(desiredStations(["a", "b"]), existing)).toEqual([]);
  });

  // A canvas saved while the gallery existed still holds its shapes. They parse,
  // so the board opens, and then they go — unlike a terminal, nobody opened one.
  it("reaps the removed gallery out of an older snapshot", () => {
    const existing = [
      ...seedStations(),
      { kind: "dev", entityId: "" } as const,
      { kind: "dev", entityId: "kanban/card#pr-failed" } as const,
    ];
    expect(staleStations(desiredStations([]), existing)).toEqual([
      { kind: "dev", entityId: "" },
      { kind: "dev", entityId: "kanban/card#pr-failed" },
    ]);
  });
});

describe("stationCamera", () => {
  const panel = { x: 100, y: -2000, w: 800, h: 600 };
  /** tldraw maps a page point to the screen as `(page + camera) * z`. */
  const toScreen = (camera: { x: number; y: number; z: number }, x: number, y: number) => ({
    x: (x + camera.x) * camera.z,
    y: (y + camera.y) * camera.z,
  });

  it("keeps the panel clear of the toolbar and the style panel", () => {
    const screen = { w: 1600, h: 1000 };
    const camera = stationCamera(panel, screen);
    const topLeft = toScreen(camera, panel.x, panel.y);
    const bottomRight = toScreen(camera, panel.x + panel.w, panel.y + panel.h);
    expect(topLeft.x).toBeGreaterThanOrEqual(CHROME_RESERVE.left);
    expect(topLeft.y).toBeGreaterThanOrEqual(CHROME_RESERVE.top);
    expect(bottomRight.x).toBeLessThanOrEqual(screen.w - CHROME_RESERVE.right);
    expect(bottomRight.y).toBeLessThanOrEqual(screen.h - CHROME_RESERVE.bottom);
  });

  it("never blows a panel up past its authored size", () => {
    expect(stationCamera(panel, { w: 4000, h: 3000 }).z).toBe(1);
  });

  it("shrinks to fit a window smaller than the panel", () => {
    const camera = stationCamera(panel, { w: 900, h: 700 });
    expect(camera.z).toBeLessThan(1);
    expect(camera.z).toBeGreaterThan(0.1);
  });
});

describe("chromeReserve", () => {
  it("holds nothing back once the tools are put away", () => {
    expect(chromeReserve({ screenWidth: 1600, toolsHidden: true })).toBe(BARE_RESERVE);
    expect(chromeReserve({ screenWidth: 390, toolsHidden: true })).toBe(BARE_RESERVE);
  });

  it("dodges the style panel on a desktop window", () => {
    expect(chromeReserve({ screenWidth: 1600, toolsHidden: false })).toBe(CHROME_RESERVE);
  });

  it("stops holding back half a phone for a style panel that is a popover", () => {
    const reserve = chromeReserve({ screenWidth: 390, toolsHidden: false });
    expect(reserve).toBe(MOBILE_RESERVE);
    expect(reserve.right).toBeLessThan(390 / 4);
  });

  it("gives a phone station most of its width", () => {
    const panel = { x: 0, y: -2000, w: 1480, h: 920 };
    const screen = { w: 390, h: 844 };
    const desktopish = stationCamera(panel, screen, CHROME_RESERVE);
    const phone = stationCamera(
      panel,
      screen,
      chromeReserve({ screenWidth: 390, toolsHidden: false }),
    );
    expect(phone.z).toBeGreaterThan(desktopish.z * 1.9);
  });
});

describe("clearOfPanels", () => {
  const wanted = { x: 0, y: 0, w: 100, h: 100 };

  it("keeps the wanted spot when nothing is standing there", () => {
    expect(clearOfPanels(wanted, [{ x: 400, y: 400, w: 100, h: 100 }])).toEqual(wanted);
  });

  it("keeps the wanted spot when a neighbour only touches its edge", () => {
    expect(clearOfPanels(wanted, [{ x: 100, y: 0, w: 100, h: 100 }])).toEqual(wanted);
  });

  it("nudges a thread into the next place in the row, not half onto it", () => {
    const first = panelPlacement({ kind: "thread", entityId: "a" }, 0);
    const second = panelPlacement({ kind: "thread", entityId: "b" }, 1);
    // The row's own pitch: a thread whose slot is taken lands on the next slot.
    expect(clearOfPanels(first, [first])).toEqual(second);
  });

  it("steps off a panel already there, and lands clear of every one", () => {
    const occupied = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 140, y: 0, w: 100, h: 100 },
    ];
    const placed = clearOfPanels(wanted, occupied, 40);
    expect(occupied.some((box) => boxesOverlap(placed, box))).toBe(false);
    expect(placed.w).toBe(wanted.w);
    expect(placed.h).toBe(wanted.h);
  });

  it("takes the nearest free cell rather than the far side of the page", () => {
    const placed = clearOfPanels(wanted, [{ x: 0, y: 0, w: 100, h: 100 }], 40);
    expect(Math.hypot(placed.x - wanted.x, placed.y - wanted.y)).toBeLessThanOrEqual(140);
  });

  it("never stacks a queue of panels opened one after another", () => {
    const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let index = 0; index < 12; index += 1) {
      const placed = clearOfPanels(wanted, occupied, 40);
      expect(occupied.some((box) => boxesOverlap(placed, box))).toBe(false);
      occupied.push(placed);
    }
  });

  it("hands back the wanted spot when there is nowhere free to go", () => {
    const wall = { x: -100_000, y: -100_000, w: 200_000, h: 200_000 };
    expect(clearOfPanels(wanted, [wall], 40)).toEqual(wanted);
  });
});

describe("nextFreeSlot", () => {
  const thread = { kind: "thread", entityId: "a" } as const;

  it("takes the front of the row when nothing is standing in it", () => {
    expect(nextFreeSlot(thread, [])).toBe(0);
  });

  it("walks past the places already taken", () => {
    const taken = [0, 1, 2].map((slot) => panelPlacement(thread, slot));
    expect(nextFreeSlot(thread, taken)).toBe(3);
  });

  it("fills the gap a closed thread left rather than queueing past it", () => {
    const taken = [0, 2, 3].map((slot) => panelPlacement(thread, slot));
    expect(nextFreeSlot(thread, taken)).toBe(1);
  });

  it("packs a row of threads left to right with no overlap", () => {
    const placed: Array<ReturnType<typeof panelPlacement>> = [];
    for (let index = 0; index < 6; index += 1) {
      const box = panelPlacement(thread, nextFreeSlot(thread, placed));
      expect(placed.some((other) => boxesOverlap(box, other))).toBe(false);
      placed.push(box);
    }
    expect(placed.map((box) => box.x)).toEqual(
      [0, 1, 2, 3, 4, 5].map((slot) => panelPlacement(thread, slot).x),
    );
    expect(new Set(placed.map((box) => box.y)).size).toBe(1);
  });
});

describe("threadLaneBox", () => {
  it("never draws narrower than its authored width", () => {
    expect(threadLaneBox(0)).toEqual(threadLaneBox(THREAD_LANE_SLOTS));
    expect(threadLaneBox(1)).toEqual(threadLaneBox(THREAD_LANE_SLOTS));
  });

  it("holds every place a thread in it stands", () => {
    for (const slots of [THREAD_LANE_SLOTS, 7]) {
      const lane = threadLaneBox(slots);
      for (let slot = 0; slot < slots; slot += 1) {
        const box = panelPlacement({ kind: "thread", entityId: "a" }, slot);
        expect(box.x).toBeGreaterThanOrEqual(lane.x);
        expect(box.x + box.w).toBeLessThanOrEqual(lane.x + lane.w);
        expect(box.y).toBe(lane.y);
        expect(box.h).toBe(lane.h);
      }
    }
  });

  it("grows rightward as the row does, from a fixed left edge", () => {
    const wide = threadLaneBox(9);
    const narrow = threadLaneBox(THREAD_LANE_SLOTS);
    expect(wide.x).toBe(narrow.x);
    expect(wide.w).toBeGreaterThan(narrow.w);
  });

  it("keeps the lane clear of the drawing space", () => {
    const lane = threadLaneBox(24);
    expect(lane.y + lane.h).toBeLessThanOrEqual(0);
  });
});

describe("the seeded canvas", () => {
  const seeded = () => {
    const order = new Map(SEED_COLUMN_IDS.map((id, index) => [id, index] as const));
    return seedStations(SEED_COLUMN_IDS).map((ref) => ({
      ref,
      box: panelPlacement(ref, order.get(ref.entityId) ?? 0),
    }));
  };

  const boardFrame = () => {
    const region = seeded()
      .filter(({ ref }) => isKanbanRegionKind(ref.kind))
      .map(({ box }) => box);
    return frameAround(unionBoxes(region)!);
  };

  it("leaves the thread lane clear of the board", () => {
    expect(boxesOverlap(boardFrame(), frameAround(threadLaneBox(0)))).toBe(false);
  });

  it("keeps the lane's border off the composer it sits under", () => {
    const composer = seeded().find(({ ref }) => ref.kind === "composer")!.box;
    expect(boxesOverlap(frameAround(threadLaneBox(0)), composer)).toBe(false);
  });

  it("stands every seeded page in its own frame", () => {
    const frames = seeded()
      .filter(({ ref }) => !isKanbanRegionKind(ref.kind))
      .map(({ ref, box }) => ({ ref, frame: frameAround(box) }));
    const all = [boardFrame(), frameAround(threadLaneBox(0)), ...frames.map((f) => f.frame)];
    for (let i = 0; i < all.length; i += 1)
      for (let j = i + 1; j < all.length; j += 1)
        expect([i, j, boxesOverlap(all[i]!, all[j]!)]).toEqual([i, j, false]);
  });
});
