import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  type Editor,
  type RecordProps,
  T,
  type TLBaseShape,
} from "tldraw";

import type { Box } from "./panelStations";

/**
 * The retired viewport-region shape, kept only so old snapshots still open.
 *
 * Screens merged into frames: a frame *is* the screen now, with desktop and
 * mobile size presets and a settings cog ({@link FrameShapeUtil}). Nothing
 * creates or renders `t3-viewport` any more — {@link BoardCanvas} converts
 * every one it finds into a frame on load, and this util exists so the
 * snapshot holding them can be read at all. Delete it once no stored canvas
 * has a region left.
 */

export interface T3ViewportProps {
  w: number;
  h: number;
  title: string;
}

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "t3-viewport": T3ViewportProps;
  }
}

export type T3ViewportShape = TLBaseShape<"t3-viewport", T3ViewportProps>;

export const VIEWPORT_SHAPE_TYPE = "t3-viewport";

export class ViewportShapeUtil extends BaseBoxShapeUtil<T3ViewportShape> {
  static override type = "t3-viewport" as const;

  static override props: RecordProps<T3ViewportShape> = {
    w: T.number,
    h: T.number,
    title: T.string,
  };

  override getDefaultProps(): T3ViewportShape["props"] {
    return { w: 1920, h: 1080, title: "Screen" };
  }

  override getGeometry(shape: T3ViewportShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false });
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return false;
  }

  override canBind() {
    return false;
  }

  override hideRotateHandle() {
    return true;
  }

  override getIndicatorPath(shape: T3ViewportShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  /** Invisible: the conversion to a frame runs before anything is looked at. */
  override component(shape: T3ViewportShape) {
    return <HTMLContainer id={shape.id} />;
  }
}

/** Every leftover region on the page — what the load-time conversion drains. */
export function viewportShapes(editor: Editor): ReadonlyArray<T3ViewportShape> {
  const found: Array<T3ViewportShape> = [];
  for (const id of editor.getCurrentPageShapeIds()) {
    const shape = editor.getShape(id);
    if (shape?.type === VIEWPORT_SHAPE_TYPE) found.push(shape as T3ViewportShape);
  }
  return found;
}

export function viewportBox(shape: T3ViewportShape): Box {
  return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h };
}
