import {
  DefaultContextMenu,
  DefaultContextMenuContent,
  type TLImageShape,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  type TLShape,
  type TLShapeId,
  type TLUiContextMenuProps,
  useDialogs,
  useEditor,
  useValue,
} from "tldraw";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useCanvasStationStore, type CanvasPoint } from "../../../canvasStationStore";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { describeCapturePickup } from "../../../lib/hermesChip";
import { useKanbanCards, useKanbanCommands } from "../../../state/kanban";
import { KANBAN_COMPOSER_DRAFT_ID } from "../../kanban/PromptHistoryButton";
import { toastManager } from "../../ui/toast";
import { GenerateImageDialog, runRemoveBackground } from "../CanvasImageTools";
import {
  closableStations,
  closeLabel,
  countedLabel,
  frameForSelection,
  openableStation,
  promptCardTitle,
  selectionPromptText,
  type CanvasSelectionShape,
  type FramedSelectionShape,
  type SelectedStation,
} from "./canvasContextActions";
import { addFrameEntries, addPanelEntries } from "./addMenu";
import {
  FRAME_SHAPE_TYPE,
  frameHolding,
  frameLabel,
  frameSelection,
  setShapesLockedIntoFrame,
  type T3FrameShape,
} from "./FrameShapeUtil";
import { panelLabel } from "./panelLabels";

import { closePanel, panelShapes, PANEL_SHAPE_TYPE, type T3PanelShape } from "./PanelShapeUtil";
import { nextColumnId } from "./boardColumns";

/**
 * The canvas right-click menu: tldraw's own, plus what this board can do with
 * what you right-clicked.
 *
 * tldraw's `DefaultContextMenu` renders its default content *only* when it is
 * given no children, so everything stock — cut, copy, paste, duplicate, delete,
 * arrange, reorder, export — is re-rendered here rather than replaced by the
 * board's items.
 *
 * The board's own half is the selection (send it to Hermes, open it in the
 * composer), the panels in it (go there, close them) and the pages you can put
 * back on the canvas. Adding a panel leaves the request in `canvasStationStore`
 * for {@link BoardCanvas} to materialize — the board is home, so nothing here
 * navigates off it. Every request carries the point that was right-clicked, so
 * what you add lands under the pointer.
 */
export function CanvasContextMenu(props: TLUiContextMenuProps) {
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);
  const requestFrame = useCanvasStationStore((state) => state.requestFrame);
  const requestStation = useCanvasStationStore((state) => state.requestStation);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { environmentId, hermes, refresh } = useKanbanCards();
  const { createCard } = useKanbanCommands(environmentId);
  const editor = useEditor();
  // The pointer stops moving over the canvas the moment the menu opens, so the
  // current page point *is* the right-click point by the time an item fires.
  const pointAt = (): CanvasPoint => {
    const point = editor.inputs.currentPagePoint;
    return { x: point.x, y: point.y };
  };
  const { addDialog } = useDialogs();
  /** Every column id on the canvas — what a fresh column has to avoid. */
  const columnIds = (): ReadonlyArray<string> =>
    [...panelShapes(editor).values()]
      .filter((entry) => entry.ref.kind === "column")
      .map((entry) => entry.ref.entityId);
  const selectedImages = useValue(
    "selected image shapes",
    () =>
      editor.getSelectedShapes().filter((shape): shape is TLImageShape => shape.type === "image"),
    [editor],
  );
  const selection = useValue<ReadonlyArray<CanvasSelectionShape>>(
    "canvas menu selection",
    () =>
      editor.getSelectedShapes().map((shape) => ({
        id: shape.id,
        text: editor.getShapeUtil(shape).getText(shape),
        station: stationOf(shape),
      })),
    [editor],
  );

  // Frames are left out: a frame around a frame is a screen inside a screen,
  // and neither one can be moved on its own after that.
  const framable = useValue<ReadonlyArray<FramedSelectionShape>>(
    "canvas menu frame membership",
    () =>
      editor
        .getSelectedShapes()
        .filter((shape) => shape.type !== FRAME_SHAPE_TYPE)
        .map((shape) => {
          const frame = frameHolding(editor, shape.id);
          return {
            id: shape.id,
            frame: frame === null ? null : { id: frame.id, label: frameLabel(frame) },
            lockedIn: frame !== null && frame.props.members.includes(shape.id),
          };
        }),
    [editor],
  );
  const inFrame = frameForSelection(framable);

  const promptText = selectionPromptText(selection);
  const toOpen = openableStation(selection);
  const toClose = closableStations(selection);

  const sendToHermes = async () => {
    try {
      const result = await createCard({
        title: promptCardTitle(promptText),
        body: promptText,
        at: "prompts",
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      refresh();
      toastManager.add({
        type: "success",
        title: "Sent to Hermes",
        description: describeCapturePickup(hermes),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not send that to Hermes",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      toastManager.add({ type: "success", title: "Copied the selection's text" });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not copy that",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  return (
    <DefaultContextMenu {...props}>
      {promptText.length > 0 ? (
        <TldrawUiMenuGroup id="t3-selection">
          <TldrawUiMenuItem
            id="t3-send-to-hermes"
            label="Send to Hermes"
            onSelect={() => void sendToHermes()}
          />
          <TldrawUiMenuItem
            id="t3-send-as-prompt"
            label="Send as prompt…"
            onSelect={() => {
              setPrompt(KANBAN_COMPOSER_DRAFT_ID, promptText);
              requestStation({ kind: "composer", entityId: "" });
            }}
          />
          <TldrawUiMenuItem id="t3-copy-text" label="Copy text" onSelect={() => void copyText()} />
        </TldrawUiMenuGroup>
      ) : null}
      {toOpen !== null || toClose.length > 0 ? (
        <TldrawUiMenuGroup id="t3-station">
          {toOpen !== null ? (
            <TldrawUiMenuItem
              id="t3-open-station"
              label={`Go to ${toOpen.label}`}
              onSelect={() => requestStation(toOpen.ref)}
            />
          ) : null}
          {toClose.length > 0 ? (
            <TldrawUiMenuItem
              id="t3-close-station"
              label={closeLabel(toClose)}
              onSelect={() => {
                for (const shape of toClose) closePanel(editor, shape.id as TLShapeId);
              }}
            />
          ) : null}
        </TldrawUiMenuGroup>
      ) : null}
      {framable.length > 0 ? (
        <TldrawUiMenuGroup id="t3-frame-contents">
          <TldrawUiMenuItem
            id="t3-frame-selection"
            label={countedLabel("Frame", "shape", framable.length)}
            onSelect={() => {
              const id = frameSelection(
                editor,
                framable.map((shape) => shape.id as TLShapeId),
              );
              if (id !== null) editor.select(id);
            }}
          />
          {inFrame === null ? null : (
            <TldrawUiMenuItem
              id="t3-lock-into-frame"
              label={
                inFrame.locked ? `Release from ${inFrame.label}` : `Lock into ${inFrame.label}`
              }
              onSelect={() =>
                setShapesLockedIntoFrame(
                  editor,
                  inFrame.frameId as TLShapeId,
                  inFrame.shapeIds as ReadonlyArray<TLShapeId>,
                  !inFrame.locked,
                )
              }
            />
          )}
        </TldrawUiMenuGroup>
      ) : null}
      <DefaultContextMenuContent />
      <TldrawUiMenuGroup id="t3-image-tools">
        <TldrawUiMenuItem
          id="t3-generate-image"
          label="Generate image…"
          onSelect={() => {
            addDialog({ component: GenerateImageDialog });
          }}
        />
        {selectedImages.length > 0 ? (
          <TldrawUiMenuItem
            id="t3-remove-background"
            label={countedLabel("Remove", "background", selectedImages.length)}
            onSelect={() => runRemoveBackground(editor, selectedImages)}
          />
        ) : null}
      </TldrawUiMenuGroup>
      <TldrawUiMenuGroup id="t3-add-component">
        <TldrawUiMenuSubmenu id="t3-add-component-submenu" label="Add component">
          {addPanelEntries().map((entry) => (
            <TldrawUiMenuItem
              key={entry.kind}
              id={`t3-add-${entry.kind}`}
              label={entry.label}
              onSelect={() =>
                requestPanel(
                  // A column is a component with an address of its own, so
                  // adding one mints an id rather than opening "the" column.
                  {
                    kind: entry.kind,
                    entityId: entry.kind === "column" ? nextColumnId(columnIds()) : "",
                  },
                  { at: pointAt(), focus: false },
                )
              }
            />
          ))}
        </TldrawUiMenuSubmenu>
        <TldrawUiMenuSubmenu id="t3-add-frame-submenu" label="Add frame">
          {addFrameEntries().map((entry) => (
            <TldrawUiMenuItem
              key={entry.preset}
              id={`t3-add-frame-${entry.preset}`}
              label={`${entry.label} · ${entry.detail}`}
              onSelect={() => requestFrame(entry.preset, { at: pointAt() })}
            />
          ))}
        </TldrawUiMenuSubmenu>
      </TldrawUiMenuGroup>
      <TldrawUiMenuGroup id="t3-view">
        {selection.length > 0 ? (
          <TldrawUiMenuItem
            id="t3-zoom-to-selection"
            label="Zoom to selection"
            onSelect={() => {
              editor.zoomToSelection();
            }}
          />
        ) : null}
        <TldrawUiMenuItem
          id="t3-zoom-to-fit"
          label="Zoom to fit"
          onSelect={() => {
            editor.zoomToFit();
          }}
        />
      </TldrawUiMenuGroup>
    </DefaultContextMenu>
  );
}

/** The place a shape *is*, when it is one: a page, or a screen of pages. */
function stationOf(shape: TLShape): SelectedStation | undefined {
  if (shape.type === PANEL_SHAPE_TYPE) {
    const panel = shape as T3PanelShape;
    return {
      ref: { kind: panel.props.kind, entityId: panel.props.entityId },
      label: panelLabel(panel.props.kind, panel.props.entityId),
    };
  }
  if (shape.type === FRAME_SHAPE_TYPE) {
    const frame = shape as T3FrameShape;
    return { ref: { kind: "frame", entityId: frame.id }, label: frameLabel(frame) };
  }
  return undefined;
}
