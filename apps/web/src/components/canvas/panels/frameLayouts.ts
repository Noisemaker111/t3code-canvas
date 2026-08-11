/**
 * Frame layouts — a frame's contents, written down instead of compiled in.
 *
 * A frame is a border around panels ({@link module:components/canvas/panels/panelFrames}).
 * A *layout* is what to stand inside one: a list of panels with the box each
 * occupies, measured from the frame's content origin. Nothing here draws, and
 * nothing here is bound — once the panels exist they are ordinary canvas
 * panels, movable and closable, and the frame is only the rectangle drawn
 * around them.
 *
 * The rules are TypeScript because they are rules, not rows: a layout is a
 * function of what the board actually has — its columns, its projects, its
 * running threads. The kanban layout is the proof. The board used to be four
 * column panels the canvas knew by name; it is a row of whatever column panels
 * the canvas is holding, so "ideas / research / implement / review" is four
 * components you added and the frame that draws them needs no code of its own.
 *
 * Three ship:
 * - `kanban` — the columns, and the capture composer under them.
 * - `agents` — threads down the left, the conversation beside them, Hermes
 *   under the list. Click a thread row, or drag one onto the canvas.
 * - `ide` — file tree, editor, terminal, git.
 *
 * Nothing stops a fourth, or a hybrid: an IDE with a column beside it is a
 * layout whose list happens to hold both. The layout is the whole definition.
 *
 * @module components/canvas/panels/frameLayouts
 */

import { arrange, LAYOUT_GUTTER } from "./arrange";
import { SEED_COLUMN_IDS } from "./boardColumns";
import { panelSize, type PanelKind } from "./panelRegistry";
import type { Box, PanelRef } from "./panelStations";

export { LAYOUT_GUTTER } from "./arrange";

/** One panel in a layout, at a box measured from the frame's content origin. */
export interface FramePlacement {
  readonly ref: PanelRef;
  readonly box: Box;
}

/**
 * What a layout is allowed to read. Everything in here is something the board
 * already knows — a layout never fetches, and never invents an id.
 */
export interface FrameLayoutContext {
  /** The board's columns, in the order they stand on the canvas. */
  readonly columnIds: ReadonlyArray<string>;
  /** The project a workspace panel opens against. Empty means the first one. */
  readonly projectId: string;
  /** `owner/repo` bindings for the review lists. Empty means every bound repo. */
  readonly repoBinding: string;
  /** Threads the board is running, newest first. Empty is the ordinary case. */
  readonly threadIds: ReadonlyArray<string>;
}

export interface FrameLayout {
  readonly id: FrameLayoutId;
  readonly label: string;
  /** One line for the add menu — what standing in this frame gets you. */
  readonly summary: string;
  readonly build: (context: FrameLayoutContext) => ReadonlyArray<FramePlacement>;
}

/**
 * A layout id. Any name — a starting composition somebody saves has to be
 * nameable, and a closed union is a list nobody outside this file can add to.
 *
 * {@link FRAME_LAYOUT_IDS} stays as the compositions *this build* ships. It is
 * not a schema: a frame naming one this build does not have keeps its name and
 * arranges nothing, which is a `free` frame — the panels are where they were
 * put, and that is the honest reading of "I do not know this layout".
 */
export type FrameLayoutId = string;

export const FRAME_LAYOUT_IDS = ["kanban", "agents", "ide"] as const;

/** One of the compositions this build ships. */
export type BuiltinFrameLayoutId = (typeof FRAME_LAYOUT_IDS)[number];

export function isFrameLayoutId(id: string): id is BuiltinFrameLayoutId {
  return (FRAME_LAYOUT_IDS as ReadonlyArray<string>).includes(id);
}

/** An empty context — what a layout is built against before anything is open. */
export const EMPTY_LAYOUT_CONTEXT: FrameLayoutContext = {
  columnIds: [],
  projectId: "",
  repoBinding: "",
  threadIds: [],
};

function place(kind: PanelKind, entityId: string, box: Box): FramePlacement {
  return { ref: { kind, entityId }, box };
}

/**
 * The board, as a layout: one column panel per column the board has, in a row,
 * and the capture composer centered under them.
 *
 * This is the whole of what "the kanban" is on the canvas. A board with six
 * columns gets six panels and a wider frame; a board with two gets two. The
 * only column names in this function are the seed a bare canvas starts from.
 */
function kanbanLayout(context: FrameLayoutContext): ReadonlyArray<FramePlacement> {
  // A canvas with no columns at all gets the seed row, so a Kanban frame is
  // never an empty rectangle called Kanban.
  const ids = context.columnIds.length === 0 ? SEED_COLUMN_IDS : context.columnIds;
  const column = panelSize("column");
  const composerSize = panelSize("composer");
  const columnW = column.w;
  const columns = ids.map((id, index) =>
    place("column", id, {
      x: index * (columnW + LAYOUT_GUTTER),
      y: 0,
      w: columnW,
      h: column.h,
    }),
  );
  const rowW = ids.length * columnW + (ids.length - 1) * LAYOUT_GUTTER;
  const composer = place("composer", "", {
    x: Math.round((rowW - composerSize.w) / 2),
    y: column.h + LAYOUT_GUTTER,
    w: composerSize.w,
    h: composerSize.h,
  });
  return [...columns, composer];
}

/** The conversation panel in the agents frame — wide, and the tallest thing in it. */
const AGENT_CHAT_SIZE = { w: 940, h: 900 } as const;
const AGENT_LIST_W = 300;
const AGENT_HERMES_H = 300;

/**
 * The agents IDE: threads down the left, the conversation beside them.
 *
 * The thread list is the index and the chat is the work — click a row to open
 * that thread here, or drag a row onto the canvas to open it wherever you drop
 * it. The conversation slot is the newest running thread when there is one; on
 * a board with nothing running the frame is the list, Hermes and an empty seat,
 * which is what a tool with no threads yet honestly is.
 */
function agentsLayout(context: FrameLayoutContext): ReadonlyArray<FramePlacement> {
  const listH = AGENT_CHAT_SIZE.h - AGENT_HERMES_H - LAYOUT_GUTTER;
  const chatX = AGENT_LIST_W + LAYOUT_GUTTER;
  const placements: Array<FramePlacement> = [
    place("threads", "", { x: 0, y: 0, w: AGENT_LIST_W, h: listH }),
    place("hermes", "", {
      x: 0,
      y: listH + LAYOUT_GUTTER,
      w: AGENT_LIST_W,
      h: AGENT_HERMES_H,
    }),
  ];
  const chat = context.threadIds[0];
  if (chat !== undefined) {
    placements.push(place("thread", chat, { x: chatX, y: 0, ...AGENT_CHAT_SIZE }));
  }
  return placements;
}

const IDE_EXPLORER_W = 320;
const IDE_EDITOR = { w: 900, h: 620 } as const;
const IDE_TERMINAL_H = 260;
const IDE_GIT_W = 380;

/**
 * The IDE: file tree, the file open beside it, a shell under it, git to the
 * right. Every pane is a panel that already exists on this canvas — the layout
 * is the arrangement, not four new components.
 *
 * Opening a file from the tree replaces what is in the editor seat, because an
 * editor panel is addressed by its path: a second file is a second panel, and
 * it lands in this frame beside the first.
 */
function ideLayout(context: FrameLayoutContext): ReadonlyArray<FramePlacement> {
  const editorX = IDE_EXPLORER_W + LAYOUT_GUTTER;
  const gitX = editorX + IDE_EDITOR.w + LAYOUT_GUTTER;
  const bodyH = IDE_EDITOR.h + LAYOUT_GUTTER + IDE_TERMINAL_H;
  return [
    place("explorer", context.projectId, { x: 0, y: 0, w: IDE_EXPLORER_W, h: bodyH }),
    place("editor", context.projectId, { x: editorX, y: 0, ...IDE_EDITOR }),
    place("terminal", "", {
      x: editorX,
      y: IDE_EDITOR.h + LAYOUT_GUTTER,
      w: IDE_EDITOR.w,
      h: IDE_TERMINAL_H,
    }),
    place("git", context.projectId, { x: gitX, y: 0, w: IDE_GIT_W, h: bodyH }),
  ];
}

export const FRAME_LAYOUTS: Record<FrameLayoutId, FrameLayout> = {
  kanban: {
    id: "kanban",
    label: "Kanban",
    summary: "Your columns, and the capture composer",
    build: kanbanLayout,
  },
  agents: {
    id: "agents",
    label: "Agents",
    summary: "Threads, the conversation, Hermes",
    build: agentsLayout,
  },
  ide: { id: "ide", label: "IDE", summary: "Files, editor, terminal, git", build: ideLayout },
};

/**
 * The composition a frame names, or the one an unknown name gets: a frame that
 * arranges nothing. Its panels stay where they were put, which is what `free`
 * means and the honest reading of a layout this build does not have.
 */
export function frameLayout(id: FrameLayoutId): FrameLayout {
  return FRAME_LAYOUTS[id] ?? FREE_LAYOUT;
}

const FREE_LAYOUT: FrameLayout = {
  id: "free",
  label: "Free",
  summary: "Whatever you put in it, where you put it",
  build: () => [],
};

/**
 * The box a layout's panels occupy together, or null for an empty layout. What
 * the frame is drawn around.
 *
 * Its origin is not assumed to be (0, 0): a layout may centre something wider
 * than the row above it — the kanban's composer over two columns does exactly
 * that — so the frame has to be drawn around where the panels actually are,
 * not around the quadrant they were authored from.
 */
export function layoutContentBox(placements: ReadonlyArray<FramePlacement>): Box | null {
  if (placements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { box } of placements) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
