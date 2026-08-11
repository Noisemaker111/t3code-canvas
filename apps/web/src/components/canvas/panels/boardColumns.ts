/**
 * The board's columns — read off the canvas, not out of a config.
 *
 * A column is a `column` panel. Its id is the panel's address, its name is the
 * panel's title, and its order is where it stands. Adding a column is adding a
 * component; renaming one is renaming a panel; removing one is closing it.
 * There is no list of columns anywhere else, which is the whole point: the
 * component holds the data.
 *
 * The one thing the canvas does not get to decide is whether a column exists at
 * all. A card carries a column id, so an id with cards in it is a column
 * whether or not a panel is standing for it — {@link boardColumns} appends
 * those, and the reconciler mints a panel for each, so closing a column that
 * still holds work cannot make the work unreachable.
 *
 * No React and no tldraw in here: the shapes are read where they are read, and
 * this turns them into the list every column surface draws from.
 *
 * @module components/canvas/panels/boardColumns
 */

/** A column, as everything that draws one needs it. */
export interface BoardColumnView {
  readonly id: string;
  readonly title: string;
  /** Whether a panel is standing for it, or it exists only because cards do. */
  readonly panelled: boolean;
}

/** A column panel, as the canvas has it. */
export interface ColumnPanelEntry {
  readonly entityId: string;
  /** The panel's typed name. Empty means "call it by its id". */
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

/**
 * What a column is called when its panel has no typed name: the id, with the
 * separators it is spelled with read as spaces and the first letter raised.
 * `prompts` reads Prompts and `to-research` reads To research, so a column
 * minted by a rule looks like one somebody named.
 */
export function columnTitleFromId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The board's columns, in the order they stand: left to right, then top to
 * bottom for two rows of them, then by id so a tie is stable across reloads.
 *
 * Columns whose only evidence is a card come last and are marked `panelled:
 * false` — the reconciler reads that to mint the panel they are missing.
 */
export function boardColumns(input: {
  readonly panels: ReadonlyArray<ColumnPanelEntry>;
  /** Every `card.column` the board is holding right now. */
  readonly cardColumns: ReadonlyArray<string>;
}): ReadonlyArray<BoardColumnView> {
  const seen = new Set<string>();
  const placed: Array<BoardColumnView> = [];
  for (const panel of [...input.panels].sort(byPosition)) {
    const id = panel.entityId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    placed.push({
      id,
      title: panel.title.trim().length > 0 ? panel.title.trim() : columnTitleFromId(id),
      panelled: true,
    });
  }
  const orphans: Array<BoardColumnView> = [];
  for (const raw of input.cardColumns) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    orphans.push({ id, title: columnTitleFromId(id), panelled: false });
  }
  return [...placed, ...orphans];
}

/**
 * The column panels as one string, and back.
 *
 * Reading shapes reactively touches every shape on the page, so the read has to
 * hand React something it can compare — a stroke of a drawing must not rebuild
 * the board. A string is that; it is written and read here rather than as JSON
 * at each call site, so the two ends cannot drift and nothing has to cast an
 * untrusted parse back into a type.
 */
const FIELD = "\u0001";
const ROW = "\u0000";

export function encodeColumnPanels(panels: ReadonlyArray<ColumnPanelEntry>): string {
  return panels
    .map((panel) => [panel.entityId, panel.title, panel.x, panel.y].join(FIELD))
    .join(ROW);
}

export function decodeColumnPanels(encoded: string): ReadonlyArray<ColumnPanelEntry> {
  if (encoded.length === 0) return [];
  const panels: Array<ColumnPanelEntry> = [];
  for (const row of encoded.split(ROW)) {
    const [entityId = "", title = "", x = "", y = ""] = row.split(FIELD);
    if (entityId.length === 0) continue;
    panels.push({ entityId, title, x: Number(x) || 0, y: Number(y) || 0 });
  }
  return panels;
}

/** Every column id in a list of ids, deduped and blank-free. */
export function distinctColumnIds(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const id of ids) if (id.length > 0) seen.add(id);
  return [...seen];
}

function byPosition(a: ColumnPanelEntry, b: ColumnPanelEntry): number {
  if (a.x !== b.x) return a.x - b.x;
  if (a.y !== b.y) return a.y - b.y;
  return a.entityId.localeCompare(b.entityId);
}

/** One column out of the list. An id nothing stands for describes itself. */
export function boardColumn(columns: ReadonlyArray<BoardColumnView>, id: string): BoardColumnView {
  return (
    columns.find((column) => column.id === id) ?? {
      id,
      title: columnTitleFromId(id),
      panelled: false,
    }
  );
}

/**
 * The id a new column panel takes. Numbered from the count so two Adds in a row
 * do not collide, and skipped past anything already using the name.
 */
export function nextColumnId(existing: ReadonlyArray<string>): string {
  const taken = new Set(existing);
  for (let n = existing.length + 1; ; n += 1) {
    const id = `column-${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The columns a fresh canvas is seeded with — a starting composition, not a
 * schema. Every one of them can be renamed, reordered, closed, or joined by
 * another, and nothing reads this list after the first load.
 *
 * They are the four Hermes writes its built-in rules against
 * (`DEFAULT_RULES`), so a board nobody has touched behaves exactly as
 * it always did.
 */
export const SEED_COLUMN_IDS: ReadonlyArray<string> = ["prompts", "active", "pr", "done"];

/** What each seeded column is called before anybody renames it. */
export const SEED_COLUMN_TITLES: Readonly<Record<string, string>> = {
  prompts: "Prompts",
  active: "Active",
  pr: "PR",
  done: "Done",
};
