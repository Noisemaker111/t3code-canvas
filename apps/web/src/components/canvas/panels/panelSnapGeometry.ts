/**
 * What a panel or a frame offers to line up against.
 *
 * tldraw's default is the outer box: four corners and a centre. That is enough
 * to stack windows and nothing else — the edges people actually align to are
 * inside, under the title bar and inside the frame's margin, because that is
 * where the content starts. These are those points, in shape-local coordinates,
 * for `ShapeUtil.getBoundsSnapGeometry`.
 *
 * No tldraw and no React in here: it is the arithmetic, so a snap target can be
 * argued about in a test rather than by dragging a panel around.
 *
 * @module components/canvas/panels/panelSnapGeometry
 */

export interface SnapPoint {
  readonly x: number;
  readonly y: number;
}

/** Corners, edge midpoints and centre of a box at `top` with size `w`x`h`. */
function boxPoints(w: number, h: number, top = 0): ReadonlyArray<SnapPoint> {
  const bottom = top + h;
  const midX = w / 2;
  const midY = (top + bottom) / 2;
  return [
    { x: 0, y: top },
    { x: midX, y: top },
    { x: w, y: top },
    { x: 0, y: midY },
    { x: midX, y: midY },
    { x: w, y: midY },
    { x: 0, y: bottom },
    { x: midX, y: bottom },
    { x: w, y: bottom },
  ];
}

/** Drop points that landed on the same spot, so a corner is offered once. */
function dedupe(points: ReadonlyArray<SnapPoint>): ReadonlyArray<SnapPoint> {
  const seen = new Set<string>();
  const kept: SnapPoint[] = [];
  for (const point of points) {
    const key = `${Math.round(point.x * 100)}:${Math.round(point.y * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(point);
  }
  return kept;
}

/**
 * A panel: its outer box, plus the content box under the title bar.
 *
 * A collapsed panel is its title bar, so there is no content box to offer and
 * the outer box is the whole of it.
 */
export function panelSnapPoints(input: {
  readonly w: number;
  readonly h: number;
  readonly titleBarHeight: number;
}): ReadonlyArray<SnapPoint> {
  const { w, h, titleBarHeight } = input;
  const outer = boxPoints(w, h);
  if (titleBarHeight <= 0 || titleBarHeight >= h) return dedupe(outer);
  return dedupe([...outer, ...boxPoints(w, h - titleBarHeight, titleBarHeight)]);
}

/**
 * A frame: its outer box, plus the box the panels standing in it occupy —
 * under the bar and inside the margin. Lining a panel up with a frame means
 * lining it up with where things stand in that frame, not with its border.
 */
export function frameSnapPoints(input: {
  readonly w: number;
  readonly h: number;
  readonly headerHeight: number;
  readonly padding: number;
}): ReadonlyArray<SnapPoint> {
  const { w, h, headerHeight, padding } = input;
  const outer = boxPoints(w, h);
  const innerW = w - padding * 2;
  const innerH = h - headerHeight - padding * 2;
  if (innerW <= 0 || innerH <= 0) return dedupe(outer);
  const inner = boxPoints(innerW, innerH, headerHeight + padding).map((point) => ({
    x: point.x + padding,
    y: point.y,
  }));
  return dedupe([...outer, ...inner]);
}
