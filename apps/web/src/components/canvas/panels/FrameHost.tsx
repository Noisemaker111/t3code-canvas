import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, useValue, type TLShapeId } from "tldraw";

import { useCanvasViewStore } from "../../../canvasViewStore";
import { frameSize, frameToFit } from "./panelFrames";
import {
  frameBox,
  frameChildShapes,
  frameContentsLocked,
  frameContentSize,
  frameLabel,
  frameShapes,
  markFrameDragging,
  setFrameContentSize,
  setFrameContentsLocked,
  setFrameLocked,
  setFrameTitle,
  type T3FrameShape,
} from "./FrameShapeUtil";
import { FrameSettingsMenu } from "./FrameSettingsMenu";
import { FrameView } from "./FrameView";
import { passedDragThreshold, type PanelDragOrigin } from "./panelDrag";
import { beginSnapSession, endSnapSession, snapDragDelta, type SnapSession } from "./panelSnap";
import {
  chromeReserve,
  isPanelLive,
  panelPresence,
  screenBox,
  stationCamera,
  stationKey,
  type Box,
} from "./panelStations";

/**
 * A frame, painted over the canvas.
 *
 * A frame is a border and a bar: it renders no pages, because the pages inside
 * it are panels of their own that `PanelLayer` already draws. What lives here
 * is the editor half — where the frame is on screen, and the title-bar drag
 * that moves it and everything standing in it.
 */

export function FrameHost({
  frameId,
  stationed,
  onHoverChange,
}: {
  readonly frameId: TLShapeId;
  /** Whether a panel is focused over the canvas, so the frame goes quiet. */
  readonly stationed: boolean;
  readonly onHoverChange: (inside: boolean) => void;
}) {
  const editor = useEditor();
  const navigate = useNavigate();
  const shape = useValue(
    "frame shape",
    () => editor.getShape(frameId) as T3FrameShape | undefined,
    [editor, frameId],
  );
  const placement = useValue(
    "frame placement",
    () => {
      const bounds = editor.getShapePageBounds(frameId);
      if (!bounds) return null;
      const camera = editor.getCamera();
      const viewport = editor.getViewportPageBounds();
      const box = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
      return {
        screen: screenBox(box, camera),
        zoom: camera.z,
        presence: panelPresence(box, {
          x: viewport.x,
          y: viewport.y,
          w: viewport.w,
          h: viewport.h,
        }),
      };
    },
    [editor, frameId],
  );
  const toolId = useValue("tool", () => editor.getCurrentToolId(), [editor]);
  const contentCount = useValue("frame contents", () => frameChildShapes(editor, frameId).length, [
    editor,
    frameId,
  ]);

  const toolsHidden = useCanvasViewStore((state) => state.toolsHidden);

  // A phone cannot show 1920 units at 1:1, so the camera fits a frame when the
  // window folds to phone width rather than being panned around. Every frame's
  // host runs this, and `frameToFit` names the one frame that acts — the phone
  // one when there is one, so laying a phone screen out beside the desktop one
  // is what a phone-width window shows.
  useEffect(() => {
    const onResize = () => {
      const screen = editor.getViewportScreenBounds();
      const viewport = editor.getViewportPageBounds();
      const page: Box = { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h };
      const frames = frameShapes(editor).map((shape) => {
        const box = frameBox(shape);
        return { id: shape.id, box, presence: panelPresence(box, page) };
      });
      if (frameToFit({ screenWidth: screen.width, frames }) !== frameId) return;
      const shape = editor.getShape(frameId) as T3FrameShape | undefined;
      if (shape === undefined) return;
      editor.setCamera(
        stationCamera(
          frameBox(shape),
          { w: screen.width, h: screen.height },
          chromeReserve({ screenWidth: screen.width, toolsHidden }),
        ),
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [editor, frameId, toolsHidden]);

  const hoveringRef = useRef(false);
  const setHovering = useCallback(
    (inside: boolean) => {
      if (hoveringRef.current === inside) return;
      hoveringRef.current = inside;
      onHoverChange(inside);
    },
    [onHoverChange],
  );
  useEffect(() => () => setHovering(false), [setHovering]);

  const drag = useFrameDrag(frameId);

  if (shape === undefined || placement === null) return null;

  const live =
    !stationed && isPanelLive({ presence: placement.presence, isEditing: false, toolId });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: shape.props.w,
        height: shape.props.h,
        transform: `translate(${placement.screen.x}px, ${placement.screen.y}px) scale(${placement.zoom})`,
        transformOrigin: "0 0",
        // Under the panels (`PANEL_Z`): a frame is the border drawn around
        // them, never a sheet over the pages standing in it.
        zIndex: 190,
        pointerEvents: "none",
        visibility: stationed || placement.presence <= 0 ? "hidden" : "visible",
      }}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <FrameView
        label={frameLabel(shape)}
        size={{ w: shape.props.w, h: shape.props.h }}
        live={live}
        dragging={drag.dragging}
        locked={shape.isLocked}
        settings={
          <FrameSettingsMenu
            title={shape.props.title}
            size={frameContentSize(shape)}
            locked={shape.isLocked}
            contentCount={contentCount}
            contentsLocked={frameContentsLocked(shape)}
            onTitleChange={(next) => setFrameTitle(editor, frameId, next)}
            onSizeChange={(next) => setFrameContentSize(editor, frameId, frameSize(next).size)}
            onLockedChange={(next) => setFrameLocked(editor, frameId, next)}
            onContentsLockedChange={(next) => setFrameContentsLocked(editor, frameId, next)}
            {...(shape.isLocked ? {} : { onDelete: () => editor.deleteShapes([frameId]) })}
            testId={`canvas-frame-${shape.props.preset}`}
          />
        }
        onGoTo={() => {
          void navigate({
            to: "/kanban",
            search: { station: stationKey({ kind: "frame", entityId: frameId }) },
            replace: true,
          });
        }}
        onHeaderPointerDown={drag.onHeaderPointerDown}
        testId={`canvas-frame-${shape.props.preset}`}
      />
    </div>
  );
}

/** Where a frame's title bar has to travel before the drag counts as a move. */
function useFrameDrag(frameId: TLShapeId) {
  const editor = useEditor();
  const [dragging, setDragging] = useState(false);
  const teardown = useRef<(() => void) | null>(null);
  useEffect(() => () => teardown.current?.(), []);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const shape = editor.getShape(frameId);
      if (shape === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      // A locked frame does not travel: its bar selects the screen and stops
      // there, rather than opening a drag that can never move anything.
      if (shape.isLocked) {
        editor.setSelectedShapes([frameId]);
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      const origin: PanelDragOrigin = {
        pointer: { x: event.clientX, y: event.clientY },
        shape: { x: shape.x, y: shape.y },
        zoom: editor.getCamera().z,
      };
      // What the frame is holding is read when the drag starts and held still
      // until it ends, so a frame dragged across the canvas arrives with the
      // composition it was drawn around and nothing it passed over.
      markFrameDragging(frameId, true);
      // The frame plus what it holds: they all move, so tldraw has to leave
      // every one of them out of what it offers to snap against. The selection
      // `beginSnapSession` takes for that lasts the drag only — `onUp` hands it
      // back to the frame alone.
      const moving = [frameId, ...frameChildShapes(editor, frameId).map((child) => child.id)];
      let moved = false;
      let snap: SnapSession | null = null;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onMove = (move: PointerEvent) => {
        const pointer = { x: move.clientX, y: move.clientY };
        if (!moved) {
          if (!passedDragThreshold(origin, pointer)) return;
          moved = true;
          editor.markHistoryStoppingPoint("drag frame");
          snap = beginSnapSession(editor, moving);
        }
        const zoom = origin.zoom > 0 ? origin.zoom : 1;
        const raw = {
          x: (pointer.x - origin.pointer.x) / zoom,
          y: (pointer.y - origin.pointer.y) / zoom,
        };
        const delta =
          snap === null ? raw : snapDragDelta(editor, snap, raw, move.ctrlKey || move.metaKey);
        // Only the frame. What it is holding rides along on `registerFrameMoves`,
        // the one place a frame's move carries its contents.
        editor.updateShapes([
          {
            id: frameId,
            type: "t3-frame",
            x: origin.shape.x + delta.x,
            y: origin.shape.y + delta.y,
          },
        ]);
      };
      const onUp = () => {
        // Same as a panel's bar: the gesture leaves the frame selected, and
        // only the frame. A selection holding the pages too hands them to the
        // resize handles, and dragging one edge then scales every page inside
        // the border instead of growing the border. What the frame holds still
        // travels with it — that is `registerFrameMoves`, not the selection.
        editor.setSelectedShapes([frameId]);
        stop();
      };
      const stop = () => {
        teardown.current = null;
        markFrameDragging(frameId, false);
        document.body.style.userSelect = previousUserSelect;
        endSnapSession(editor);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(false);
      };

      // Subscribed here rather than from an effect on `dragging`: a click fast
      // enough to release before React commits would never be heard, and the
      // frame would stay stuck to the pointer.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      teardown.current = stop;
      setDragging(true);
    },
    [editor, frameId],
  );

  return { dragging, onHeaderPointerDown };
}
