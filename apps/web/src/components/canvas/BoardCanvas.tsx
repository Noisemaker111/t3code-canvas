import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import type { CanvasInjection, CanvasInjectionSpec } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  createBindingId,
  createShapeId,
  type Editor,
  getSnapshot,
  isShapeId,
  loadSnapshot,
  Tldraw,
  type TLArrowBinding,
  type TLRecord,
  type TLShapeId,
  type TLShapePartial,
  type TLUiOverrides,
  toRichText,
  useValue,
} from "tldraw";
import "tldraw/tldraw.css";

import { useCanvasCommands, useCanvasDocument, useCanvasInjections } from "../../state/canvas";
import { useAgentBrowserSessions } from "../../state/agentBrowser";
import { useKanbanCards } from "../../state/kanban";
import { browserEntityId, isBoardBrowserSession } from "./panels/panelBrowser";
import { parseThreadTerminalRef, threadTerminalEntityId } from "./panels/panelTerminal";
import { owningThreadId } from "./panels/panelThreadScope";
import { type Bounds, layoutInjection, nextOrigin, pendingInOrder } from "./canvasLayout";
import { type CanvasSaveLoop, createCanvasSaveLoop } from "./canvasSaveLoop";
import { useCanvasViewStore } from "../../canvasViewStore";
import { usePrimarySettings, usePrimarySettingsLoaded } from "../../hooks/useSettings";
import { PanelLayer } from "./panels/PanelLayer";
import { knownTerminalIdsForMint, resolveDuplicatePanel } from "./panels/panelDuplicates";
import {
  PANEL_SHAPE_TYPE,
  PanelShapeUtil,
  columnPanelEntries,
  occupiedPanelBoxes,
  panelShapes,
  setPanelTitle,
  type T3PanelShape,
} from "./panels/PanelShapeUtil";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { HOST_CONSOLE_THREAD_ID } from "../../lib/hostConsole";
import { usePrimaryEnvironment } from "../../state/environments";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import {
  frameBox,
  frameChildShapes,
  frameHolding,
  frameShapes,
  frameProps,
  FRAME_SHAPE_TYPE,
  FrameShapeUtil,
  kanbanFrame,
  threadLaneFrame,
  registerFrameAnchors,
  registerFrameBackdrop,
  registerFrameMoves,
  unpackLegacyFrames,
  reapEmptyGalleryFrames,
  type T3FrameShape,
} from "./panels/FrameShapeUtil";
import {
  FRAME_HEADER_HEIGHT,
  FRAME_MIN_SIZE,
  appendToColumnRow,
  frameAround,
  frameContentBox,
  frameForLayout,
  isPhoneFrame,
  placeBesideInFrame,
  presetLayoutId,
} from "./panels/panelFrames";
import { frameLayout, type FrameLayoutContext } from "./panels/frameLayouts";
import { viewportBox, ViewportShapeUtil, viewportShapes } from "./panels/ViewportShapeUtil";
import { KanbanBoardProvider } from "../kanban/KanbanBoard";
import {
  licenseProps,
  readTldrawLicense,
  resolveTldrawLicenseKey,
  tldrawLicenseNotice,
} from "./tldrawLicense";
import {
  chromeReserve,
  boxesOverlap,
  clearOfPanels,
  desiredStations,
  isKanbanRegionKind,
  keptThreadPanels,
  missingStations,
  nextFreeSlot,
  nextPanelSlot,
  panelIdentity,
  panelPlacement,
  panelPlacementAt,
  panelPresence,
  satellitePlacement,
  threadLaneBox,
  seedStations,
  staleStations,
  type Box,
  type PanelRef,
  type StationRef,
  stationCamera,
  unionBoxes,
} from "./panels/panelStations";
import { useCanvasStationStore, type CanvasPoint } from "../../canvasStationStore";
import { isThreadDrag, threadIdFromDrop } from "./panels/threadDrag";
import {
  boardColumns,
  decodeColumnPanels,
  distinctColumnIds,
  encodeColumnPanels,
  SEED_COLUMN_TITLES,
} from "./panels/boardColumns";
import { panelLabel } from "./panels/panelLabels";
import { panelManifest, panelSize, type PanelKind } from "./panels/panelRegistry";
import { CanvasContextMenu } from "./panels/CanvasContextMenu";
import {
  CanvasActionsMenu,
  CanvasHelpMenu,
  CanvasMainMenu,
  CanvasNavigationPanel,
  CanvasStylePanel,
  CanvasToolbar,
} from "./CanvasUiComponents";

/**
 * The canvas the whole app lives on.
 *
 * The board is not a screen over this surface any more — it is a panel on it,
 * next to Hermes, settings and every running thread ({@link PanelShapeUtil}).
 * Drawing happens in the same space, so a diagram can sit beside the card it is
 * about, and "opening a page" is the camera moving onto a station.
 *
 * Persistence is server-side, not IndexedDB: Hermes runs in `apps/server`, and a
 * document that only exists in the browser is one it can neither read nor draw
 * on. The browser stays the only writer of tldraw records — Hermes enqueues a
 * spec and this component materializes it with the real editor API, so the
 * model never has to know tldraw's schema.
 *
 * The pages themselves are not drawn here — `PanelLayer` paints them over the
 * canvas, outside tldraw's container, so a transcript can be scrolled and
 * copied out of. Focusing a station is that layer taking the window, which is
 * also why the drawing tools go away while you are on a page.
 */

const SHAPE_UTILS = [PanelShapeUtil, FrameShapeUtil, ViewportShapeUtil];

// Icons and fonts bundled from the package instead of tldraw's CDN default:
// this box has no egress to unpkg, and an offline canvas is the whole point.
const ASSET_URLS = getAssetUrlsByImport();

// Module-level so their identity can never change: tldraw recreates the whole
// store and editor when these props change, which wipes every shape on screen.
// The Canvas* components read Settings → General themselves, so what they show
// changes live while the object handed to tldraw never does.
// The watermark is deliberately absent from this list: on a watermarked
// (hobby/free) tldraw license, suppressing it breaks the license. tldraw renders
// it inside the editor rather than the UI layer, so `hideUi` leaves it alone.
const TLDRAW_COMPONENTS = {
  DebugPanel: null,
  DebugMenu: null,
  ContextMenu: CanvasContextMenu,
  Toolbar: CanvasToolbar,
  StylePanel: CanvasStylePanel,
  NavigationPanel: CanvasNavigationPanel,
  MainMenu: CanvasMainMenu,
  ActionsMenu: CanvasActionsMenu,
  HelpMenu: CanvasHelpMenu,
};
const TLDRAW_OPTIONS = { maxPages: 1 };

// The toolbar's frame button places a t3 frame instead of arming tldraw's own
// frame tool. Two kinds of frame behind one button meant the visible one drew a
// box the app's own frames ignore. Native frames still exist.
const TLDRAW_OVERRIDES: TLUiOverrides = {
  tools(_editor, tools) {
    // A toolbar button arms a tool. tldraw 5 also lets one be dragged off the
    // bar to drop its shape where the pointer lands, and a normal click that
    // wobbles a few pixels is that drag: the tool never arms and a rectangle
    // appears under the toolbar, hidden behind it. Dropping `onDragStart`
    // leaves plain buttons; the canvas is where a shape gets placed.
    for (const [id, tool] of Object.entries(tools)) {
      if (tool.onDragStart === undefined) continue;
      const plain = { ...tool };
      delete plain.onDragStart;
      tools[id] = plain;
    }
    const frame = tools["frame"];
    if (frame !== undefined) {
      tools["frame"] = {
        ...frame,
        onSelect: () => useCanvasStationStore.getState().requestFrame("custom"),
      };
    }
    return tools;
  },
};

// The key deploy baked into this build. Settings → Board overrides it, which is
// why the editor waits for server settings before it mounts: `licenseKey`
// changing after mount recreates the store, and the canvas must not be handed a
// key twice on load.
const BUILD_LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY;

const NODE_SHAPE_GEO = {
  rectangle: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
} as const;

/**
 * What a button just dropped on the canvas is what you are about to move, so it
 * comes out selected — and under the select tool, which is the only one that
 * shows the handles. A toolbar click that arms nothing and selects nothing
 * looks like it did nothing.
 */
/** Nothing to adopt: an empty frame gathers no pages into itself. */
const EMPTY_ADOPTION: ReadonlySet<TLShapeId> = new Set<TLShapeId>();

function selectPlaced(editor: Editor, id: TLShapeId): void {
  editor.setCurrentTool("select");
  editor.setSelectedShapes([id]);
}

function pageBounds(editor: Editor): Bounds | null {
  const ids = editor.getCurrentPageShapeIds();
  if (ids.size === 0) return null;
  const bounds = editor.getCurrentPageBounds();
  if (!bounds) return null;
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

/** Where the kanban is: the Board frame, or the bare region if none is drawn. */
function kanbanBounds(editor: Editor): Bounds | null {
  const frame = kanbanFrame(editor);
  if (frame !== null) return frameBox(frame);
  return kanbanRegionBounds(editor);
}

/**
 * Where a panel opened from another one goes, when that one is standing in a
 * frame: beside it, inside the same border. Null when it is not in a frame, or
 * the frame has no room — the caller then uses the panel's own address.
 */
function placeNearPanel(editor: Editor, near: PanelRef, kind: PanelKind): Box | null {
  const source = panelShapes(editor).get(panelIdentity(near));
  if (source === undefined) return null;
  const frame = frameHolding(editor, source.id);
  if (frame === null) return null;
  const bounds = editor.getShapePageBounds(source.id);
  if (bounds === undefined) return null;
  const manifest = panelManifest(kind);
  return placeBesideInFrame({
    content: frameContentBox(frameBox(frame)),
    source: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    size: manifest.size,
    minSize: manifest.minSize,
  });
}

/**
 * Where a panel that queues up in a row goes: the first place in that row with
 * nothing standing in it.
 *
 * The slot a caller hands over is a count — of the desired panels of a kind, or
 * of the panels already out. Neither says whether that place is free, so a
 * thread dragged off the row left its slot empty and still pushed the next
 * thread onto whatever had taken it. Reading the page keeps the row packed in
 * order, which is the whole point of a row: the next one appears where you are
 * already looking for it.
 */
function rowPlacement(editor: Editor, ref: StationRef, slot: number): Box {
  const wanted = panelPlacement(ref, slot);
  const occupied = occupiedPanelBoxes(editor);
  if (!occupied.some((box) => boxesOverlap(wanted, box))) return wanted;
  return panelPlacement(ref, nextFreeSlot(ref, occupied));
}

/**
 * Where a panel a thread opened goes: the first free place in the row under
 * that thread's panel. Null when the ref is not a thread's — then the kind's
 * own row in the placement table is the right address.
 *
 * Read off the thread's live box, so a thread dragged off its lane grows its
 * terminals and browser tabs wherever it now stands.
 */
function satelliteRowPlacement(editor: Editor, ref: PanelRef): Box | null {
  const threadId = owningThreadId(ref.entityId);
  if (threadId === null) return null;
  const thread = panelShapes(editor).get(panelIdentity({ kind: "thread", entityId: threadId }));
  if (thread === undefined) return null;
  const bounds = editor.getShapePageBounds(thread.id);
  if (bounds === undefined) return null;
  const box = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  const occupied = occupiedPanelBoxes(editor);
  for (let slot = 0; slot < MAX_SATELLITE_SLOTS; slot += 1) {
    const place = satellitePlacement(box, ref.kind, slot);
    if (!occupied.some((other) => boxesOverlap(place, other))) return place;
  }
  return null;
}

/** How far along the row under a thread the search for an empty place walks. */
const MAX_SATELLITE_SLOTS = 12;

/** The topmost frame whose content area holds this page point, if one does. */
function frameAtPoint(editor: Editor, at: CanvasPoint): T3FrameShape | null {
  return (
    frameShapes(editor)
      .toReversed()
      .find((frame) => {
        const content = frameContentBox(frameBox(frame));
        return (
          at.x >= content.x &&
          at.x <= content.x + content.w &&
          at.y >= content.y &&
          at.y <= content.y + content.h
        );
      }) ?? null
  );
}

/**
 * The name a panel the canvas mints for itself is created with.
 *
 * Only the shipped columns have one, and only the first time each is created:
 * `pr` reads "PR", which no rule can derive from an id. Everything after that
 * is the panel's own — rename one and this is never consulted again, because it
 * only ever answers for a panel that does not exist yet.
 */
function seedPanelTitle(ref: StationRef): string {
  return ref.kind === "column" ? (SEED_COLUMN_TITLES[ref.entityId] ?? "") : "";
}

/**
 * Done shipped titled "Archived", so the column a merged card lands in read as
 * the place to park anything you were finished with — and a card parked there
 * is one Hermes counts as shipped, which is how a fresh prompt for the same
 * work gets dropped as a duplicate. Archiving is the drop target and the card's
 * own Archive button; this renames the column back to what it does. A board
 * that titled it something else is left alone.
 */
function renameArchivedDoneColumn(editor: Editor): void {
  const panel = panelShapes(editor).get(panelIdentity({ kind: "column", entityId: "done" }));
  if (panel === undefined || panel.title !== "Archived") return;
  setPanelTitle(editor, panel.id, SEED_COLUMN_TITLES["done"] ?? "Done");
}

/**
 * Where a new column panel goes: on the end of the row its neighbours make,
 * inside the frame holding them, which is widened to fit. Null when the columns
 * are not in a frame — then the registry address is right.
 */
function appendedColumnPlacement(editor: Editor, at: CanvasPoint | null = null): Box | null {
  const columns = [...panelShapes(editor).values()].filter((entry) => entry.ref.kind === "column");
  let last: { id: TLShapeId; box: Box } | null = null;
  for (const entry of columns) {
    const bounds = editor.getShapePageBounds(entry.id);
    if (bounds === undefined) continue;
    // A point says which row: adding a column while looking at one kanban must
    // not extend a different one on the far side of the canvas.
    if (at !== null && frameHolding(editor, entry.id)?.id !== frameAtPoint(editor, at)?.id)
      continue;
    const box = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    if (last === null || box.x > last.box.x) last = { id: entry.id, box };
  }
  if (last === null) return null;
  const frame = frameHolding(editor, last.id);
  if (frame === null) return null;
  const grown = appendToColumnRow({
    last: last.box,
    frame: frameBox(frame),
    width: panelSize("column").w,
  });
  editor.updateShape({
    id: frame.id,
    type: FRAME_SHAPE_TYPE,
    props: { w: grown.frame.w, h: grown.frame.h },
  });
  return grown.panel;
}

/** Whether some frame is already drawn around the kanban region's panels. */
function kanbanRegionFramed(editor: Editor): boolean {
  return [...panelShapes(editor).values()]
    .filter((entry) => isKanbanRegionKind(entry.ref.kind))
    .some((entry) => frameHolding(editor, entry.id) !== null);
}

/** The union of the column and composer panels, wherever they have been moved to. */
function kanbanRegionBounds(editor: Editor): Bounds | null {
  return unionBoxes(
    [...panelShapes(editor).values()]
      .filter((entry) => isKanbanRegionKind(entry.ref.kind))
      .map((entry) => editor.getShapePageBounds(entry.id))
      .filter((box) => box !== undefined)
      .map((box) => ({ x: box.x, y: box.y, w: box.w, h: box.h })),
  );
}

/**
 * Turn one Hermes spec into shapes: a titled frame of its own, placed in the
 * first free space on the page. The human gets one undo per drawing and their
 * own work is never overwritten.
 */
function materialize(editor: Editor, spec: CanvasInjectionSpec): Bounds {
  const layout = layoutInjection(spec, nextOrigin(pageBounds(editor)));
  const frameId = createShapeId();
  const shapes: Array<TLShapePartial> = [
    {
      id: frameId,
      type: "frame",
      x: layout.frame.x,
      y: layout.frame.y,
      props: { w: layout.frame.w, h: layout.frame.h, name: spec.title || "Hermes" },
    },
  ];

  const idByKey = new Map<string, TLShapeId>();
  for (const placed of layout.nodes) {
    const id = createShapeId();
    idByKey.set(placed.node.key, id);
    const kind = placed.node.shape ?? "rectangle";
    const color = placed.node.color ?? "blue";
    shapes.push(
      kind === "note"
        ? {
            id,
            type: "note",
            parentId: frameId,
            x: placed.x,
            y: placed.y,
            props: { richText: toRichText(placed.node.text), color },
          }
        : {
            id,
            type: "geo",
            parentId: frameId,
            x: placed.x,
            y: placed.y,
            props: {
              geo: NODE_SHAPE_GEO[kind],
              w: placed.width,
              h: placed.height,
              color,
              richText: toRichText(placed.node.text),
            },
          },
    );
  }

  // Arrows are shapes plus bindings — without the bindings they are loose lines
  // that stop following their boxes the moment the human drags one.
  const bindings: Array<TLArrowBinding> = [];
  for (const edge of spec.edges) {
    const from = idByKey.get(edge.from);
    const to = idByKey.get(edge.to);
    if (!from || !to) continue;
    const arrowId = createShapeId();
    shapes.push({
      id: arrowId,
      type: "arrow",
      parentId: frameId,
      ...(edge.label ? { props: { richText: toRichText(edge.label) } } : {}),
    });
    for (const [terminal, target] of [
      ["start", from],
      ["end", to],
    ] as const) {
      bindings.push({
        id: createBindingId(),
        typeName: "binding",
        type: "arrow",
        fromId: arrowId,
        toId: target,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none",
        },
        meta: {},
      });
    }
  }

  if (layout.note !== null && spec.note) {
    shapes.push({
      id: createShapeId(),
      type: "text",
      parentId: frameId,
      x: layout.note.x,
      y: layout.note.y,
      props: { richText: toRichText(spec.note), color: "grey" },
    });
  }

  editor.createShapes(shapes);
  if (bindings.length > 0) editor.createBindings(bindings);
  return layout.focus;
}

export function BoardCanvas({
  station = null,
  onEditor,
}: {
  /** The station the camera is locked on. Null is free roam. */
  readonly station?: StationRef | null;
  /** Hands the live editor to whoever needs to drive it. */
  readonly onEditor?: (editor: Editor | null) => void;
}) {
  const licenseSettled = usePrimarySettingsLoaded();
  const settingsLicenseKey = usePrimarySettings((settings) => settings.canvasLicenseKey);
  const license = useMemo(
    () =>
      readTldrawLicense(
        resolveTldrawLicenseKey({ settingsKey: settingsLicenseKey, buildKey: BUILD_LICENSE_KEY }),
        new Date(),
      ),
    [settingsLicenseKey],
  );
  const licenseNotice = tldrawLicenseNotice(license);
  const { environmentId, document, isPending, refresh } = useCanvasDocument();
  const { injections, refresh: refreshInjections } = useCanvasInjections();
  const { cards, isPending: cardsPending, error: cardsError } = useKanbanCards();
  const commands = useCanvasCommands(environmentId);
  const toolsHidden = useCanvasViewStore((state) => state.toolsHidden);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [panelEpoch, setPanelEpoch] = useState(0);
  // The editor instance that has the persisted document loaded into it. Tracked
  // per instance, not as a boolean: tldraw recreates its store (and editor) on
  // crashes and prop-identity changes, and a boolean that stayed true handed the
  // save loop a blank store to overwrite the real document with.
  const [loadedEditor, setLoadedEditor] = useState<Editor | null>(null);
  // The editor holding a document this build could not read. Kept per instance
  // for the same reason as `loadedEditor`, and separate from it so that a
  // canvas we failed to open never counts as one we loaded.
  const [unreadableEditor, setUnreadableEditor] = useState<Editor | null>(null);
  const loaded = editor !== null && loadedEditor === editor;
  const unreadable = editor !== null && unreadableEditor === editor;

  // The camera treats `board` as a place to fly to; the panel layer must not
  // treat it as a focused page, or every panel hides behind a focus that
  // never resolves to one of them.
  const focusedStation = station !== null && station.kind === "board" ? null : station;

  const revisionRef = useRef(0);
  const parkedRef = useRef(false);
  const appliedRef = useRef<Set<string>>(new Set());
  // The loop outlives every render, so a changed callback identity can never
  // cancel a debounced write that has not gone out yet.
  const saveDepsRef = useRef({ commands, refresh });
  saveDepsRef.current = { commands, refresh };

  // Load the persisted document into every editor instance we're handed —
  // including one tldraw recreated mid-session — before the save listener
  // attaches, so loading never looks like a local edit worth saving.
  useEffect(() => {
    if (editor === null || document === null) return;
    if (loadedEditor === editor || unreadableEditor === editor) return;
    if (document.snapshot !== null && document.snapshot.length > 0) {
      try {
        loadSnapshot(editor.store, JSON.parse(document.snapshot) as never);
      } catch (cause) {
        // Saving stays off until a human decides. Starting clean and letting
        // the next stroke overwrite is how a document this build merely failed
        // to *read* becomes a canvas somebody lost.
        console.error("Canvas snapshot could not be opened by this build", cause);
        setUnreadableEditor(editor);
        return;
      }
    }
    // Loading is not an edit. Left on the undo stack, one Ctrl+Z on a canvas
    // you have not touched yet wipes every shape in it — and the save loop
    // persists that a second and a half later.
    editor.clearHistory();
    revisionRef.current = document.revision;
    setLoadedEditor(editor);
  }, [editor, loadedEditor, unreadableEditor, document]);

  useEffect(() => {
    if (editor === null || !loaded) return;
    const loop: CanvasSaveLoop = createCanvasSaveLoop({
      revision: revisionRef.current,
      readRecord: (id) => editor.store.get(id as TLRecord["id"]),
      snapshot: () => JSON.stringify(getSnapshot(editor.store)),
      save: (input) =>
        saveDepsRef.current.commands
          .saveSnapshot(input)
          .then((result) =>
            result._tag === "Failure"
              ? null
              : { revision: result.value.revision, saved: result.value.saved },
          )
          .catch(() => null),
      onConflict: () => saveDepsRef.current.refresh(),
    });
    const stop = editor.store.listen(
      (change) => {
        // Re-run the reconciler: a closed panel stays closed, but the kanban
        // is force-present, and select-all-and-delete is one keystroke. Frame
        // removals count too — deleting the Board frame deletes the columns
        // its query held, and home has to come back.
        if (
          Object.values(change.changes.removed).some(
            (record) =>
              record.typeName === "shape" &&
              (record.type === PANEL_SHAPE_TYPE || record.type === FRAME_SHAPE_TYPE),
          )
        ) {
          setPanelEpoch((epoch) => epoch + 1);
        }
        loop.touch([
          ...Object.keys(change.changes.added),
          ...Object.keys(change.changes.updated),
          ...Object.keys(change.changes.removed),
        ]);
      },
      { source: "user", scope: "document" },
    );
    return () => {
      stop();
      void loop.stop();
    };
  }, [editor, loaded]);

  // Copy/paste, Ctrl+D and alt-drag clone panel shapes verbatim, and a clone
  // that shares its station with the original is a ghost the layer never
  // paints. Terminals retarget to a fresh shell id — duplicating a terminal
  // pane opens another shell where that one is — and every other duplicate is
  // dropped on creation. Registered only once the document is loaded, so a
  // snapshot being read in can never trip it.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const disposeBefore = editor.sideEffects.registerBeforeCreateHandler(
      "shape",
      (shape, source) => {
        if (source !== "user" || shape.type !== PANEL_SHAPE_TYPE) return shape;
        const props = (shape as T3PanelShape).props;
        const existing = panelShapes(editor);
        const resolution = resolveDuplicatePanel(
          { kind: props.kind, entityId: props.entityId },
          new Set(existing.keys()),
          knownTerminalIdsForMint(
            [...existing.values()].map((entry) => entry.ref),
            Object.values(useTerminalUiStateStore.getState().terminalUiStateByThreadKey).flatMap(
              (state) => state.terminalIds,
            ),
          ),
        );
        return resolution.action === "retarget"
          ? { ...shape, props: { ...props, entityId: resolution.entityId } }
          : shape;
      },
    );
    const disposeAfter = editor.sideEffects.registerAfterCreateHandler("shape", (shape, source) => {
      if (source !== "user" || shape.type !== PANEL_SHAPE_TYPE) return;
      const props = (shape as T3PanelShape).props;
      const identity = panelIdentity({ kind: props.kind, entityId: props.entityId });
      const owner = panelShapes(editor).get(identity);
      if (owner !== undefined && owner.id !== shape.id) editor.deleteShapes([shape.id]);
    });
    return () => {
      disposeBefore();
      disposeAfter();
    };
  }, [editor, loaded]);

  // A frame carries what it holds however it is moved: the title-bar drag,
  // tldraw's own translate, the arrow keys, align. And a locked one holds it
  // still rather than letting the selection walk out from under the border.
  // Registered once the document is loaded, so reading a snapshot in never
  // drags a frame's contents with it.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const moves = registerFrameMoves(editor);
    const anchors = registerFrameAnchors(editor);
    return () => {
      moves();
      anchors();
    };
  }, [editor, loaded]);

  // And it stays behind them. A frame's rectangle is filled and hit-testable,
  // so a panel left painted under one takes neither the click nor the drag —
  // which is how a single column starts behaving unlike the other three.
  // Registered before the passes below, so every frame they draw lands behind
  // what it is drawn around.
  useEffect(() => {
    if (editor === null || !loaded) return;
    return registerFrameBackdrop(editor);
  }, [editor, loaded]);

  /** Give up on the stored document and keep drawing, saving over it. */
  const startOver = useCallback(() => {
    if (editor === null) return;
    // `loadSnapshot` can leave half of a document it choked on behind.
    editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
    editor.clearHistory();
    revisionRef.current = document?.revision ?? 0;
    setUnreadableEditor(null);
    setLoadedEditor(editor);
  }, [editor, document]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  // Stations are the navigation, and focusing one draws the panel at window
  // size over the canvas (`PanelLayer`). The camera still flies to it so the
  // page you were on is what you are looking at the moment you leave focus.
  const showStation = useCallback(
    (target: StationRef | null, animate: boolean) => {
      if (editor === null) return false;
      if (target === null) return true;
      // `board` is the kanban's address: the frame drawn around the region, or
      // the region's own union before one exists.
      const bounds =
        target.kind === "board"
          ? kanbanBounds(editor)
          : target.kind === "frame"
            ? isShapeId(target.entityId)
              ? (editor.getShapePageBounds(target.entityId) ?? null)
              : null
            : (() => {
                const panel = panelShapes(editor).get(panelIdentity(target));
                if (panel === undefined) return null;
                // A page framed on the canvas is looked at through its frame:
                // fitting the panel alone leaves the border it is drawn in
                // hanging off both edges of the window.
                const frame = frameHolding(editor, panel.id);
                if (frame !== null) return frameBox(frame);
                return editor.getShapePageBounds(panel.id) ?? null;
              })();
      if (bounds === null) return false;
      const screen = editor.getViewportScreenBounds();
      const camera = stationCamera(
        bounds,
        { w: screen.width, h: screen.height },
        chromeReserve({ screenWidth: screen.width, toolsHidden }),
      );
      editor.setCamera(camera, animate ? { animation: { duration: 260 } } : {});
      return true;
    },
    [editor, toolsHidden],
  );

  // One panel per page of the app: the three fixed ones, plus every thread the
  // board is running. Creation only — where a panel sits after that belongs to
  // whoever dragged it last.
  const activeThreadIds = useMemo(() => {
    const fromBoard = cards
      .filter((card) => card.at === "active" && card.archivedAt === null)
      .toSorted((a, b) => a.position - b.position)
      .map((card) => card.threadId)
      .filter((threadId): threadId is string => typeof threadId === "string");
    // A thread opened straight from the composer has no card yet, and a station
    // pointing at a panel that does not exist is a camera move that never lands.
    return station !== null && station.kind === "thread" && !fromBoard.includes(station.entityId)
      ? [...fromBoard, station.entityId]
      : fromBoard;
  }, [cards, station]);

  // An empty board is also what a first load and a failed poll look like, and
  // reaping against either wipes every thread panel on the canvas.
  const boardKnown = !cardsPending && cardsError === null;

  // The column ids the cards are sitting in. These are the only columns the
  // canvas *must* hold a panel for: a column is a panel somebody put there, and
  // the one thing that cannot happen is a card in a column with no panel.
  const cardColumnKey = distinctColumnIds(cards.map((card) => card.at)).join("\u0000");
  const cardColumnIds = useMemo(
    () => (cardColumnKey.length === 0 ? [] : cardColumnKey.split("\u0000")),
    [cardColumnKey],
  );

  // The board's columns, in the order they stand on the canvas — what a Kanban
  // frame lays out. Read through a string for the same reason `PanelLayer`
  // does: the reactive read touches every shape, and a drawing stroke must not
  // rebuild the layout context.
  const columnPanelKey = useValue(
    "board column panels",
    () => (editor === null ? "" : encodeColumnPanels(columnPanelEntries(editor))),
    [editor],
  );
  const layoutColumnIds = useMemo(
    () =>
      boardColumns({
        panels: decodeColumnPanels(columnPanelKey),
        cardColumns: cardColumnIds,
      }).map((column) => column.id),
    [columnPanelKey, cardColumnIds],
  );

  /**
   * What a frame layout is built against. Everything in it is something the
   * board already knows, so dropping a Kanban frame lays out *this* board's
   * columns and an IDE frame opens on a project that exists.
   */
  const layoutContext = useMemo(
    (): FrameLayoutContext => ({
      columnIds: layoutColumnIds,
      projectId: "",
      repoBinding: "",
      threadIds: activeThreadIds,
    }),
    [layoutColumnIds, activeThreadIds],
  );

  // Live server browser tabs each get a panel; the human's board browser
  // (empty entityId) is panel-first and stays out of this list.
  const browserSessions = useAgentBrowserSessions();
  const browserKnown = browserSessions !== undefined;
  const browserEntityIds = useMemo(
    () =>
      (browserSessions ?? [])
        .filter((session) => !isBoardBrowserSession(session))
        .map((session) => browserEntityId({ threadId: session.threadId, tabId: session.tabId })),
    [browserSessions],
  );

  // A shell a thread is *using* gets a panel — a command running in it, which
  // is what the roster's `hasRunningSubprocess` says. Not a shell it merely
  // opened: a thread mints one at startup and leaves it at a prompt, and four
  // threads' worth of empty prompts is four panels nobody asked for.
  //
  // Once minted the panel stays for as long as the thread is on the board
  // (`keptThreadPanels`), so the command ending does not take the output with
  // it. The host console's own shells are not in this list at all — those are
  // panels a human opened.
  const primaryEnvironment = usePrimaryEnvironment();
  const threadTerminalSessions = useKnownTerminalSessions({
    environmentId: primaryEnvironment?.environmentId ?? null,
    threadId: null,
  });
  const terminalKnown = primaryEnvironment?.environmentId !== undefined;
  const activeThreadKey = activeThreadIds.join(" ");
  const terminalEntityIds = useMemo(() => {
    const threads = new Set(activeThreadKey.length === 0 ? [] : activeThreadKey.split(" "));
    return threadTerminalSessions
      .filter(
        (session) =>
          session.target.threadId !== HOST_CONSOLE_THREAD_ID &&
          threads.has(session.target.threadId) &&
          session.state.hasRunningSubprocess,
      )
      .map((session) =>
        threadTerminalEntityId({
          threadId: session.target.threadId,
          terminalId: session.target.terminalId,
        }),
      );
  }, [activeThreadKey, threadTerminalSessions]);

  useEffect(() => {
    if (editor === null || !loaded) return;
    const panels = [...panelShapes(editor).values()];
    const existing = panels.map((entry) => entry.ref);
    // Which panels a human owns is the registry's rule (`panelReapable`). What
    // is left to decide here is the roster: until one has arrived, every panel
    // it would answer for is kept, so a reconnect cannot reap a live view or a
    // running pty.
    const keptBrowserRefs = browserKnown ? [] : existing.filter((ref) => ref.kind === "browser");
    const keptTerminalRefs = terminalKnown ? [] : existing.filter((ref) => ref.kind === "terminal");
    const desired = [
      ...desiredStations(activeThreadIds, browserEntityIds, cardColumnIds, terminalEntityIds),
      // Already on the canvas and the thread is still running: it stays, whatever
      // the roster now says about the tab or the pty behind it.
      ...keptThreadPanels(existing, activeThreadIds),
      ...keptBrowserRefs,
      ...keptTerminalRefs,
    ];
    // The header's Terminal entry is a station like Hermes or Settings, but the
    // panel is closable — navigating to it must put one back or the camera
    // lands on empty canvas.
    if (station !== null && station.kind === "terminal")
      desired.push({ kind: "terminal", entityId: station.entityId });
    // A canvas with nothing on it has never been opened; one with panels on it
    // has the panels somebody decided to keep. Only the first gets the pages a
    // fresh board comes with, or closing Hermes would put it straight back.
    const wanted =
      existing.length === 0
        ? [
            ...seedStations(),
            ...desired.filter(
              (ref) =>
                ref.kind === "thread" ||
                ref.kind === "browser" ||
                (ref.kind === "terminal" && parseThreadTerminalRef(ref.entityId) !== null),
            ),
          ]
        : desired;
    const missing = missingStations(wanted, existing);
    // Archiving a card takes its thread off the board; without this its panel
    // stays parked under the board forever, which reads as the archive not
    // having happened at all.
    // A `board` station is the kanban region, not a panel — keeping it alive
    // would pin the pre-split board panel this pass exists to replace.
    const keep = station !== null && station.kind === "board" ? null : station;
    const stale = boardKnown
      ? new Set(staleStations(desired, existing, keep).map(panelIdentity))
      : new Set<string>();
    const reap = panels
      .filter((entry) => stale.has(panelIdentity(entry.ref)))
      .map((entry) => entry.id);
    // Reap first so an emptied "Dev gallery" frame is visible this pass, then
    // drop that border. Gallery panels go; the empty frame used to remain.
    if (reap.length > 0) editor.deleteShapes(reap);
    reapEmptyGalleryFrames(editor);
    if (missing.length === 0) return;
    editor.run(() => {
      for (const { ref, threadIndex } of missing) {
        // A column added in settings joins the row its neighbours are standing
        // in, and the frame around them grows to hold it. Only a column: every
        // other kind is opened by a human, who chose where it went.
        const inRow = ref.kind === "column" ? appendedColumnPlacement(editor) : null;
        // A panel a thread opened stands under that thread, so what opened it is
        // something you can see rather than something you have to work out.
        const underThread = satelliteRowPlacement(editor, ref);
        const placement = inRow ?? underThread ?? rowPlacement(editor, ref, threadIndex);
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
              title: seedPanelTitle(ref),
            },
          },
        ]);
      }
    });
    // Opening a card whose thread has no panel yet lands here, one tick after
    // the camera already gave up on a station that did not exist. Without this
    // the thread opens focused and leaving focus drops you somewhere else.
    if (
      station !== null &&
      missing.some(({ ref }) => panelIdentity(ref) === panelIdentity(station))
    ) {
      showStation(station, false);
    }
  }, [
    editor,
    loaded,
    activeThreadIds,
    boardKnown,
    browserEntityIds,
    browserKnown,
    cards,
    terminalEntityIds,
    terminalKnown,
    panelEpoch,
    station,
    showStation,
  ]);

  // Frames used to swallow the panels dropped on them and draw the pages
  // themselves, stretched to fill a slot. They are borders now, so a saved
  // canvas hands its docked pages back to the canvas as panels on load and the
  // passes below draw the frames around them again.
  useEffect(() => {
    if (editor === null || !loaded) return;
    if (unpackLegacyFrames(editor)) setPanelEpoch((epoch) => epoch + 1);
  }, [editor, loaded]);

  useEffect(() => {
    if (editor === null || !loaded) return;
    renameArchivedDoneColumn(editor);
  }, [editor, loaded]);

  // The kanban region gets a border: one frame drawn around the columns and the
  // composer, at whatever size and place they already have. Nothing inside is
  // moved or resized — the frame is the rectangle you go to when you ask for
  // the board. Runs whenever the region exists with no Board frame around it:
  // first load, and again if the frame is deleted and home respawns.
  useEffect(() => {
    if (editor === null || !loaded || kanbanFrame(editor) !== null) return;
    // A Kanban frame dropped from the add menu gathers the columns into itself.
    // Drawing a Board frame around them then would be a second border around
    // panels that already have one — so the pass only runs while the region is
    // standing loose on the canvas.
    if (kanbanRegionFramed(editor)) return;
    const bounds = kanbanRegionBounds(editor);
    if (bounds === null) return;
    const box = frameAround(bounds);
    editor.markHistoryStoppingPoint("frame the board");
    editor.createShapes([
      {
        id: createShapeId(),
        type: FRAME_SHAPE_TYPE,
        x: box.x,
        y: box.y,
        props: { ...frameProps("board"), w: box.w, h: box.h },
      },
    ]);
  }, [editor, loaded, panelEpoch]);

  // The thread lane gets a border of its own: the first few places on the thread
  // row, drawn as one rectangle, so where the next thread will appear is
  // something you can see rather than something you have to know. It is the
  // addresses, not the threads — an empty lane is still the answer, and one that
  // shrank to its contents would move every time a thread was closed.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const threads = [...panelShapes(editor).values()].filter(
      (entry) => entry.ref.kind === "thread",
    ).length;
    const box = frameAround(threadLaneBox(threads));
    const lane = threadLaneFrame(editor);
    if (lane === null) {
      editor.markHistoryStoppingPoint("frame the thread lane");
      editor.createShapes([
        {
          id: createShapeId(),
          type: FRAME_SHAPE_TYPE,
          x: box.x,
          y: box.y,
          props: { ...frameProps("threads"), w: box.w, h: box.h },
        },
      ]);
      return;
    }
    // Widened, never narrowed: the row grows rightward as threads open, and a
    // lane that shrank again would drag the threads standing past the new edge
    // back in with it.
    if (lane.props.w >= box.w) return;
    editor.updateShape({ id: lane.id, type: FRAME_SHAPE_TYPE, props: { w: box.w } });
  }, [editor, loaded, panelEpoch, activeThreadIds]);

  // Each seeded page gets a border of its own, so the header's frame list names
  // every screen on the canvas. The panel keeps its authored size and position;
  // the frame is drawn around it. Only fires while a page has no frame around
  // it, so a page dragged out of its frame stays out until somebody frames it.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const wrapKinds = new Set<string>(["hermes", "settings", "explorer", "terminal", "threads"]);
    const wraps = [...panelShapes(editor).values()].filter(
      (entry) =>
        wrapKinds.has(entry.ref.kind) &&
        entry.ref.entityId === "" &&
        frameHolding(editor, entry.id) === null,
    );
    if (wraps.length === 0) return;
    editor.markHistoryStoppingPoint("frame the pages");
    editor.run(() => {
      for (const entry of wraps) {
        const bounds = editor.getShapePageBounds(entry.id);
        if (!bounds) continue;
        const box = frameAround({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
        editor.createShapes([
          {
            id: createShapeId(),
            type: FRAME_SHAPE_TYPE,
            x: box.x,
            y: box.y,
            props: {
              ...frameProps("custom"),
              title: panelLabel(entry.ref.kind, entry.ref.entityId),
              w: box.w,
              h: box.h,
            },
          },
        ]);
      }
    });
  }, [editor, loaded, panelEpoch]);

  // Dropping in a frame. It lands centered on the point that asked for it —
  // the right-click, the paste — and only falls back to the middle of the
  // window for point-less gestures like the toolbar button or the palette.
  // The camera stays where it is unless the request asked to be taken there:
  // a rectangle drawn under your pointer is already in front of you, while one
  // asked for from the header is not, and on a phone never will be.
  const requestedFrame = useCanvasStationStore((state) => state.requestedFrame);
  const requestFrame = useCanvasStationStore((state) => state.requestFrame);
  const requestStation = useCanvasStationStore((state) => state.requestStation);
  useEffect(() => {
    if (editor === null || !loaded || requestedFrame === null) return;
    requestFrame(null);
    const { preset, at, focus } = requestedFrame;
    const goTo = (id: TLShapeId) => {
      if (focus) requestStation({ kind: "frame", entityId: id });
    };
    const viewport = editor.getViewportPageBounds();
    const layoutId = presetLayoutId(preset);
    // A point-less request — the header, the palette — is centred on what you
    // are looking at, and the middle of the window is usually a page. Landing a
    // whole IDE on top of the board is how the one entry point a phone has read
    // as broken, so a frame nobody aimed walks to the nearest free space. A
    // right-click aimed at a spot keeps it: that is the point of aiming.
    const clearOfBoard = (box: Box, adopting: ReadonlySet<TLShapeId>): Box => {
      if (at !== null) return box;
      const occupied: Array<Box> = frameShapes(editor).map(frameBox);
      for (const entry of panelShapes(editor).values()) {
        if (adopting.has(entry.id)) continue;
        const bounds = editor.getShapePageBounds(entry.id);
        if (bounds === undefined) continue;
        occupied.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      }
      return clearOfPanels(box, occupied);
    };
    // A laid-out frame is a frame plus a composition. The panels are ordinary
    // panels the moment they exist: the frame is still only the border, and
    // dragging one out of it takes it out of the frame like any other page.
    if (layoutId !== null) {
      const center = at ?? { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
      const placements = frameLayout(layoutId).build(layoutContext);
      const laidOut = frameForLayout({ placements, at: center });
      // The pages this layout is about to gather into itself are not in its
      // way: they are moving into it. Anything else on the canvas is.
      const onPageNow = panelShapes(editor);
      const adopted = new Set<TLShapeId>();
      for (const panel of laidOut.panels) {
        const existing = onPageNow.get(panelIdentity(panel.ref))?.id;
        if (existing !== undefined) adopted.add(existing);
      }
      const cleared = clearOfBoard(laidOut.frame, adopted);
      const shift = { x: cleared.x - laidOut.frame.x, y: cleared.y - laidOut.frame.y };
      const built = {
        frame: cleared,
        panels: laidOut.panels.map((panel) => ({
          ref: panel.ref,
          box: { ...panel.box, x: panel.box.x + shift.x, y: panel.box.y + shift.y },
        })),
      };
      editor.markHistoryStoppingPoint("add frame");
      // Frames the adopted panels are leaving. Each was drawn around what it
      // was holding, so one left with nothing in it is a border around nothing.
      const vacated = new Set<TLShapeId>();
      const frameId = createShapeId();
      editor.run(() => {
        editor.createShapes([
          {
            id: frameId,
            type: FRAME_SHAPE_TYPE,
            x: built.frame.x,
            y: built.frame.y,
            props: { ...frameProps(preset), w: built.frame.w, h: built.frame.h },
          },
        ]);
        // Reuse before create: a panel is one page, and a second Hermes or a
        // second Prompts column would be two windows fighting over one thing.
        // So a layout gathers the panels it names into its own frame and only
        // creates the ones that are not on the canvas yet. Two IDE frames over
        // two projects are two sets of panels because their addresses differ —
        // that is what "several of these at once" rests on.
        const onPage = panelShapes(editor);
        for (const panel of built.panels) {
          const existing = onPage.get(panelIdentity(panel.ref))?.id;
          if (existing !== undefined) {
            const leaving = frameHolding(editor, existing);
            if (leaving !== null) vacated.add(leaving.id);
            editor.updateShape({
              id: existing,
              type: PANEL_SHAPE_TYPE,
              x: panel.box.x,
              y: panel.box.y,
              props: { w: panel.box.w, h: panel.box.h },
            });
            continue;
          }
          editor.createShapes([
            {
              id: createShapeId(),
              type: PANEL_SHAPE_TYPE,
              x: panel.box.x,
              y: panel.box.y,
              props: {
                w: panel.box.w,
                h: panel.box.h,
                kind: panel.ref.kind,
                entityId: panel.ref.entityId,
              },
            },
          ]);
        }
      });
      // After the batch, not inside it: what a frame is holding is derived from
      // where its panels stand, and inside the run those are still the values
      // the panels had before they moved — so every frame read as full and none
      // was ever cleaned up.
      const emptied = [...vacated].filter((id) => frameChildShapes(editor, id).length === 0);
      if (emptied.length > 0) {
        editor.run(() => editor.deleteShapes(emptied), { ignoreShapeLock: true });
      }
      setPanelEpoch((epoch) => epoch + 1);
      selectPlaced(editor, frameId);
      goTo(frameId);
      return;
    }
    const props = frameProps(preset);
    // A custom frame is a screen: it opens at the window's own pixel size, so
    // fullscreening it later is the same layout at 1:1.
    if (preset === "custom") {
      const screenNow = editor.getViewportScreenBounds();
      props.w = Math.max(FRAME_MIN_SIZE.w, Math.round(screenNow.width));
      props.h = Math.max(FRAME_MIN_SIZE.h, Math.round(screenNow.height));
    }
    const origin = clearOfBoard(
      at !== null
        ? { x: at.x - props.w / 2, y: at.y - FRAME_HEADER_HEIGHT / 2, w: props.w, h: props.h }
        : {
            x: viewport.x + (viewport.w - props.w) / 2,
            y: viewport.y + (viewport.h - props.h) / 2,
            w: props.w,
            h: props.h,
          },
      EMPTY_ADOPTION,
    );
    editor.markHistoryStoppingPoint("add frame");
    const id = createShapeId();
    editor.createShapes([{ id, type: FRAME_SHAPE_TYPE, x: origin.x, y: origin.y, props }]);
    selectPlaced(editor, id);
    goTo(id);
  }, [editor, loaded, layoutContext, requestedFrame, requestFrame, requestStation]);

  // Screens are frames now. A canvas saved before the merge still holds
  // `t3-viewport` regions — each becomes a frame with the same content box and
  // name, so nothing on it moves and the old red border simply grows a title
  // bar. Runs once per load; a canvas without regions is a no-op.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const regions = viewportShapes(editor);
    if (regions.length === 0) return;
    editor.run(() => {
      for (const region of regions) {
        const box = viewportBox(region);
        const props = frameProps(isPhoneFrame(box) ? "mobile" : "desktop");
        editor.createShapes([
          {
            id: createShapeId(),
            type: FRAME_SHAPE_TYPE,
            x: box.x,
            y: box.y - FRAME_HEADER_HEIGHT,
            props: {
              ...props,
              title: region.props.title,
              w: box.w,
              h: box.h + FRAME_HEADER_HEIGHT,
            },
          },
        ]);
      }
      editor.deleteShapes(regions.map((region) => region.id));
    });
  }, [editor, loaded]);

  // Pasting lands under the pointer, the same place a right-click add does —
  // tldraw's default pastes into the middle of the viewport instead.
  useEffect(() => {
    if (editor === null) return;
    editor.user.updateUserPreferences({ isPasteAtCursorMode: true });
  }, [editor]);

  const requestedPanel = useCanvasStationStore((state) => state.requestedPanel);
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);
  useEffect(() => {
    if (editor === null || !loaded || requestedPanel === null) return;
    requestPanel(null);
    const { ref, at, focus, near } = requestedPanel;
    // A frame is a shape somebody drew, not a panel this effect can mint.
    if (ref.kind === "frame") return;
    const already = panelShapes(editor).get(panelIdentity(ref));
    if (already !== undefined) {
      // One panel per page: asking for one that is already out there shows you
      // that one. It is brought to the front, and the camera pans to it — at
      // the zoom you were on, never fitted to it — only when it is off screen,
      // because an add that appears to do nothing is the same as a lost panel.
      if (!focus) {
        editor.bringToFront([already.id]);
        selectPlaced(editor, already.id);
        const bounds = editor.getShapePageBounds(already.id) ?? null;
        const viewport = editor.getViewportPageBounds();
        const onScreen =
          bounds !== null &&
          panelPresence(
            { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
            { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
          ) > 0;
        if (bounds !== null && !onScreen) {
          const camera = editor.getCamera();
          editor.setCamera(
            {
              x: viewport.w / 2 - (bounds.x + bounds.w / 2),
              y: viewport.h / 2 - (bounds.y + bounds.h / 2),
              z: camera.z,
            },
            { animation: { duration: 260 } },
          );
        }
      }
    } else {
      const existing = [...panelShapes(editor).values()].map((entry) => entry.ref);
      const viewport = editor.getViewportPageBounds();
      // A right-click carries its point, and the panel lands under it. An add
      // made from nowhere — the palette — is centred in what you are looking
      // at, because nothing moves the camera onto it. Only a station the camera
      // is about to fly to keeps its registry address.
      const size = panelSize(ref.kind);
      // Opened from a panel standing in a frame: it belongs in that frame, in
      // the space beside the one that asked for it.
      const besideWanted = near === null ? null : placeNearPanel(editor, near, ref.kind);
      // Beside the list is one place, and the second thread opened from it
      // wanted the same one. A taken spot falls through to the row, where the
      // threads queue up, rather than stacking inside the frame.
      const beside =
        besideWanted !== null &&
        occupiedPanelBoxes(editor).some((box) => boxesOverlap(besideWanted, box))
          ? null
          : besideWanted;
      // A column dropped inside a kanban's border joins that row and widens the
      // frame, rather than landing on top of the columns already in it.
      const inRow = ref.kind === "column" ? appendedColumnPlacement(editor, at) : null;
      const wanted =
        beside !== null
          ? beside
          : inRow !== null
            ? inRow
            : at !== null
              ? panelPlacementAt(at, ref.kind)
              : focus
                ? rowPlacement(editor, ref, nextPanelSlot(ref.kind, existing))
                : {
                    x: viewport.x + (viewport.w - size.w) / 2,
                    y: viewport.y + (viewport.h - size.h) / 2,
                    ...size,
                  };
      // A pointer drop and a viewport-centre add both name a spot without
      // looking at what is standing on it. The row placements already read the
      // page, and a column joining a row belongs in it.
      const nudge = beside === null && inRow === null && !focus;
      const placement = nudge ? clearOfPanels(wanted, occupiedPanelBoxes(editor)) : wanted;
      const id = createShapeId();
      editor.createShapes([
        {
          id,
          type: PANEL_SHAPE_TYPE,
          x: placement.x,
          y: placement.y,
          props: {
            w: placement.w,
            h: placement.h,
            kind: ref.kind,
            entityId: ref.entityId,
            title: seedPanelTitle(ref),
          },
        },
      ]);
      if (!focus) selectPlaced(editor, id);
    }
    // Adding a component puts it on the canvas, nothing more: the page you were
    // reading stays in front of you instead of being replaced by a new one
    // blown up to the window.
    if (focus) requestStation(ref);
  }, [editor, loaded, requestedPanel, requestPanel, requestStation]);

  // Depends on the station alone: the document refetches on every save conflict
  // and reconnect, and re-flying the camera on each one yanked the viewport out
  // from under whoever was drawing.
  const leftRef = useRef<StationRef | null>(null);
  useEffect(() => {
    if (editor === null || !loaded) return;
    const left = leftRef.current;
    leftRef.current = station;
    if (station === null) {
      // Leaving fullscreen lands on the page you left, not on wherever the
      // canvas was parked before you opened it.
      if (left !== null) showStation(left, true);
      return;
    }
    // Whatever the canvas would have parked on, you are already somewhere: the
    // first-paint park must not fire the moment you step back out.
    parkedRef.current = true;
    showStation(station, true);
  }, [editor, loaded, station, showStation]);

  // A station has to stay centred when the window changes size, or the page you
  // navigated to drifts under the toolbar.
  useEffect(() => {
    if (editor === null || station === null) return;
    const onResize = () => showStation(station, false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [editor, station, showStation]);

  // First paint parks on the board — the canvas is the app's root, and its root
  // view is the thing you came here for.
  useEffect(() => {
    if (editor === null || !loaded || parkedRef.current || station !== null) return;
    if (showStation({ kind: "board", entityId: "" }, false)) parkedRef.current = true;
  }, [editor, loaded, station, showStation]);

  // Materialize whatever Hermes queued. Applied ids are remembered locally too,
  // so a refetch that races the ack cannot draw the same diagram twice. Every
  // pending id is acked — a spec tldraw refuses would otherwise replay on every
  // load forever, taking the canvas down with it each time.
  useEffect(() => {
    if (editor === null || !loaded) return;
    const pending = pendingInOrder(injections as ReadonlyArray<CanvasInjection>).filter(
      (injection) => !appliedRef.current.has(injection.id),
    );
    if (pending.length === 0) return;

    let focus: Bounds | null = null;
    for (const injection of pending) {
      appliedRef.current.add(injection.id);
      try {
        editor.run(() => {
          const bounds = materialize(editor, injection.spec);
          // Focus is opt-in: the canvas must not yank the viewport out from
          // under someone mid-sentence because a thread finished drawing.
          if (injection.spec.focus === true) focus = bounds;
        });
      } catch (cause) {
        console.warn(`Canvas injection ${injection.id} could not be drawn`, cause);
      }
    }
    if (focus !== null) editor.zoomToBounds(focus, { animation: { duration: 320 }, inset: 40 });

    void commands
      .ackInjections({ ids: pending.map((injection) => injection.id) })
      .then(() => refreshInjections())
      .catch(() => undefined);
  }, [editor, loaded, injections, commands, refreshInjections]);

  // A thread row dragged out of a list and dropped on the canvas opens that
  // thread's panel where it landed. The drag rides the browser's own transfer
  // (`threadDrag`) because the two ends are a panel's DOM and the tldraw
  // surface under it; anything that is not carrying a thread falls straight
  // through to tldraw's own drop handling.
  const onCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const onCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const threadId = threadIdFromDrop(event.dataTransfer);
      if (threadId === null || editor === null) return;
      event.preventDefault();
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      requestPanel(
        { kind: "thread", entityId: threadId },
        { at: { x: point.x, y: point.y }, focus: false },
      );
    },
    [editor, requestPanel],
  );

  return (
    <div
      className="absolute inset-0"
      data-testid="board-canvas"
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      {licenseSettled ? (
        <Tldraw
          {...licenseProps(license)}
          onMount={setEditor}
          assetUrls={ASSET_URLS}
          colorScheme="system"
          options={TLDRAW_OPTIONS}
          overrides={TLDRAW_OVERRIDES}
          shapeUtils={SHAPE_UTILS}
          components={TLDRAW_COMPONENTS}
          hideUi={toolsHidden || focusedStation !== null}
        />
      ) : null}
      <KanbanBoardProvider editor={editor}>
        <PanelLayer editor={editor} station={focusedStation} />
      </KanbanBoardProvider>
      {licenseSettled && licenseNotice !== null ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[610] flex justify-center px-4">
          <div
            role="alert"
            className={
              licenseNotice.tone === "danger"
                ? "pointer-events-auto flex max-w-xl flex-col gap-2 rounded-lg border border-destructive/50 bg-background p-3 text-xs shadow-lg"
                : "pointer-events-auto flex max-w-xl flex-col gap-2 rounded-lg border border-amber-500/50 bg-background p-3 text-xs shadow-lg"
            }
            data-testid="canvas-license-notice"
          >
            <p className="font-medium text-foreground">{licenseNotice.title}</p>
            <p className="text-muted-foreground">{licenseNotice.detail}</p>
            <div>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 font-medium hover:bg-accent"
                onClick={() => requestStation({ kind: "settings", entityId: "board" })}
              >
                Open canvas setup
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {unreadable ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[600] flex justify-center px-4">
          <div
            className="pointer-events-auto flex max-w-xl flex-col gap-2 rounded-lg border border-destructive/50 bg-background p-3 text-xs shadow-lg"
            data-testid="canvas-unreadable"
          >
            <p className="font-medium text-foreground">This canvas could not be opened.</p>
            <p className="text-muted-foreground">
              The saved document is not one this build can read, so saving is off — nothing you do
              here will overwrite it. Reload after updating, or start over and let the next save
              replace what is stored.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border border-border px-2 py-1 hover:bg-accent"
                onClick={() => globalThis.location.reload()}
              >
                Reload
              </button>
              <button
                type="button"
                className="rounded border border-destructive/50 px-2 py-1 text-destructive hover:bg-destructive/10"
                onClick={startOver}
              >
                Start over
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!licenseSettled || (isPending && document === null) ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
          <span className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground">
            Loading canvas…
          </span>
        </div>
      ) : null}
    </div>
  );
}
