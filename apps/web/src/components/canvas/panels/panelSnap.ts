/**
 * Snapping for the title-bar drags.
 *
 * Panels and frames are DOM above the canvas, so dragging one by its bar never
 * reaches tldraw's select tool — and the alignment guides that tool draws are
 * the editor's, not the tool's. This is the glue: hand tldraw the same drag it
 * would have run itself (`editor.snaps.shapeBounds`), take back the nudge, and
 * let it paint the red edge, centre and equal-gap lines it already knows how to
 * paint.
 *
 * Same contract as the select tool's translate: `--snap` is off by default and
 * Ctrl/Cmd turns it on, unless the user has snapping on in settings, where Ctrl
 * turns it off.
 *
 * @module components/canvas/panels/panelSnap
 */

import { Vec, type Box, type BoundsSnapPoint, type Editor, type TLShapeId } from "tldraw";

/** What a drag needs to remember from the moment it started to snap against. */
export interface SnapSession {
  /** Page bounds of everything moving, before the first move. */
  readonly bounds: Box;
  /** The points tldraw matches against other shapes — corners, centre, gaps. */
  readonly points: ReadonlyArray<BoundsSnapPoint>;
}

/**
 * Start snapping a drag of `ids`.
 *
 * The moving shapes are selected because that is how tldraw decides what may be
 * snapped *to*: `getSnappableShapes` skips the selection, and a shape left out
 * of it snaps to its own edges and never moves.
 */
export function beginSnapSession(
  editor: Editor,
  ids: ReadonlyArray<TLShapeId>,
): SnapSession | null {
  if (ids.length === 0) return null;
  editor.setSelectedShapes([...ids]);
  const bounds = editor.getSelectionPageBounds();
  if (!bounds) return null;
  const only = ids.length === 1 ? ids[0] : undefined;
  const points =
    only === undefined
      ? bounds.cornersAndCenter.map((point, index) => ({
          id: `selection:${index}`,
          x: point.x,
          y: point.y,
        }))
      : editor.snaps.shapeBounds.getSnapPoints(only);
  return { bounds, points };
}

/**
 * The drag delta, pulled onto whatever it lines up with — and the guides drawn
 * for that alignment. Returns the delta unchanged, and draws nothing, when
 * snapping is off for this move.
 */
export function snapDragDelta(
  editor: Editor,
  session: SnapSession,
  delta: { readonly x: number; readonly y: number },
  accelKey: boolean,
): { readonly x: number; readonly y: number } {
  editor.snaps.clearIndicators();
  if (editor.user.getIsSnapMode() ? accelKey : !accelKey) return delta;
  const { nudge } = editor.snaps.shapeBounds.snapTranslateShapes({
    dragDelta: new Vec(delta.x, delta.y),
    initialSelectionPageBounds: session.bounds,
    initialSelectionSnapPoints: [...session.points],
    lockedAxis: null,
  });
  return { x: delta.x + nudge.x, y: delta.y + nudge.y };
}

/** Take the guides down. The drop is where the shape already is. */
export function endSnapSession(editor: Editor): void {
  editor.snaps.clearIndicators();
}
