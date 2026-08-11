/**
 * Layout as a mode, not a script.
 *
 * A frame's contents used to be three hand-written functions computing pixels —
 * `index * (columnW + LAYOUT_GUTTER)` and its cousins — behind a closed union
 * of three ids. That is a layout *system* nobody outside the file could add to,
 * and it is the wrong shape twice over: layout is spatial, the canvas is
 * already the editor for it, and what a frame holds is whatever you dropped in.
 *
 * So a frame arranges what it holds by a mode. Four of them, and they are the
 * whole vocabulary:
 *
 * - `free` — wherever you put it. The canvas already does this; nothing here.
 * - `row` — side by side, in order.
 * - `column` — stacked, in order.
 * - `tile` — as square a grid as the count allows.
 *
 * Drop a hundred terminals into a tile frame on a big enough monitor and you
 * get ten by ten because that is what fits. Nobody writes `grid(10, 10)`.
 *
 * @module components/canvas/panels/arrange
 */
import type { PanelSize } from "./panelRegistry";
import type { Box } from "./panelStations";

export const LAYOUT_MODES = ["free", "row", "column", "tile"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export function isLayoutMode(value: string): value is LayoutMode {
  return (LAYOUT_MODES as ReadonlyArray<string>).includes(value);
}

/** Gap between two panels standing in the same frame. */
export const LAYOUT_GUTTER = 24;

/**
 * Where each of `sizes` goes, measured from the frame's content origin.
 *
 * Sizes are the panels' own authored sizes: a frame does not stretch what is
 * standing in it, which is the one thing the canvas has always been firm about.
 * `free` returns nothing to place — the panels are already where they were put.
 */
export function arrange(
  mode: LayoutMode,
  sizes: ReadonlyArray<PanelSize>,
  gutter = LAYOUT_GUTTER,
): ReadonlyArray<Box> {
  if (mode === "free" || sizes.length === 0) return [];
  if (mode === "row") return along(sizes, gutter, "x");
  if (mode === "column") return along(sizes, gutter, "y");
  return tile(sizes, gutter);
}

function along(
  sizes: ReadonlyArray<PanelSize>,
  gutter: number,
  axis: "x" | "y",
): ReadonlyArray<Box> {
  let offset = 0;
  return sizes.map((size) => {
    const box: Box = axis === "x" ? { x: offset, y: 0, ...size } : { x: 0, y: offset, ...size };
    offset += (axis === "x" ? size.w : size.h) + gutter;
    return box;
  });
}

/**
 * The grid a count wants: as square as it gets, wider than tall on a tie.
 *
 * Rows are as tall as their tallest member and columns as wide as the widest,
 * so a grid of unequal panels still lines up instead of overlapping.
 */
function tile(sizes: ReadonlyArray<PanelSize>, gutter: number): ReadonlyArray<Box> {
  const across = Math.ceil(Math.sqrt(sizes.length));
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  sizes.forEach((size, index) => {
    const col = index % across;
    const row = Math.floor(index / across);
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, size.w);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.h);
  });

  const xs = offsets(columnWidths, gutter);
  const ys = offsets(rowHeights, gutter);
  return sizes.map((size, index) => ({
    x: xs[index % across] ?? 0,
    y: ys[Math.floor(index / across)] ?? 0,
    ...size,
  }));
}

function offsets(spans: ReadonlyArray<number>, gutter: number): ReadonlyArray<number> {
  let running = 0;
  return spans.map((span) => {
    const at = running;
    running += span + gutter;
    return at;
  });
}

/** How many across a tiled frame of this many panels reads as. */
export function tileColumns(count: number): number {
  return count === 0 ? 0 : Math.ceil(Math.sqrt(count));
}
