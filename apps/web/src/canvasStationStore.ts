/**
 * canvasStationStore — which station the canvas is parked on.
 *
 * The URL owns this (`/kanban?station=thread:abc`); the store is how a panel
 * deep inside tldraw's shape tree reads it without every shape knowing about
 * the router. One writer: the canvas route syncs it from the search param.
 */
import { create } from "zustand";

import type { FramePresetId } from "./components/canvas/panels/panelFrames";
import {
  sameStation,
  type PanelRef,
  type StationRef,
} from "./components/canvas/panels/panelStations";

/** Where a request was made, in page coordinates — the right-click point. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

interface CanvasStationState {
  /** Null means free roam: pan and zoom, nothing locked. */
  station: StationRef | null;
  setStation: (station: StationRef | null) => void;
  /**
   * A station asked for by a gesture the router cannot see — a double-click
   * handled inside tldraw's tool state machine, which has no hooks and so no
   * `useNavigate`. The route drains this and navigates.
   */
  requested: StationRef | null;
  requestStation: (station: StationRef | null) => void;
  /**
   * A panel somebody asked the canvas to put back — from the command palette,
   * the canvas "Add component" menu, or a file opened out of the explorer. The
   * canvas drains this, creates the panel if it is not already there, and then
   * asks for the station, so adding a panel never leaves `/kanban`.
   * `at` is where the gesture happened — the right-click point — so the panel
   * lands under the pointer instead of at its registry address.
   * `focus` is what separates opening a page from adding one: an *open* — a
   * thread picked out of the list, a file out of the explorer — goes to the
   * station and fills the window, while an *add* drops the panel where you are
   * looking and leaves the camera alone.
   */
  requestedPanel: {
    ref: StationRef;
    at: CanvasPoint | null;
    focus: boolean;
    /**
     * Open it beside this panel, inside whatever frame that one is standing in.
     * How a list opens the thing it lists without the new page landing on the
     * far side of the canvas: a thread picked out of the Agents frame's list
     * belongs in the Agents frame.
     */
    near: PanelRef | null;
  } | null;
  requestPanel: (
    panel: StationRef | null,
    options?: {
      readonly at?: CanvasPoint;
      readonly focus?: boolean;
      readonly near?: PanelRef;
    },
  ) => void;
  /**
   * A frame preset somebody asked the canvas to drop in, at the request point
   * when there is one and the middle of the viewport when there is not. Same
   * drain-and-create loop as `requestedPanel`.
   *
   * `focus` is what separates a frame drawn where you are looking from one you
   * asked for from the header or the palette: a right-click drops the rectangle
   * under the pointer and leaves the camera alone, while an add made from the
   * app's own chrome has to take you to what it just made — on a phone the new
   * frame is otherwise somewhere off screen behind the page you are reading.
   */
  requestedFrame: { preset: FramePresetId; at: CanvasPoint | null; focus: boolean } | null;
  requestFrame: (
    preset: FramePresetId | null,
    options?: { readonly at?: CanvasPoint; readonly focus?: boolean },
  ) => void;
}

export const useCanvasStationStore = create<CanvasStationState>()((set, get) => ({
  station: null,
  setStation: (station) => {
    if (sameStation(get().station, station)) return;
    set({ station });
  },
  requested: null,
  requestStation: (station) => set({ requested: station }),
  requestedPanel: null,
  requestPanel: (panel, options) =>
    set({
      requestedPanel:
        panel === null
          ? null
          : {
              ref: panel,
              at: options?.at ?? null,
              focus: options?.focus ?? true,
              near: options?.near ?? null,
            },
    }),
  requestedFrame: null,
  requestFrame: (preset, options) =>
    set({
      requestedFrame:
        preset === null
          ? null
          : { preset, at: options?.at ?? null, focus: options?.focus ?? false },
    }),
}));
