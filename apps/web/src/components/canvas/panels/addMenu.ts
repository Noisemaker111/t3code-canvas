/**
 * What "add" offers, in one list — and where what you add lands.
 *
 * Three surfaces ask the same question: the canvas right-click menu, the
 * command palette, and the Add button in the board header. They used to answer
 * it three times, and the palette's answer was a hand-written trio of screen
 * frames — so `Cmd-K` → "frame" offered Desktop, Mobile and Frame while the
 * canvas menu offered Kanban, Agents and IDE beside them. The IDE frame was
 * shipped and unreachable from the keyboard.
 *
 * So the list is data here and the surfaces render it. Nothing in this module
 * draws or creates anything: an entry is a request the canvas already knows how
 * to serve (`canvasStationStore`).
 *
 * @module components/canvas/panels/addMenu
 */

import { frameLayout } from "./frameLayouts";
import {
  FRAME_ADDABLE_PRESET_IDS,
  FRAME_HEADER_HEIGHT,
  framePreset,
  frameSizeLabel,
  presetLayoutId,
  type FramePresetId,
} from "./panelFrames";
import { ADDABLE_PANEL_KINDS, panelManifest, type PanelKind } from "./panelRegistry";
import type { Box, StationRef } from "./panelStations";

/** A component you can put on the canvas. */
export interface AddPanelEntry {
  readonly type: "panel";
  readonly kind: PanelKind;
  readonly label: string;
}

/** A frame you can drop on the canvas — empty, or with a composition in it. */
export interface AddFrameEntry {
  readonly type: "frame";
  readonly preset: FramePresetId;
  readonly label: string;
  /** One line: what standing in this frame gets you, or the screen it is. */
  readonly detail: string;
}

export function addPanelEntries(): ReadonlyArray<AddPanelEntry> {
  return ADDABLE_PANEL_KINDS.map((kind) => ({
    type: "panel",
    kind,
    label: panelManifest(kind).label,
  }));
}

/**
 * The frames, each with the line that says what it is.
 *
 * A laid-out frame reads its own summary — that is what `FrameLayout.summary`
 * was written for. A screen frame reads its size, because that is the whole of
 * what it is. The empty one says it is empty: "how do I make a layout that is
 * not the kanban or the IDE" is answered by the row that starts you one.
 */
export function addFrameEntries(): ReadonlyArray<AddFrameEntry> {
  return FRAME_ADDABLE_PRESET_IDS.map((preset) => {
    const spec = framePreset(preset);
    const layout = presetLayoutId(preset);
    return {
      type: "frame",
      preset,
      label: spec.label,
      detail:
        layout !== null
          ? frameLayout(layout).summary
          : preset === "custom"
            ? "Empty — add components into it"
            : frameSizeLabel({ w: spec.size.w, h: spec.size.h - FRAME_HEADER_HEIGHT }),
    };
  });
}

/** Where a request made from the header goes, and whether the camera follows. */
export interface AddPlacement {
  /** The point to centre it on, in page coordinates. Null means "you decide". */
  readonly at: { readonly x: number; readonly y: number } | null;
  /** Whether to go to what was added, rather than leave it where it landed. */
  readonly focus: boolean;
}

/**
 * Where a component added from the header lands.
 *
 * Standing in a frame, it joins that frame: the header is the only add surface
 * a phone has and the only one with no pointer behind it, so "add a Terminal
 * while I am looking at my IDE" has to mean the terminal appears in the IDE
 * rather than at its own address on the far side of the canvas. That is also
 * the whole of how a composition of your own gets built — drop an empty frame,
 * go to it, add components.
 *
 * Anywhere else there is no composition to join, so the component becomes the
 * page you are on. On a phone that is the only readable outcome: one page,
 * full window.
 */
export function addPanelPlacement(input: {
  readonly station: StationRef | null;
  /** The focused frame's content area, when a frame is where you are. */
  readonly frameContent: Box | null;
}): AddPlacement {
  const content = input.station?.kind === "frame" ? input.frameContent : null;
  if (content === null) return { at: null, focus: true };
  return {
    at: { x: content.x + content.w / 2, y: content.y + content.h / 2 },
    focus: false,
  };
}
