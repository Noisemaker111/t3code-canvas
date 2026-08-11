import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditorProvider,
  isShapeId,
  useEditor,
  useValue,
  Vec,
  type Editor,
  type TLShapeId,
} from "tldraw";

import { CompactLayoutProvider, useCompactShell } from "./compactLayout";
import { FrameHost } from "./FrameHost";
import { frameShapes } from "./FrameShapeUtil";
import { panelDragTarget, passedDragThreshold, type PanelDragOrigin } from "./panelDrag";
import { beginSnapSession, endSnapSession, snapDragDelta, type SnapSession } from "./panelSnap";
import { PanelChrome } from "./PanelChrome";
import { PanelContent } from "./PanelContent";
import { PanelLinks } from "./PanelLinks";
import { panelLabel } from "./panelLabels";
import { usePanelTier } from "./PanelSummary";
import { panelChromeDrawn, panelLayerTier, type PanelTier } from "./panelTiers";
import {
  ColumnChromeBadge,
  ColumnChromeMenu,
  ColumnChromeSettings,
  useBoardColumnView,
} from "../../kanban/KanbanBoard";
import {
  closePanel,
  PANEL_SHAPE_TYPE,
  panelShapes,
  readOverrides,
  type T3PanelShape,
} from "./PanelShapeUtil";
import { isPanelClosable, panelCloseAction } from "./panelRegistry";
import {
  isPanelLive,
  isPanelStation,
  panelPresence,
  screenBox,
  stationKey,
  type PanelKind,
  type PanelRef,
  type StationRef,
} from "./panelStations";
import { useIsMobile } from "../../../hooks/useMediaQuery";

/**
 * Every page of the app, rendered as real DOM *outside* tldraw's container.
 *
 * The panels used to be drawn inside their shapes, which made them pages that
 * could not be used like pages: `.tl-container *` is `user-select: none`, the
 * wheel belongs to the camera, and Cmd+A / Cmd+C / Cmd+V are shape commands
 * before they are text commands. A transcript you cannot select a line of is
 * not a transcript.
 *
 * So the shape keeps the geometry — where a panel is, how big, which area it
 * belongs to, what a drag moves — and this layer paints the panel over it,
 * redoing the same camera transform tldraw applies to its own shape layer
 * ({@link screenBox}). Outside the container, selection, native scrolling and
 * the clipboard are just the browser's again.
 *
 * Focus is the other half: a focused station is not a camera position any more,
 * it is this layer drawing that one panel at window size over everything else.
 */

/** Above tldraw's shapes, below its UI (`.tlui-layout` sits at 300). */
const PANEL_Z = 200;

/** A focused panel is the page you are on: over the toolbar, over everything. */
const FOCUSED_Z = 400;

const MAX_ZOOM_STEP = 10;

/** A focused panel fills the window, so it is always past every tier threshold. */
const FOCUSED_SCREEN = { w: 100_000, h: 100_000 } as const;

/** tldraw's own `normalizeWheel`, which its public entry point does not export. */
function wheelDelta(event: WheelEvent) {
  const step =
    Math.abs(event.deltaY) > MAX_ZOOM_STEP ? MAX_ZOOM_STEP * Math.sign(event.deltaY) : event.deltaY;
  return { x: -event.deltaX, y: -event.deltaY, z: -step / 100 };
}

interface PanelEntry {
  readonly id: TLShapeId;
  readonly kind: PanelKind;
  readonly entityId: string;
  /** The panel's typed name. Empty means it is named by its kind. */
  readonly title: string;
}

/** The ids back out of a space-joined `useValue` key. */
function splitShapeIds(key: string): ReadonlyArray<TLShapeId> {
  return key.length === 0 ? [] : key.split(" ").filter(isShapeId);
}

export function PanelLayer({
  editor,
  station,
}: {
  readonly editor: Editor | null;
  readonly station: StationRef | null;
}) {
  if (editor === null) return null;
  return (
    <EditorProvider editor={editor}>
      <PanelLayerInner station={station} />
    </EditorProvider>
  );
}

function PanelLayerInner({ station }: { readonly station: StationRef | null }) {
  const editor = useEditor();
  const [hovering, setHovering] = useState(0);
  const [focusWithin, setFocusWithin] = useState(false);

  // Serialized, because the reactive read touches every shape on the page and
  // so recomputes on every stroke of a drawing. A string React can compare is
  // what keeps that from re-rendering ten live panels sixty times a second.
  const serialized = useValue(
    "panel entries",
    () =>
      JSON.stringify(
        [...panelShapes(editor).values()].map((entry) => ({
          id: entry.id,
          kind: entry.ref.kind,
          entityId: entry.ref.entityId,
          title: entry.title,
        })),
      ),
    [editor],
  );
  const entries = useMemo(() => JSON.parse(serialized) as ReadonlyArray<PanelEntry>, [serialized]);

  // Frames are read the same way and for the same reason: the ids alone, as a
  // string, so a stroke of a drawing does not re-render every frame's border.
  // The array is split back out of the key rather than read from the store a
  // second time: a render-phase read outside `useValue` can see a stale page —
  // empty, on the load races — and a memo seeded from one stays empty for good.
  const frameKey = useValue(
    "frame ids",
    () =>
      frameShapes(editor)
        .map((shape) => shape.id)
        .join(" "),
    [editor],
  );
  const frames = useMemo(() => splitShapeIds(frameKey), [frameKey]);

  /**
   * Hand the keyboard, the wheel and the clipboard back to the browser while a
   * panel has them. Every one of tldraw's document-level handlers bails on
   * `isFocused`, so this one flag is the difference between Cmd+A selecting the
   * text you are reading and Cmd+A selecting every shape on the canvas.
   */
  const suspended = station !== null || hovering > 0 || focusWithin;
  useEffect(() => {
    editor.updateInstanceState({ isFocused: !suspended });
    return () => {
      editor.updateInstanceState({ isFocused: true });
    };
  }, [editor, suspended]);

  const onHoverChange = useCallback((inside: boolean) => {
    setHovering((count) => Math.max(0, count + (inside ? 1 : -1)));
  }, []);

  /**
   * Ctrl/Cmd wheel is canvas zoom, everywhere, always. Panels sit outside
   * tldraw's container, and tldraw's own wheel handler bails whenever this
   * layer clears `isFocused` — so anywhere but the raw, focused canvas the
   * browser's page zoom used to win. One window-level capture listener cancels
   * the browser first and drives the camera through `dispatch`, the one door
   * that does not read focus. Capture also runs before tldraw's container
   * handler, and `stopPropagation` keeps the two from zooming twice.
   */
  // A frame station is a camera move onto a region of the canvas, not a page
  // drawn over it: the panels standing in that frame are exactly what you are
  // meant to be looking at, so they stay live.
  const stationed = station !== null && station.kind !== "frame";
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (stationed) return;
      editor.dispatch({
        type: "wheel",
        name: "wheel",
        delta: wheelDelta(event),
        point: new Vec(event.clientX, event.clientY),
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: true,
        metaKey: event.metaKey,
        accelKey: true,
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [editor, stationed]);

  return (
    <div
      // `clip`, not `hidden`: the panels parked off-screen make this box four
      // thousand pixels wide, and a scroll container that wide gets scrolled —
      // by the browser, on the first focus() that wants an element in view.
      // Everything inside then sits a few hundred pixels left of where the
      // camera put it, including the focused panel that means to fill the
      // window. `clip` cuts the overflow without ever being scrollable.
      className="absolute inset-0 overflow-clip"
      style={{ pointerEvents: "none" }}
      data-testid="canvas-panel-layer"
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusWithin(false);
      }}
    >
      {/* Hidden behind a focused station: that panel is the window, and a link
          to something it is covering is a line to nowhere. */}
      <PanelLinks hidden={stationed} />
      {frames.map((frameId) => (
        <FrameHost
          key={frameId}
          frameId={frameId}
          stationed={stationed}
          onHoverChange={onHoverChange}
        />
      ))}
      {entries.map((entry) => (
        <PanelHost
          key={entry.id}
          entry={entry}
          focused={isPanelStation(station, { kind: entry.kind, entityId: entry.entityId })}
          stationed={stationed}
          onHoverChange={onHoverChange}
        />
      ))}
      {station !== null &&
      station.kind !== "frame" &&
      !entries.some((entry) =>
        isPanelStation(station, { kind: entry.kind, entityId: entry.entityId }),
      ) ? (
        <FocusedStationOverlay kind={station.kind} entityId={station.entityId} />
      ) : null}
    </div>
  );
}

/**
 * A focused station with no free panel behind it — a page whose only home is a
 * frame, opened as the page itself. The phone's board columns are the case:
 * the columns live inside the Board frame, and a 390px screen wants one of
 * them full-window, not the whole frame. No shape means no drag and no close —
 * the frame still owns the panel; this is just the window.
 */
function FocusedStationOverlay({
  kind,
  entityId,
}: {
  readonly kind: PanelKind;
  readonly entityId: string;
}) {
  const navigate = useNavigate();
  const narrow = useIsMobile();
  const compactShell = useCompactShell();
  // No shape to read a typed name off, so a column takes its name from the
  // board's own list — which is where the panel that is missing would have
  // been read from anyway.
  const column = useBoardColumnView(entityId);
  const leave = useCallback(() => {
    void navigate({ to: "/kanban", search: {}, replace: true });
  }, [navigate]);
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: FOCUSED_Z, pointerEvents: "auto" }}>
      <PanelChrome
        label={kind === "column" ? column.title : panelLabel(kind, entityId)}
        live
        focused
        chromeless={compactShell}
        centerLabel={kind === "column"}
        badge={kind === "column" ? <ColumnChromeBadge column={entityId} /> : undefined}
        settings={
          kind === "column" ? <ColumnChromeSettings column={entityId} focused /> : undefined
        }
        menu={kind === "column" ? <ColumnChromeMenu column={entityId} /> : undefined}
        onToggleFocus={leave}
        onHeaderDoubleClick={leave}
        testId={`canvas-panel-${stationKey({ kind, entityId })}`}
      >
        <CompactLayoutProvider compact={narrow}>
          <PanelContent
            kind={kind}
            entityId={entityId}
            live
            tier="live"
            overrides=""
            onOverridesChange={noopOverrides}
          />
        </CompactLayoutProvider>
      </PanelChrome>
    </div>
  );
}

function noopOverrides() {}

function PanelHost({
  entry,
  focused,
  stationed,
  onHoverChange,
}: {
  readonly entry: PanelEntry;
  readonly focused: boolean;
  /** Whether any panel is focused — the rest are behind it, so they go quiet. */
  readonly stationed: boolean;
  readonly onHoverChange: (inside: boolean) => void;
}) {
  const editor = useEditor();
  const navigate = useNavigate();
  const narrow = useIsMobile();
  const compactShell = useCompactShell();
  // Stable: the drag effect depends on it, and a fresh object every camera
  // frame would tear the listeners down and back up mid-drag.
  const ref: PanelRef = useMemo(
    () => ({ kind: entry.kind, entityId: entry.entityId }),
    [entry.kind, entry.entityId],
  );

  const shape = useValue(
    "panel shape",
    () => editor.getShape(entry.id) as T3PanelShape | undefined,
    [editor, entry.id],
  );
  const placement = useValue(
    "panel placement",
    () => {
      const bounds = editor.getShapePageBounds(entry.id);
      if (!bounds) return null;
      const camera = editor.getCamera();
      const viewport = editor.getViewportPageBounds();
      return {
        screen: screenBox({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }, camera),
        zoom: camera.z,
        presence: panelPresence(
          { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
          { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
        ),
      };
    },
    [editor, entry.id],
  );
  const toolId = useValue("tool", () => editor.getCurrentToolId(), [editor]);

  // Free terminal/browser panels only go live when focused (or their station).
  // Size-based live for them dual-mounted xterms next to a thread that already
  // has a drawer, and blanked both sessions. Summary still shows cwd/status.
  const heavyFree =
    (entry.kind === "terminal" || entry.kind === "browser") && !focused && !stationed;
  const live =
    focused ||
    (!stationed &&
      !heavyFree &&
      placement !== null &&
      isPanelLive({ presence: placement.presence, isEditing: false, toolId }));

  // A focused panel is the window, so it is drawn at window size whatever the
  // camera says. Everything else picks its tier from the pixels it covers —
  // except when another station is the window: then free panels demote off
  // live so a second terminal does not keep an xterm mounted behind it.
  const sizeTier = usePanelTier(
    entry.kind,
    focused || placement === null ? FOCUSED_SCREEN : placement.screen,
  );
  const renderTier: PanelTier = panelLayerTier({ live, stationed, sizeTier });

  // Unhover has to fire on the way out of focus too: the pointer never leaves a
  // panel that stops existing under it, and a stuck count would leave the wheel
  // suspended over the open canvas.
  const hoveringRef = useRef(false);
  const setHovering = useCallback(
    (inside: boolean) => {
      if (hoveringRef.current === inside) return;
      hoveringRef.current = inside;
      onHoverChange(inside);
    },
    [onHoverChange],
  );
  useEffect(() => {
    if (!live) setHovering(false);
  }, [live, setHovering]);
  useEffect(() => () => setHovering(false), [setHovering]);

  const goTo = useCallback(
    (next: string | null) => {
      void navigate({
        to: "/kanban",
        search: next === null ? {} : { station: next },
        replace: true,
      });
    },
    [navigate],
  );

  const drag = usePanelDrag(entry.id, focused);

  const closable = isPanelClosable(entry.kind);
  const onClose = useCallback(() => {
    // Leaving focus first: closing the page you are looking at must not leave
    // the camera locked on a station with no panel under it.
    if (focused) goTo(null);
    closePanel(editor, entry.id);
  }, [editor, entry.id, focused, goTo]);

  if (shape === undefined || placement === null) return null;

  // Hidden rather than unmounted when it is off screen: a panel that rebuilt
  // every time you panned past it would drop the transcript, the terminals and
  // the half-typed message with it. `visibility` costs nothing to paint and
  // keeps the page running behind you.
  const style: React.CSSProperties = focused
    ? { position: "absolute", inset: 0, zIndex: FOCUSED_Z, pointerEvents: "auto" }
    : {
        position: "absolute",
        left: 0,
        top: 0,
        width: shape.props.w,
        height: shape.props.h,
        transform: `translate(${placement.screen.x}px, ${placement.screen.y}px) scale(${placement.zoom})`,
        transformOrigin: "0 0",
        zIndex: PANEL_Z,
        pointerEvents: live ? "auto" : "none",
        // Hidden at the placeholder tier as well as off screen: the box the
        // shape draws under this layer *is* the placeholder, so drawing a second
        // one over it is two of the same rectangle.
        visibility:
          stationed || placement.presence <= 0 || !panelChromeDrawn(renderTier)
            ? "hidden"
            : "visible",
      };

  return (
    <div
      style={style}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <PanelChrome
        label={panelLabel(entry.kind, entry.entityId, entry.title)}
        live={live}
        focused={focused}
        // A phone's page already wears the app header, which names it and is how
        // you leave it. A second title bar under the first is a row of a small
        // screen spent saying the same thing twice.
        chromeless={compactShell && focused}
        centerLabel={entry.kind === "column"}
        badge={entry.kind === "column" ? <ColumnChromeBadge column={entry.entityId} /> : undefined}
        settings={
          entry.kind === "column" ? (
            <ColumnChromeSettings column={entry.entityId} focused={focused} />
          ) : undefined
        }
        menu={entry.kind === "column" ? <ColumnChromeMenu column={entry.entityId} /> : undefined}
        dragging={drag.dragging}
        onClose={closable ? onClose : undefined}
        closeHint={
          closable && panelCloseAction(entry.kind) === "detach"
            ? "the session keeps running"
            : undefined
        }
        // One rule for every title bar on the canvas, a frame's included: press
        // and drag moves it, a click selects it, a double-click goes to it, and
        // the same gesture backs out of whatever it went to.
        onToggleFocus={focused ? () => goTo(null) : () => goTo(stationKey(ref))}
        onHeaderPointerDown={drag.onHeaderPointerDown}
        onHeaderDoubleClick={focused ? () => goTo(null) : () => goTo(stationKey(ref))}
        testId={`canvas-panel-${stationKey(ref)}`}
      >
        {/* Compact when this panel *is* the phone screen. A panel parked on the
            canvas keeps its authored width whatever it is scaled onto, so the
            device alone would put a one-column board inside a 1480px box. */}
        <CompactLayoutProvider compact={narrow && focused}>
          <PanelBody
            shapeId={entry.id}
            kind={entry.kind}
            entityId={entry.entityId}
            live={live}
            tier={renderTier}
            overrides={readOverrides(shape)}
          />
        </CompactLayoutProvider>
      </PanelChrome>
    </div>
  );
}

/**
 * Move a panel by its title bar, the way a window moves.
 *
 * The bar is DOM outside tldraw's transform, so the drag never reaches the
 * select tool: the pointer is captured here and the shape is moved directly,
 * converting screen pixels to page units at the camera's zoom
 * ({@link panelDragTarget}). One history mark per drag, so undo puts a panel
 * back where it was in one step rather than frame by frame.
 */
function usePanelDrag(shapeId: TLShapeId, focused: boolean) {
  const editor = useEditor();
  const [dragging, setDragging] = useState(false);
  const teardown = useRef<(() => void) | null>(null);
  useEffect(() => () => teardown.current?.(), []);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (focused) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const shape = editor.getShape(shapeId);
      if (shape === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      // Capture so the drag survives the pointer leaving the bar — panels are
      // small on a zoomed-out canvas and the pointer outruns them.
      event.currentTarget.setPointerCapture(event.pointerId);
      // A panel you are moving belongs on top of the ones you are moving it past.
      editor.bringToFront([shapeId]);
      const origin: PanelDragOrigin = {
        pointer: { x: event.clientX, y: event.clientY },
        shape: { x: shape.x, y: shape.y },
        zoom: editor.getCamera().z,
      };
      let moved = false;
      let snap: SnapSession | null = null;
      // A drag that starts on the bar and travels over live panels otherwise
      // selects every line it passes: the body of a live panel is `select-text`,
      // and preventDefault on pointerdown does not reach the selection.
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onMove = (move: PointerEvent) => {
        const pointer = { x: move.clientX, y: move.clientY };
        if (!moved) {
          if (!passedDragThreshold(origin, pointer)) return;
          moved = true;
          editor.markHistoryStoppingPoint("drag panel");
          // Selecting is what tells tldraw which shapes are moving, so it only
          // happens once this is a move — a press on the bar stays a press.
          snap = beginSnapSession(editor, [shapeId]);
        }
        const next = panelDragTarget(origin, pointer);
        const delta =
          snap === null
            ? { x: next.x - origin.shape.x, y: next.y - origin.shape.y }
            : snapDragDelta(
                editor,
                snap,
                { x: next.x - origin.shape.x, y: next.y - origin.shape.y },
                move.ctrlKey || move.metaKey,
              );
        editor.updateShape({
          id: shapeId,
          type: PANEL_SHAPE_TYPE,
          x: origin.shape.x + delta.x,
          y: origin.shape.y + delta.y,
        });
      };
      // A panel dropped inside a frame is simply standing in it: membership is
      // geometric, read at the moment the frame moves, so there is nothing to
      // record on release.
      const onUp = () => {
        // A press that never travelled is a click, and a click selects: the
        // next gesture — resize, nudge, delete — needs something to act on.
        // pointerdown calls preventDefault to keep the drag off the text under
        // it, which eats the click event, so this is where the two are told
        // apart.
        if (!moved) editor.setSelectedShapes([shapeId]);
        stop();
      };
      const stop = () => {
        teardown.current = null;
        document.body.style.userSelect = previousUserSelect;
        endSnapSession(editor);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(false);
      };

      // Subscribed here rather than from an effect on `dragging`: a click fast
      // enough to release before React commits would never be heard, and the
      // panel would stay stuck to the pointer.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      teardown.current = stop;
      setDragging(true);
    },
    [editor, focused, shapeId],
  );

  return { dragging, onHeaderPointerDown };
}

/**
 * Memoized on scalars only. The wrapper above re-renders on every camera frame
 * and on every drag of the shape; a transcript must not.
 */
const PanelBody = memo(function PanelBody({
  shapeId,
  kind,
  entityId,
  live,
  tier,
  overrides,
}: {
  readonly shapeId: TLShapeId;
  readonly kind: PanelKind;
  readonly entityId: string;
  readonly live: boolean;
  readonly tier: PanelTier;
  readonly overrides: string;
}) {
  const editor = useEditor();
  const onOverridesChange = useCallback(
    (next: string) => {
      const shape = editor.getShape(shapeId) as T3PanelShape | undefined;
      if (shape === undefined) return;
      editor.updateShape({
        id: shapeId,
        type: PANEL_SHAPE_TYPE,
        meta: { ...shape.meta, overrides: next },
      });
    },
    [editor, shapeId],
  );
  return (
    <PanelContent
      kind={kind}
      entityId={entityId}
      live={live}
      tier={tier}
      overrides={overrides}
      onOverridesChange={onOverridesChange}
    />
  );
});
