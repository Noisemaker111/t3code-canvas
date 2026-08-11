import {
  BaseBoxShapeUtil,
  type BoundsSnapGeometry,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  HTMLContainer,
  type Editor,
  type RecordProps,
  resizeBox,
  T,
  type TLBaseShape,
  type TLResizeInfo,
  type TLShapeId,
} from "tldraw";

import { PanelPlaceholder } from "./PanelChrome";
import { panelSnapPoints } from "./panelSnapGeometry";
import {
  PANEL_TITLE_BAR_HEIGHT,
  PANEL_KINDS,
  PANEL_SIZE,
  panelManifest,
  panelSize,
  type PanelKind,
} from "./panelRegistry";
import type { ColumnPanelEntry } from "./boardColumns";
import { panelIdentity, type Box, type PanelRef } from "./panelStations";

/**
 * A page of the app, as a box on the canvas.
 *
 * The shape owns the geometry and nothing else: where a page sits, how big it
 * is, what a drag moves, what a snapshot saves. The pixels live in
 * `PanelLayer`, outside tldraw's container, because a page rendered inside it
 * cannot be selected, scrolled or copied out of.
 *
 * What is left here is the placeholder the layer paints over — visible only
 * when the canvas is zoomed out past the point of rendering real panels.
 */

export interface T3PanelProps {
  w: number;
  h: number;
  kind: PanelKind;
  /** Thread id for `thread`, settings section for `settings`, else empty. */
  entityId: string;
  /**
   * The panel's own name. Empty means "call it by its kind".
   *
   * A column carries its name here and nowhere else — the panel *is* the
   * column, so renaming one is editing this shape, and the name rides the
   * canvas snapshot with the box it names.
   */
  title: string;
}

// tldraw types its shape union from this map: without the augmentation a custom
// shape is not a `TLShape` and nothing in the editor API will accept it.
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "t3-panel": T3PanelProps;
  }
}

export type T3PanelShape = TLBaseShape<"t3-panel", T3PanelProps>;

export const PANEL_SHAPE_TYPE = "t3-panel";

const panelVersions = createShapePropsMigrationIds(PANEL_SHAPE_TYPE, { AddTitle: 1 });

export class PanelShapeUtil extends BaseBoxShapeUtil<T3PanelShape> {
  static override type = "t3-panel" as const;

  static override props: RecordProps<T3PanelShape> = {
    w: T.number,
    h: T.number,
    // Any kind: the registry answers at runtime, so a snapshot naming one this
    // build lacks is a plain box rather than a shape that fails validation.
    kind: T.string,
    entityId: T.string,
    title: T.string,
  };

  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      // Panels were named by their kind alone. Empty is exactly that, so a
      // saved canvas keeps every title it was already drawing.
      {
        id: panelVersions.AddTitle,
        up: (props) => {
          props["title"] = "";
        },
      },
    ],
  });

  override getDefaultProps(): T3PanelShape["props"] {
    return { ...panelSize("board"), kind: "board", entityId: "", title: "" };
  }

  /** Nothing inside the shape to edit — the page is a layer above it. */
  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override canBind() {
    return false;
  }

  override hideRotateHandle() {
    return true;
  }

  override isAspectRatioLocked() {
    return false;
  }

  /**
   * Only frames fullscreen — a bare panel no longer focuses from a
   * double-click; zooming onto it is how it goes live.
   *
   * The no-op partial is load-bearing. Without a returned change tldraw falls
   * through to "double-clicked empty canvas" and drops a text shape on top of
   * the panel.
   */
  override onDoubleClick(shape: T3PanelShape) {
    return { id: shape.id, type: shape.type };
  }

  override onResize(shape: T3PanelShape, info: TLResizeInfo<T3PanelShape>) {
    const min = panelManifest(shape.props.kind).minSize;
    return resizeBox(shape, info, { minWidth: min.w, minHeight: min.h });
  }

  /**
   * The outer box and the content box under the title bar, so panels line up
   * on where their pages start rather than only on their edges.
   */
  override getBoundsSnapGeometry(shape: T3PanelShape): BoundsSnapGeometry {
    return {
      points: [
        ...panelSnapPoints({
          w: shape.props.w,
          h: shape.props.h,
          titleBarHeight: PANEL_TITLE_BAR_HEIGHT,
        }),
      ],
    };
  }

  override getIndicatorPath(shape: T3PanelShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override component(shape: T3PanelShape) {
    return (
      <HTMLContainer id={shape.id}>
        <PanelPlaceholder width={shape.props.w} height={shape.props.h} />
      </HTMLContainer>
    );
  }
}

export interface PanelEntry {
  readonly id: TLShapeId;
  readonly ref: PanelRef;
  /** The panel's typed name, empty when it is named by its kind. */
  readonly title: string;
  /** Where it stands, so the columns can be read left to right. */
  readonly x: number;
  readonly y: number;
}

/**
 * Where every panel on the page actually stands, for a placement rule that has
 * to keep a new one off them. Page coordinates, so a panel held by a frame is
 * measured where it is drawn.
 */
export function occupiedPanelBoxes(
  editor: Editor,
  skip: TLShapeId | null = null,
): ReadonlyArray<Box> {
  const boxes: Array<Box> = [];
  for (const entry of panelShapes(editor).values()) {
    if (entry.id === skip) continue;
    const bounds = editor.getShapePageBounds(entry.id);
    if (bounds === undefined) continue;
    boxes.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
  }
  return boxes;
}

/** Every panel on the page, keyed by the station it stands for. */
export function panelShapes(editor: Editor): Map<string, PanelEntry> {
  const found = new Map<string, PanelEntry>();
  for (const id of editor.getCurrentPageShapeIds()) {
    const shape = editor.getShape(id);
    if (shape?.type !== PANEL_SHAPE_TYPE) continue;
    const panel = shape as T3PanelShape;
    const ref: PanelRef = { kind: panel.props.kind, entityId: panel.props.entityId };
    // Two tabs can both decide a panel is missing; the first id wins and the
    // duplicate is left alone rather than deleted out from under whoever is
    // looking at it.
    const key = panelIdentity(ref);
    if (!found.has(key)) {
      found.set(key, { id: panel.id, ref, title: panel.props.title, x: panel.x, y: panel.y });
    }
  }
  return found;
}

/**
 * The column panels on the page, as the board reads them: the panel *is* the
 * column, so this is where the board's column list comes from.
 */
export function columnPanelEntries(editor: Editor): ReadonlyArray<ColumnPanelEntry> {
  return [...panelShapes(editor).values()]
    .filter((entry) => entry.ref.kind === "column")
    .map((entry) => ({ entityId: entry.ref.entityId, title: entry.title, x: entry.x, y: entry.y }));
}

/** Rename a panel. A column's name is the panel's, so this is how it is set. */
export function setPanelTitle(editor: Editor, id: TLShapeId, title: string): void {
  editor.run(
    () => {
      editor.updateShape({ id, type: PANEL_SHAPE_TYPE, props: { title } });
    },
    { ignoreShapeLock: true },
  );
}

/**
 * Knob edits a dev panel is holding.
 *
 * Meta rather than props: props are schema'd and a new one needs a migration,
 * and a canvas that fails to load because a gallery grew a field is a canvas
 * somebody loses work on. Meta is free-form and rides the same snapshot save.
 */
export function readOverrides(shape: T3PanelShape): string {
  const raw = (shape.meta as { overrides?: unknown } | undefined)?.overrides;
  return typeof raw === "string" ? raw : "";
}

/**
 * Take a panel off the canvas.
 *
 * Nothing is torn down on the way out: a panel is a window, and the pty, the
 * turn or the transcript it was showing is the server's, not the window's
 * (`panelCloseAction`). Closing the last window on a session detaches from it.
 */
export function closePanel(editor: Editor, id: TLShapeId): void {
  editor.markHistoryStoppingPoint("close panel");
  editor.deleteShapes([id]);
}
