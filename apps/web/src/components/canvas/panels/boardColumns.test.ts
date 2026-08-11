import { describe, expect, it } from "@effect/vitest";

import {
  boardColumn,
  boardColumns,
  columnTitleFromId,
  nextColumnId,
  SEED_COLUMN_IDS,
  SEED_COLUMN_TITLES,
  type ColumnPanelEntry,
} from "./boardColumns";

function panel(entityId: string, x: number, title = ""): ColumnPanelEntry {
  return { entityId, title, x, y: 0 };
}

describe("boardColumns", () => {
  it("is the column panels, left to right — where they stand is the order", () => {
    const columns = boardColumns({
      panels: [panel("review", 900), panel("ideas", 0), panel("doing", 400)],
      cardColumns: [],
    });
    expect(columns.map((column) => column.id)).toEqual(["ideas", "doing", "review"]);
  });

  it("takes each name off its own panel, and falls back to the id", () => {
    const columns = boardColumns({
      panels: [panel("prompts", 0, "Inbox"), panel("to-research", 400)],
      cardColumns: [],
    });
    expect(columns.map((column) => column.title)).toEqual(["Inbox", "To research"]);
  });

  it("draws a column for an id the cards carry with no panel of its own", () => {
    const columns = boardColumns({
      panels: [panel("ideas", 0)],
      cardColumns: ["ideas", "shipped"],
    });
    expect(columns.map((column) => [column.id, column.panelled])).toEqual([
      ["ideas", true],
      ["shipped", false],
    ]);
  });

  it("never lists a column twice, however many panels or cards name it", () => {
    const columns = boardColumns({
      panels: [panel("ideas", 0), panel("ideas", 400)],
      cardColumns: ["ideas", "ideas"],
    });
    expect(columns).toHaveLength(1);
  });

  it("is empty on a canvas with no columns and no cards", () => {
    expect(boardColumns({ panels: [], cardColumns: [] })).toEqual([]);
  });

  // Two columns dropped at the same x is a real state — a duplicate, a paste —
  // and the board must read the same way on every reload.
  it("breaks a tie the same way every time", () => {
    const same = { panels: [panel("b", 10), panel("a", 10)], cardColumns: [] };
    expect(boardColumns(same).map((column) => column.id)).toEqual(["a", "b"]);
  });
});

describe("boardColumn", () => {
  it("answers for an id nothing stands for rather than returning nothing", () => {
    expect(boardColumn([], "to-review")).toEqual({
      id: "to-review",
      title: "To review",
      panelled: false,
    });
  });
});

describe("columnTitleFromId", () => {
  it("reads an id as words", () => {
    expect(columnTitleFromId("prompts")).toBe("Prompts");
    expect(columnTitleFromId("to_research")).toBe("To research");
    expect(columnTitleFromId("column-3")).toBe("Column 3");
  });
});

describe("nextColumnId", () => {
  it("skips past the ids already taken", () => {
    expect(nextColumnId([])).toBe("column-1");
    expect(nextColumnId(["a", "b"])).toBe("column-3");
    expect(nextColumnId(["column-1", "column-2"])).toBe("column-3");
    expect(nextColumnId(["a", "column-3"])).toBe("column-4");
  });
});

describe("the seed", () => {
  // The seed is a starting composition, not a schema — but it is what Hermes's
  // built-in rules are written against, so a board nobody has touched has to
  // come up with exactly those four.
  it("is the four columns the built-in rules are written for", () => {
    expect([...SEED_COLUMN_IDS]).toEqual(["prompts", "active", "pr", "done"]);
  });

  // Done was called "Archived", which read as the place to park a card you were
  // finished with — and Hermes reads Done as work that shipped. Archiving is a
  // separate thing with its own drop target.
  it("calls the merge column Done", () => {
    expect(SEED_COLUMN_TITLES["done"]).toBe("Done");
  });
});
