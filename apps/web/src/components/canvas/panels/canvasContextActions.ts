/**
 * What the canvas right-click menu can do with a selection, minus React.
 *
 * The menu itself ({@link CanvasContextMenu}) is tldraw hooks and JSX; the
 * decisions it makes — is there anything here worth sending, what does the card
 * get called, which of these stations can actually be closed — are here so a
 * node test can hold them.
 *
 * @module components/canvas/panels/canvasContextActions
 */

import { isPanelClosable } from "./panelRegistry";
import type { StationRef } from "./panelStations";

/** A station the selection is holding: a page (`t3-panel`) or a screen (`t3-frame`). */
export interface SelectedStation {
  readonly ref: StationRef;
  /** What it is called on its own title bar. */
  readonly label: string;
}

/** One selected shape, reduced to what the menu reasons about. */
export interface CanvasSelectionShape {
  readonly id: string;
  /** The shape's own text, from its util. Absent on shapes that carry none. */
  readonly text?: string | undefined;
  /** Set when the shape is a place on the canvas rather than drawing. */
  readonly station?: SelectedStation | undefined;
}

type StationShape = CanvasSelectionShape & { readonly station: SelectedStation };

/**
 * The prompt a selection makes: every shape's text, in selection order, blank
 * ones dropped. Stations contribute nothing — a thread's window is not a prompt.
 */
export function selectionPromptText(shapes: ReadonlyArray<CanvasSelectionShape>): string {
  return shapes
    .map((shape) => (shape.station === undefined ? (shape.text ?? "").trim() : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

const TITLE_LIMIT = 120;

/** A card's title: the prompt's first real line, clipped to the board's width. */
export function promptCardTitle(body: string): string {
  const line = body
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return "";
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

/** The stations in a selection — what the station group's items act on. */
export function selectedStations(
  shapes: ReadonlyArray<CanvasSelectionShape>,
): ReadonlyArray<StationShape> {
  return shapes.filter((shape): shape is StationShape => shape.station !== undefined);
}

/**
 * The stations this selection may close. A screen is always closable; home's
 * panels never are, so a selection of nothing but columns offers no close item
 * at all rather than one that quietly does half the job.
 */
export function closableStations(
  shapes: ReadonlyArray<CanvasSelectionShape>,
): ReadonlyArray<StationShape> {
  return selectedStations(shapes).filter(
    (shape) => shape.station.ref.kind === "frame" || isPanelClosable(shape.station.ref.kind),
  );
}

/** The one station a "go there" item can mean. Two stations have no one place. */
export function openableStation(
  shapes: ReadonlyArray<CanvasSelectionShape>,
): SelectedStation | null {
  const stations = selectedStations(shapes);
  return stations.length === 1 ? stations[0]!.station : null;
}

/** "Close Terminal" for one, "Close 3 stations" for a pile of them. */
export function closeLabel(stations: ReadonlyArray<StationShape>): string {
  const only = stations.length === 1 ? stations[0]!.station.label : null;
  return only === null ? `Close ${stations.length} stations` : `Close ${only}`;
}

/** One selected shape and the frame carrying it, as the lock items see it. */
export interface FramedSelectionShape {
  readonly id: string;
  /** The frame carrying it right now, or null when nothing is. */
  readonly frame: { readonly id: string; readonly label: string } | null;
  /** Whether a human has locked it into that frame rather than left it to geometry. */
  readonly lockedIn: boolean;
}

export interface SelectionInFrame {
  readonly frameId: string;
  readonly label: string;
  readonly shapeIds: ReadonlyArray<string>;
  /** True once every selected shape is locked in — so the item reads "Release". */
  readonly locked: boolean;
}

/**
 * The one frame a whole selection is standing in, if there is one.
 *
 * All of it or none: a "Lock into Checkout flow" that quietly skipped the half
 * of the selection standing somewhere else is worse than no item at all.
 */
export function frameForSelection(
  shapes: ReadonlyArray<FramedSelectionShape>,
): SelectionInFrame | null {
  const first = shapes[0];
  if (first === undefined || first.frame === null) return null;
  if (shapes.some((shape) => shape.frame?.id !== first.frame?.id)) return null;
  return {
    frameId: first.frame.id,
    label: first.frame.label,
    shapeIds: shapes.map((shape) => shape.id),
    locked: shapes.every((shape) => shape.lockedIn),
  };
}

/** "Remove background" / "Remove 2 backgrounds" — never "Remove 1 backgrounds". */
export function countedLabel(verb: string, noun: string, count: number): string {
  return count === 1 ? `${verb} ${noun}` : `${verb} ${count} ${noun}s`;
}
