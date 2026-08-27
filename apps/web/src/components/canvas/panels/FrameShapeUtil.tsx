import {
  BaseBoxShapeUtil,
  type BoundsSnapGeometry,
  createShapeId,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  HTMLContainer,
  isShapeId,
  type Editor,
  type RecordProps,
  resizeBox,
  T,
  type TLBaseShape,
  type TLResizeInfo,
  type TLShape,
  type TLShapeId,
} from "tldraw";

import {
  FRAME_MIN_SIZE,
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  FRAME_PRESET_IDS,
  anchoredByLockedFrames,
  frameAround,
  frameChildMoves,
  frameContentBox,
  frameMembers,
  framePreset,
  framesToSendBack,
  legacyFrameStations,
  staleEmptyGalleryFrameIds,
  type FrameCandidate,
  type FramePresetId,
} from "./panelFrames";
import { PANEL_KINDS, type PanelKind, type PanelSize } from "./panelRegistry";
import { PANEL_SHAPE_TYPE, occupiedPanelBoxes, panelShapes } from "./PanelShapeUtil";
import { frameSnapPoints } from "./panelSnapGeometry";
import {
  clearOfPanels,
  nextPanelSlot,
  panelIdentity,
  panelPlacement,
  unionBoxes,
  type Box,
  type PanelRef,
  type StationRef,
} from "./panelStations";

/**
 * A frame — the bordered region of the canvas — as a shape.
 *
 * Like {@link PanelShapeUtil} this owns geometry and the record, not pixels:
 * `FrameHost` paints the title bar outside tldraw's container. A frame holds no
 * panels of its own; what is "in" it is whatever stands inside its bounds, plus
 * whatever has been locked in by hand — so the shape is a box, a name, a preset
 * and that list.
 *
 * {@link registerFrameMoves} is the one place a frame's move carries what it
 * holds, so every way of moving a frame moves the composition with it.
 */

/**
 * The docking props a frame used to carry: which panels were parked in which
 * slot, and the query a tiled main slot was bound to. Frames hold no panels any
 * more, but a saved canvas still names its docked pages here and dropping them
 * in a migration would delete pages nobody closed. They stay in the schema,
 * unread by everything but {@link unpackLegacyFrames}, which puts each page
 * back on the canvas as its own panel and blanks them.
 */
export interface T3FrameLegacyProps {
  query: string;
  columns: number;
  rows: number;
  slots: Array<{
    slot: string;
    mode: string;
    size: number;
    activeIndex: number;
    panels: Array<{ kind: PanelKind; entityId: string }>;
  }>;
}

export interface T3FrameProps extends T3FrameLegacyProps {
  w: number;
  h: number;
  preset: FramePresetId;
  /** The frame's own name. Empty means "call it by its preset". */
  title: string;
  /**
   * The shapes locked into this frame: ids that travel with it wherever they
   * stand. Empty is the ordinary case — a frame carries what stands in it by
   * geometry, and this is the override a human sets from the cog.
   */
  members: Array<string>;
}

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "t3-frame": T3FrameProps;
  }
}

export type T3FrameShape = TLBaseShape<"t3-frame", T3FrameProps>;

export const FRAME_SHAPE_TYPE = "t3-frame";

const frameVersions = createShapePropsMigrationIds(FRAME_SHAPE_TYPE, {
  AddTitle: 1,
  DropTilingPresets: 2,
  AddMembers: 3,
});

/** Presets a saved frame may still name. Docking and tiling took theirs with them. */
const LEGACY_PRESETS: Record<string, FramePresetId> = {
  "active-threads": "custom",
  "open-files": "custom",
  ide: "custom",
};

export class FrameShapeUtil extends BaseBoxShapeUtil<T3FrameShape> {
  static override type = "t3-frame" as const;

  static override props: RecordProps<T3FrameShape> = {
    w: T.number,
    h: T.number,
    preset: T.literalEnum(...FRAME_PRESET_IDS),
    title: T.string,
    members: T.arrayOf(T.string),
    query: T.string,
    columns: T.number,
    rows: T.number,
    slots: T.arrayOf(
      T.object({
        slot: T.string,
        mode: T.string,
        size: T.number,
        activeIndex: T.number,
        panels: T.arrayOf(T.object({ kind: T.string, entityId: T.string })),
      }),
    ),
  };

  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      {
        id: frameVersions.AddTitle,
        up: (props) => {
          props["title"] = "";
        },
      },
      // The tiling presets were a bound grid each. Without one they are a
      // rectangle like any other, so a saved frame keeps its box under the
      // name every hand-drawn frame has.
      {
        id: frameVersions.DropTilingPresets,
        up: (props) => {
          const preset = props["preset"];
          if (typeof preset === "string" && preset in LEGACY_PRESETS)
            props["preset"] = LEGACY_PRESETS[preset];
        },
      },
      // A saved frame carried whatever stood in it and nothing else. Empty is
      // exactly that: geometry keeps deciding until a human locks something in.
      {
        id: frameVersions.AddMembers,
        up: (props) => {
          props["members"] = [];
        },
      },
    ],
  });

  override getDefaultProps(): T3FrameShape["props"] {
    return frameProps("custom");
  }

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

  override onResize(shape: T3FrameShape, info: TLResizeInfo<T3FrameShape>) {
    return resizeBox(shape, info, { minWidth: FRAME_MIN_SIZE.w, minHeight: FRAME_MIN_SIZE.h });
  }

  /**
   * The frame's border, and the box the panels standing in it occupy. Lining
   * something up with a frame means lining it up with what stands in it.
   */
  override getBoundsSnapGeometry(shape: T3FrameShape): BoundsSnapGeometry {
    return {
      points: [
        ...frameSnapPoints({
          w: shape.props.w,
          h: shape.props.h,
          headerHeight: FRAME_HEADER_HEIGHT,
          padding: FRAME_PADDING,
        }),
      ],
    };
  }

  override getIndicatorPath(shape: T3FrameShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override component(shape: T3FrameShape) {
    return (
      <HTMLContainer id={shape.id}>
        <div
          className="size-full rounded-2xl border border-border/80 bg-muted/30"
          style={{ width: shape.props.w, height: shape.props.h }}
        />
      </HTMLContainer>
    );
  }
}

/** The props a fresh frame of a preset is created with. */
export function frameProps(preset: FramePresetId): T3FrameProps {
  return { ...framePreset(preset).size, preset, title: "", members: [], ...NO_LEGACY };
}

const NO_LEGACY: T3FrameLegacyProps = { query: "none", columns: 1, rows: 1, slots: [] };

/**
 * Put every docked page back on the canvas as a panel of its own.
 *
 * A frame used to swallow the panels dropped on it — the shape went away and
 * the frame drew the page inside a slot, stretched to whatever the slot was.
 * Frames are borders now, so each held page is created again at its authored
 * size in the place the canvas gives that kind, and the frame is deleted: the
 * wrap passes redraw one around the kanban and the seeded pages on the same
 * load, so what a human sees is the same screens without the stretching.
 *
 * Returns whether it changed anything, so the caller can skip the passes that
 * would otherwise run against a half-unpacked canvas.
 */
export function unpackLegacyFrames(editor: Editor): boolean {
  const legacy = frameShapes(editor).filter((shape) => legacyFrameStations(shape.props).length > 0);
  if (legacy.length === 0) return false;
  const existing = [...panelShapes(editor).values()].map((entry) => entry.ref);
  const held = new Map<string, PanelRef>();
  for (const shape of legacy) {
    for (const ref of legacyFrameStations(shape.props)) held.set(panelIdentity(ref), ref);
  }
  for (const ref of existing) held.delete(panelIdentity(ref));

  const placed = [...existing];
  editor.markHistoryStoppingPoint("unpack frames");
  editor.run(
    () => {
      for (const ref of held.values()) {
        // The slot counts refs, not the panels already standing at those
        // addresses, so an unpacked page has to be nudged off whatever the
        // human left in its lane.
        const placement = clearOfPanels(
          panelPlacement(ref, nextPanelSlot(ref.kind, placed)),
          occupiedPanelBoxes(editor),
        );
        placed.push(ref);
        editor.createShapes([
          {
            id: createShapeId(),
            type: PANEL_SHAPE_TYPE,
            x: placement.x,
            y: placement.y,
            props: {
              w: placement.w,
              h: placement.h,
              kind: ref.kind,
              entityId: ref.entityId,
              title: "",
            },
          },
        ]);
      }
      editor.deleteShapes(legacy.map((shape) => shape.id));
    },
    { ignoreShapeLock: true },
  );
  return true;
}

/**
 * Drop empty "Dev gallery" frames left after the gallery panel kind was reaped.
 * Returns whether any shape was removed.
 */
export function reapEmptyGalleryFrames(editor: Editor): boolean {
  const ids = staleEmptyGalleryFrameIds(
    frameShapes(editor).map((shape) => ({
      id: shape.id,
      title: shape.props.title,
      childCount: frameChildShapes(editor, shape.id).length,
    })),
  );
  if (ids.length === 0) return false;
  editor.markHistoryStoppingPoint("reap empty gallery frames");
  editor.run(() => editor.deleteShapes([...ids]), { ignoreShapeLock: true });
  return true;
}

/** Every frame on the page, topmost last — tldraw's own paint order. */
export function frameShapes(editor: Editor): ReadonlyArray<T3FrameShape> {
  const found: Array<T3FrameShape> = [];
  for (const id of editor.getCurrentPageShapeIds()) {
    const shape = editor.getShape(id);
    if (shape?.type === FRAME_SHAPE_TYPE) found.push(shape as T3FrameShape);
  }
  return found;
}

/** Put every frame behind what it is drawn around — {@link framesToSendBack}. */
function sendFramesToBack(editor: Editor): void {
  const ids = framesToSendBack(
    editor.getCurrentPageShapesSorted().map((shape) => ({
      id: shape.id,
      isFrame: shape.type === FRAME_SHAPE_TYPE,
    })),
  );
  if (ids.length === 0) return;
  // A locked frame is still a border: the lock is about geometry, and leaving
  // it painted over the pages standing in it would make them unclickable.
  editor.run(() => editor.sendToBack([...ids]), { ignoreShapeLock: true });
}

/**
 * Hold every frame behind the pages standing in it, however the frame got
 * there — the Board frame the canvas draws around the kanban, a page wrap, a
 * hand-drawn one, a grouped selection, a migrated viewport.
 *
 * Repairs the order once for a canvas saved with a frame over its panels, then
 * keeps it as frames are created. Returns the disposer.
 */
export function registerFrameBackdrop(editor: Editor): () => void {
  sendFramesToBack(editor);
  return editor.sideEffects.registerAfterCreateHandler("shape", (shape) => {
    if (shape.type !== FRAME_SHAPE_TYPE) return;
    sendFramesToBack(editor);
  });
}

export function frameBox(shape: T3FrameShape): Box {
  return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h };
}

/** The frame drawn around the kanban — the Board screen, if it exists. */
export function kanbanFrame(editor: Editor): T3FrameShape | null {
  return frameShapes(editor).find((shape) => shape.props.preset === "board") ?? null;
}

/** The thread lane's border, if it is drawn. One per canvas, like the board's. */
export function threadLaneFrame(editor: Editor): T3FrameShape | null {
  return frameShapes(editor).find((shape) => shape.props.preset === "threads") ?? null;
}

/** What a frame is called wherever frames are listed. A typed name wins. */
export function frameLabel(shape: T3FrameShape): string {
  const title = shape.props.title.trim();
  return title.length > 0 ? title : framePreset(shape.props.preset).label;
}

/**
 * Rename a frame. The name is the shape's, so it rides the same snapshot.
 * Renaming a locked frame is legitimate — the lock is about geometry.
 */
export function setFrameTitle(editor: Editor, id: TLShapeId, title: string): void {
  editor.run(
    () => {
      editor.updateShape({ id, type: FRAME_SHAPE_TYPE, props: { title } });
    },
    { ignoreShapeLock: true },
  );
}

/** The screen a frame stands for: its box minus its own title bar. */
export function frameContentSize(shape: T3FrameShape): PanelSize {
  return { w: shape.props.w, h: Math.max(0, shape.props.h - FRAME_HEADER_HEIGHT) };
}

/**
 * Point a frame at another screen: the content area becomes exactly that size,
 * with the frame's own bar on top. The top-left corner stays put — the frame
 * is drawn around a composition, and resizing from the middle would slide the
 * edges off both sides of what it was drawn around.
 */
export function setFrameContentSize(editor: Editor, id: TLShapeId, size: PanelSize): void {
  editor.markHistoryStoppingPoint("resize frame");
  editor.run(
    () => {
      editor.updateShape({
        id,
        type: FRAME_SHAPE_TYPE,
        props: { w: size.w, h: size.h + FRAME_HEADER_HEIGHT },
      });
    },
    { ignoreShapeLock: true },
  );
}

/** Lock or unlock a frame — tldraw's own lock, so resize and move gate with it. */
export function setFrameLocked(editor: Editor, id: TLShapeId, locked: boolean): void {
  editor.markHistoryStoppingPoint(locked ? "lock frame" : "unlock frame");
  editor.run(
    () => {
      editor.updateShape({ id, type: FRAME_SHAPE_TYPE, isLocked: locked });
    },
    { ignoreShapeLock: true },
  );
}

export interface FrameChild {
  readonly id: TLShapeId;
  readonly type: TLShape["type"];
  /** The shape's own position — what a move writes back. */
  readonly x: number;
  readonly y: number;
}

/**
 * Every shape a frame could carry, with the frame it has been locked into.
 *
 * Frames are left out of the candidates. Two screens laid side by side is the
 * ordinary case, and a big one that had swallowed a small one would drag it
 * around whenever it moved itself.
 */
function frameCandidates(editor: Editor): ReadonlyArray<FrameCandidate<TLShapeId> & FrameChild> {
  const pinnedTo = pinnedFrames(editor);
  const candidates: Array<FrameCandidate<TLShapeId> & FrameChild> = [];
  for (const shapeId of editor.getCurrentPageShapeIds()) {
    const shape = editor.getShape(shapeId);
    if (shape === undefined || shape.type === FRAME_SHAPE_TYPE) continue;
    const page = editor.getShapePageBounds(shapeId);
    if (page === undefined) continue;
    candidates.push({
      id: shapeId,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      box: { x: page.x, y: page.y, w: page.w, h: page.h },
      pinnedTo: pinnedTo.get(shapeId) ?? null,
    });
  }
  return candidates;
}

/**
 * Which frame each locked-in shape belongs to. A shape named by two frames —
 * possible after a duplicate, never after a lock — answers with the topmost, so
 * one frame carries it rather than both fighting over it.
 */
function pinnedFrames(editor: Editor): ReadonlyMap<TLShapeId, TLShapeId> {
  const owner = new Map<TLShapeId, TLShapeId>();
  for (const frame of frameShapes(editor)) {
    for (const member of frame.props.members) {
      if (isShapeId(member) && editor.getShape(member) !== undefined) owner.set(member, frame.id);
    }
  }
  return owner;
}

/**
 * What a frame is holding right now: everything locked into it, plus everything
 * standing in it that no other frame has claimed — panels and anything drawn in
 * there, because a diagram inside the screen is part of the screen.
 */
export function frameChildShapes(editor: Editor, id: TLShapeId): ReadonlyArray<FrameChild> {
  const frame = editor.getShape(id) as T3FrameShape | undefined;
  if (frame === undefined) return [];
  return frameChildrenIn(editor, id, frameContentBox(frameBox(frame)));
}

/** {@link frameChildShapes} against a content area the frame is not standing in yet. */
function frameChildrenIn(editor: Editor, id: TLShapeId, content: Box): ReadonlyArray<FrameChild> {
  const candidates = frameCandidates(editor).filter((candidate) => candidate.id !== id);
  const members = new Set(frameMembers({ frameId: id, content, candidates }));
  return candidates.filter((candidate) => members.has(candidate.id));
}

/** The frame carrying a shape, if one is: topmost wins. */
export function frameHolding(editor: Editor, shapeId: TLShapeId): T3FrameShape | null {
  const shape = editor.getShape(shapeId);
  if (shape === undefined || shape.type === FRAME_SHAPE_TYPE) return null;
  const page = editor.getShapePageBounds(shapeId);
  if (page === undefined) return null;
  const candidate: FrameCandidate<TLShapeId> = {
    id: shapeId,
    box: { x: page.x, y: page.y, w: page.w, h: page.h },
    pinnedTo: pinnedFrames(editor).get(shapeId) ?? null,
  };
  return (
    frameShapes(editor)
      .toReversed()
      .find(
        (frame) =>
          frameMembers({
            frameId: frame.id,
            content: frameContentBox(frameBox(frame)),
            candidates: [candidate],
          }).length > 0,
      ) ?? null
  );
}

/** Whether a human has locked this frame's contents in rather than left it to geometry. */
export function frameContentsLocked(shape: T3FrameShape): boolean {
  return shape.props.members.length > 0;
}

/**
 * Lock everything the frame is holding into it, so it keeps carrying those
 * shapes wherever they are dragged to — or hand them all back to geometry.
 *
 * Locking reads the frame's current contents once. That is the point: what you
 * can see standing in the border is what gets written down, so a page that
 * overhangs the edge stops being a page the frame might drop.
 */
export function setFrameContentsLocked(editor: Editor, id: TLShapeId, locked: boolean): void {
  const members = locked ? frameChildShapes(editor, id).map((child) => child.id) : [];
  editor.markHistoryStoppingPoint(locked ? "lock frame contents" : "unlock frame contents");
  editor.run(
    () => {
      editor.updateShape({ id, type: FRAME_SHAPE_TYPE, props: { members } });
    },
    { ignoreShapeLock: true },
  );
}

/**
 * Lock these shapes into a frame, or release them from it. Releasing hands a
 * shape back to geometry — inside the border it still travels with the frame,
 * which is what leaves the frame's contents whole either way.
 */
export function setShapesLockedIntoFrame(
  editor: Editor,
  id: TLShapeId,
  shapeIds: ReadonlyArray<TLShapeId>,
  locked: boolean,
): void {
  const frame = editor.getShape(id) as T3FrameShape | undefined;
  if (frame === undefined) return;
  const changed = new Set<string>(shapeIds);
  const kept = frame.props.members.filter((member) => !changed.has(member));
  const members = locked ? [...kept, ...shapeIds] : kept;
  editor.markHistoryStoppingPoint(locked ? "lock into frame" : "release from frame");
  editor.run(
    () => {
      editor.updateShape({ id, type: FRAME_SHAPE_TYPE, props: { members } });
    },
    { ignoreShapeLock: true },
  );
}

/**
 * Draw a frame around these shapes and lock them into it — the canvas's one
 * grouping gesture. A frame is already the thing that holds a composition
 * together, so grouping is framing plus a lock, never a second container.
 *
 * Frames in the selection are skipped: a frame around a frame is a screen
 * inside a screen, and neither one can then be moved on its own.
 */
export function frameSelection(
  editor: Editor,
  shapeIds: ReadonlyArray<TLShapeId>,
): TLShapeId | null {
  const held = shapeIds.filter((shapeId) => {
    const shape = editor.getShape(shapeId);
    return shape !== undefined && shape.type !== FRAME_SHAPE_TYPE;
  });
  const union = unionBoxes(
    held
      .map((shapeId) => editor.getShapePageBounds(shapeId))
      .filter((bounds) => bounds !== undefined)
      .map((bounds) => ({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h })),
  );
  if (union === null) return null;
  const box = frameAround(union);
  const id = createShapeId();
  editor.markHistoryStoppingPoint("frame selection");
  editor.run(() => {
    editor.createShapes([
      {
        id,
        type: FRAME_SHAPE_TYPE,
        x: box.x,
        y: box.y,
        props: { ...frameProps("custom"), w: box.w, h: box.h, members: held },
      },
    ]);
  });
  return id;
}

const NOTHING_MOVING: ReadonlySet<TLShapeId> = new Set();

/** Frames whose own title bar is being dragged — {@link markFrameDragging}. */
const DRAGGING_BY_TITLE_BAR = new Set<TLShapeId>();

/**
 * Say that a frame is mid-gesture, so what it holds stays fixed until the
 * gesture ends. tldraw knows about its own drags (`inputs.isPointerDown`); the
 * title-bar drag happens on DOM painted over the canvas, so it says so here.
 */
export function markFrameDragging(id: TLShapeId, dragging: boolean): void {
  if (dragging) DRAGGING_BY_TITLE_BAR.add(id);
  else DRAGGING_BY_TITLE_BAR.delete(id);
}

/**
 * Make every frame carry its contents whenever it moves — however it was moved.
 *
 * The title-bar drag is one way a frame travels; so are tldraw's own translate,
 * the arrow keys, align and distribute. Reading the move here rather than in
 * the drag handler is what makes "everything in the frame comes with it" true
 * of all of them instead of one.
 *
 * Returns the disposer.
 */
export function registerFrameMoves(editor: Editor): () => void {
  // What each frame is carrying, held still for the length of one drag. A
  // frame re-reading its contents every pointermove would vacuum up whatever
  // it was dragged over on the way, and arrive holding somebody else's pages.
  const carrying = new Map<TLShapeId, ReadonlyArray<TLShapeId>>();
  return editor.sideEffects.registerAfterChangeHandler("shape", (prev, next, source) => {
    if (source !== "user" || next.type !== FRAME_SHAPE_TYPE) return;
    const frame = next as T3FrameShape;
    const was = prev as T3FrameShape;
    const delta = { x: frame.x - was.x, y: frame.y - was.y };
    if (delta.x === 0 && delta.y === 0) return;
    // Dragging the left or top handle moves the frame's corner and its size at
    // once. That is a resize: the border grows past what stands in it, and
    // nothing inside travels.
    if (frame.props.w !== was.props.w || frame.props.h !== was.props.h) return;
    const dragging = editor.inputs.isPointing || DRAGGING_BY_TITLE_BAR.has(frame.id);
    if (!dragging) carrying.clear();
    // Membership is read against where the frame *was*, so a page that only
    // half overlaps the border cannot slide out of the frame the moment the
    // drag it started inside of begins.
    const content = frameContentBox({ x: was.x, y: was.y, w: was.props.w, h: was.props.h });
    const held =
      (dragging ? carrying.get(frame.id) : undefined) ??
      frameChildrenIn(editor, frame.id, content).map((child) => child.id);
    if (dragging) carrying.set(frame.id, held);
    // Dragging a frame with pages selected alongside it: tldraw is already
    // moving those pages, and moving them again here would send them twice as
    // far as the frame. A title-bar drag is not tldraw's translate — it selects
    // what it moves only so the snap manager stops offering it as something to
    // line up against — so nothing else is moving those pages and this handler
    // stays the one thing that carries them.
    const selected = editor.getSelectedShapeIds();
    const alsoMoving =
      !DRAGGING_BY_TITLE_BAR.has(frame.id) && selected.includes(frame.id)
        ? new Set<TLShapeId>(selected)
        : NOTHING_MOVING;
    const children = held.flatMap((id): ReadonlyArray<FrameChild> => {
      const shape = alsoMoving.has(id) ? undefined : editor.getShape(id);
      return shape === undefined ? [] : [{ id, type: shape.type, x: shape.x, y: shape.y }];
    });
    if (children.length === 0) return;
    editor.run(
      () => {
        editor.updateShapes(
          frameChildMoves(children, delta).map((child) => ({
            id: child.id,
            type: child.type,
            x: child.x,
            y: child.y,
          })),
        );
      },
      // A frame carries what it holds even when one of those shapes is pinned
      // to the canvas on its own — the border is the thing being moved.
      { ignoreShapeLock: true },
    );
  });
}

/**
 * Hold a locked frame's screen still — the other half of
 * {@link registerFrameMoves}.
 *
 * tldraw drops a locked shape from a translate and moves the rest of the
 * selection anyway. A brush pulled across the Board frame takes the frame and
 * every column standing in it, so dragging that selection would walk the
 * columns out from under their own border and leave the border behind. A frame
 * that cannot move keeps what it holds where it is.
 *
 * Only a gesture that is moving the frame itself anchors anything: a panel
 * dragged by its own title bar selects itself alone (`beginSnapSession`), so a
 * page can still be taken out of a locked frame by hand.
 *
 * Returns the disposer.
 */
export function registerFrameAnchors(editor: Editor): () => void {
  // What each locked frame is holding, held still for the length of one drag —
  // same reason as `carrying`: re-read every pointermove, the anchored set
  // would drift as the shapes around it move.
  const holding = new Map<TLShapeId, ReadonlyArray<TLShapeId>>();
  return editor.sideEffects.registerBeforeChangeHandler("shape", (prev, next, source) => {
    if (source !== "user" || next.type === FRAME_SHAPE_TYPE) return next;
    if (next.x === prev.x && next.y === prev.y) return next;
    const moving = editor.getSelectedShapeIds();
    if (!moving.includes(next.id)) return next;
    if (!editor.inputs.isPointing) holding.clear();
    const lockedFrames = moving.flatMap((id) => {
      const frame = editor.getShape(id);
      if (frame === undefined || frame.type !== FRAME_SHAPE_TYPE || !frame.isLocked) return [];
      const held = holding.get(id) ?? frameChildShapes(editor, id).map((child) => child.id);
      holding.set(id, held);
      return [{ id, holding: held }];
    });
    return anchoredByLockedFrames({ moving, lockedFrames }).has(next.id)
      ? { ...next, x: prev.x, y: prev.y }
      : next;
  });
}

/**
 * The station a key lands on now. `board` is the kanban's address rather than
 * any one panel's, so it resolves to the frame drawn around the columns; every
 * other page is a panel of its own and stays one.
 */
export function resolveStationToFrame(editor: Editor, ref: StationRef): StationRef {
  if (ref.kind === "frame") return ref;
  if (ref.kind !== "board") return ref;
  if (panelShapes(editor).has(panelIdentity(ref))) return ref;
  const board = kanbanFrame(editor);
  return board === null ? ref : { kind: "frame", entityId: board.id };
}
