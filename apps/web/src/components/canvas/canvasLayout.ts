import type { CanvasInjection, CanvasInjectionSpec, CanvasNode } from "@t3tools/contracts";

/**
 * Where a Hermes drawing lands on the canvas.
 *
 * Kept free of tldraw so the placement rules — which nodes go where, how big the
 * frame is, which viewport to focus — are testable without an editor. The
 * component turns these numbers into shapes.
 *
 * @module components/canvas/canvasLayout
 */

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 100;
/** Gap between boxes. Wide enough for an edge label to sit on one line. */
export const NODE_GAP_X = 190;
export const NODE_GAP_Y = 70;
export const FRAME_PADDING = 60;
/** Room under the last row for the injection's note. */
export const NOTE_HEIGHT = 120;

export type PlacedNode = {
  readonly node: CanvasNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Bounds = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type CanvasLayout = {
  readonly nodes: ReadonlyArray<PlacedNode>;
  /** The frame every shape in this injection is parented to. */
  readonly frame: Bounds;
  /** Null when the injection carried no note. */
  readonly note: Bounds | null;
  /** What to zoom to when the injection asks for focus. */
  readonly focus: Bounds;
};

/** A near-square grid reads better than one long row for anything past a few. */
export function gridColumns(count: number): number {
  if (count <= 0) return 1;
  return Math.min(4, Math.ceil(Math.sqrt(count)));
}

/**
 * Nodes that carry coordinates keep them; the rest fall into a grid. Mixing the
 * two is deliberate — a model that only knows the shape of a flow can place the
 * two nodes it cares about and let the rest land somewhere sane.
 */
export function layoutInjection(spec: CanvasInjectionSpec, origin: Bounds): CanvasLayout {
  const columns = gridColumns(spec.nodes.length);
  const placed: Array<PlacedNode> = spec.nodes.map((node, index) => {
    const width = node.width ?? NODE_WIDTH;
    const height = node.height ?? NODE_HEIGHT;
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      node,
      x: node.x ?? origin.x + column * (NODE_WIDTH + NODE_GAP_X),
      y: node.y ?? origin.y + row * (NODE_HEIGHT + NODE_GAP_Y),
      width,
      height,
    };
  });

  const hasNote = typeof spec.note === "string" && spec.note.trim().length > 0;

  if (placed.length === 0) {
    const frame = { x: origin.x, y: origin.y, w: NODE_WIDTH, h: NODE_HEIGHT };
    return { nodes: [], frame, note: null, focus: frame };
  }

  const minX = Math.min(...placed.map((entry) => entry.x));
  const minY = Math.min(...placed.map((entry) => entry.y));
  const maxX = Math.max(...placed.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...placed.map((entry) => entry.y + entry.height));

  const note: Bounds | null = hasNote
    ? { x: minX, y: maxY + NODE_GAP_Y, w: Math.max(maxX - minX, NODE_WIDTH), h: NOTE_HEIGHT }
    : null;

  const contentBottom = note === null ? maxY : note.y + note.h;
  const frame: Bounds = {
    x: minX - FRAME_PADDING,
    y: minY - FRAME_PADDING,
    w: maxX - minX + FRAME_PADDING * 2,
    h: contentBottom - minY + FRAME_PADDING * 2,
  };

  return { nodes: placed, frame, note, focus: frame };
}

/**
 * Stack each new drawing under the last so injections never land on top of each
 * other — or on the human's work, when `existing` is the current page bounds.
 */
export function nextOrigin(existing: Bounds | null): Bounds {
  if (existing === null) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: existing.x, y: existing.y + existing.h + FRAME_PADDING * 2, w: 0, h: 0 };
}

/** Oldest first, so a replayed backlog lands in the order Hermes drew it. */
export function pendingInOrder(
  injections: ReadonlyArray<CanvasInjection>,
): ReadonlyArray<CanvasInjection> {
  return injections
    .filter((injection) => injection.appliedAt === null)
    .toSorted((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}
