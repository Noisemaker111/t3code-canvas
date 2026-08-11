/**
 * Dragging a panel by its title bar.
 *
 * The panels are DOM outside tldraw's transform, so a pointer drag over one
 * arrives in screen pixels while the shape it moves lives in page space. This
 * module is that conversion and the click/drag threshold, with no React and no
 * editor in it.
 *
 * @module components/canvas/panels/panelDrag
 */

export interface DragPoint {
  readonly x: number;
  readonly y: number;
}

export interface PanelDragOrigin {
  /** Where the pointer went down, in screen pixels. */
  readonly pointer: DragPoint;
  /** Where the shape was, in page coordinates. */
  readonly shape: DragPoint;
  /** Camera zoom at pointer-down: screen pixels per page unit. */
  readonly zoom: number;
}

/**
 * Below this much screen movement a title-bar press is still a click, so the
 * maximize double-click and a plain focus press don't nudge the panel by a
 * pixel and write a snapshot.
 */
export const DRAG_THRESHOLD_PX = 3;

/** Where the shape goes for a pointer now at `pointer`. */
export function panelDragTarget(origin: PanelDragOrigin, pointer: DragPoint): DragPoint {
  const zoom = origin.zoom > 0 ? origin.zoom : 1;
  return {
    x: origin.shape.x + (pointer.x - origin.pointer.x) / zoom,
    y: origin.shape.y + (pointer.y - origin.pointer.y) / zoom,
  };
}

/** Whether the pointer has moved far enough to count as a drag, not a click. */
export function passedDragThreshold(origin: PanelDragOrigin, pointer: DragPoint): boolean {
  return (
    Math.hypot(pointer.x - origin.pointer.x, pointer.y - origin.pointer.y) >= DRAG_THRESHOLD_PX
  );
}
