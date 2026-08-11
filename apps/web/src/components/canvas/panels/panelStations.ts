/**
 * Stations — the addressable places on one canvas.
 *
 * The canvas is the app. The board, Hermes, a live thread and settings are
 * panels parked at fixed page coordinates, and "going to a page" is moving the
 * camera onto one. This module is the half of that with no React and no tldraw
 * in it: what a station is called, where its panel sits, how far the camera has
 * to zoom to look at it, and when a panel is close enough to be worth handing
 * the pointer to. What each kind *is* lives in `panelRegistry`.
 *
 * @module components/canvas/panels/panelStations
 */

import { SEED_COLUMN_IDS } from "./boardColumns";
import { owningThreadId } from "./panelThreadScope";
import {
  PANEL_KINDS,
  PANEL_SIZE,
  panelManifest,
  panelSize,
  panelReapable,
  type PanelKind,
} from "./panelRegistry";

export { PANEL_KINDS, PANEL_SIZE, type PanelKind };

/**
 * What a station can be: a panel kind, or a frame — a bordered region of the
 * canvas, which the camera flies to like any page.
 */
export type StationKind = PanelKind | "frame";

/** A panel on the canvas: a kind, plus which one when there are many. */
export interface PanelRef {
  readonly kind: PanelKind;
  /**
   * Thread id for `thread`, settings section for `settings`, a
   * `specimen#state` address for an exploded `dev` panel, else empty.
   */
  readonly entityId: string;
}

/** A place on the canvas: a panel, or a frame by its shape id. */
export interface StationRef {
  readonly kind: StationKind;
  readonly entityId: string;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Gap between two column panels. Tighter than {@link GUTTER}: one region. */
const COLUMN_GUTTER = 26;

/**
 * The column row is sized to the old board's footprint so a migrated canvas
 * keeps Hermes/settings/threads clear of the kanban region without moving.
 *
 * Four is the *reserve*, not the count: a board's columns are settings now, and
 * a fifth queues up to the right of this without disturbing anything parked
 * around the region.
 */
const COLUMN_ROW_W = 350 * 4 + COLUMN_GUTTER * 3;

/** Where the nth column panel stands, left to right. */
export function columnRowX(index: number): number {
  return index * (panelSize("column").w + COLUMN_GUTTER);
}

/** How wide a row of this many columns is. */
export function columnRowWidth(count: number): number {
  return count <= 0 ? 0 : columnRowX(count - 1) + panelSize("column").w;
}

/**
 * The kanban region's own footprint: the column row, and the composer under it.
 * The Board frame is a border drawn around exactly this — the panels keep their
 * authored sizes, so the frame never stretches one to fill itself.
 */
export const KANBAN_REGION_SIZE = {
  w: COLUMN_ROW_W,
  h: panelSize("column").h + COLUMN_GUTTER + panelSize("composer").h,
} as const;

/** Gap between the fixed panels and between thread panels in the row. */
const GUTTER = 80;

/**
 * A frame's own title bar. Above the border, and never a drop target.
 *
 * Here rather than in `panelFrames` because the placement table has to leave
 * room for it: a frame's chrome is part of how far apart two regions stand.
 */
export const FRAME_HEADER_HEIGHT = 32;

/** Room between a frame's border and the panels standing inside it. */
export const FRAME_PADDING = 32;

/**
 * The panels sit above the origin because drawings land from (0, 0) downward
 * and rightward forever. Drawing space is below; the app's own pages are the
 * band above it.
 */
// -2600, not -2000: the thread row and the tallest panel standing on it reach
// 2124 below the band's top, and the lane's frame another 32 under that. At
// -2000 that crossed the origin into the drawing space.
const PANEL_BAND_Y = -2_600;

/**
 * The thread row sits under the board so panning down reads as "the work".
 *
 * Measured off the kanban region and the two frames' chrome, not off a panel
 * height: the Board frame's bottom padding, the Thread lane's top padding and
 * the lane's own title bar all stand in the gap. Sized to `board.h` — the
 * legacy monolithic panel the reconciler reaps — the lane's border came out
 * *above* the composer and drew through it.
 */
const THREAD_ROW_Y =
  PANEL_BAND_Y + KANBAN_REGION_SIZE.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT + GUTTER;

export function stationKey(ref: StationRef): string {
  return ref.entityId.length === 0 ? ref.kind : `${ref.kind}:${ref.entityId}`;
}

/**
 * Which panel a station lands on. A kind the registry marks `instances` gets
 * one panel per id — a station like `settings:hermes` is the settings panel
 * opened at a section, not a second settings panel, so the camera has somewhere
 * to go either way. `dev` with no id is the gallery index, one panel like the
 * rest.
 */
export function panelIdentity(ref: StationRef): string {
  if (ref.kind === "frame") return `frame:${ref.entityId}`;
  const instanced = panelManifest(ref.kind).instances === "instances";
  return instanced && ref.entityId.length > 0 ? `${ref.kind}:${ref.entityId}` : ref.kind;
}

/** Whether a station is looking at this panel — `settings:hermes` at settings. */
export function isPanelStation(station: StationRef | null, ref: StationRef | null): boolean {
  if (station === null || ref === null) return station === ref;
  return panelIdentity(station) === panelIdentity(ref);
}

export function parseStationKey(raw: string | null | undefined): StationRef | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const separator = raw.indexOf(":");
  const kind = separator === -1 ? raw : raw.slice(0, separator);
  const entityId = separator === -1 ? "" : raw.slice(separator + 1);
  if (kind === "frame") return entityId.length === 0 ? null : { kind, entityId };
  if (!(PANEL_KINDS as ReadonlyArray<string>).includes(kind)) return null;
  return { kind: kind as PanelKind, entityId };
}

export function sameStation(a: StationRef | null, b: StationRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.entityId === b.entityId;
}

/**
 * Where a panel lives. Fixed kinds get a fixed address so a bookmarked camera
 * still lands on the same thing after a reload; thread panels queue up in a row
 * under the board, in the order the board hands them over.
 */
export function panelPlacement(ref: StationRef, slot = 0): Box {
  // A frame is placed where it was drawn, never by this table.
  if (ref.kind === "frame") throw new Error("panelPlacement: a frame is not a placed panel");
  const size = panelSize(ref.kind);
  switch (ref.kind) {
    case "board":
      return { x: 0, y: PANEL_BAND_Y, ...size };
    // Which column this is comes from the caller's slot: the board's columns are
    // settings, so this module cannot know the order without being handed it.
    case "column":
      return { x: columnRowX(slot), y: PANEL_BAND_Y, ...size };
    case "composer":
      // Centered under the column row, like the capture bar it replaces.
      return {
        x: Math.round((COLUMN_ROW_W - panelSize("composer").w) / 2),
        y: PANEL_BAND_Y + panelSize("column").h + COLUMN_GUTTER,
        ...size,
      };
    case "hermes":
      return { x: panelSize("board").w + GUTTER, y: PANEL_BAND_Y, ...size };
    case "settings":
      return { x: -(panelSize("settings").w + GUTTER), y: PANEL_BAND_Y, ...size };
    case "thread":
      return { x: slot * (panelSize("thread").w + GUTTER), y: THREAD_ROW_Y, ...size };
    // Removed. A leftover shape from an older snapshot still has to be given an
    // address to stand at for the one pass that reaps it.
    case "dev":
      return { x: RIGHT_BAND_X, y: PANEL_BAND_Y, ...size };
    // The workspace kinds live left of settings, away from the kanban region
    // and the thread row: a terminal opened over the board would land on the
    // columns, and the first thing you would do is drag it off them.
    case "terminal":
      return { x: -(panelSize("terminal").w + GUTTER), y: THREAD_ROW_Y, ...size };
    // The thread list parks above the band beside the editor row, clear of the
    // leftward browser and explorer queues below.
    case "threads":
      return {
        x: EDITOR_X - (panelSize("threads").w + GUTTER),
        y: PANEL_BAND_Y - 200 - panelSize("threads").h,
        ...size,
      };
    // Browser panels queue leftward from the terminal on the thread row. A row
    // *below* the threads put them past y 0, on top of the drawing space.
    case "browser":
      return {
        x: -(panelSize("terminal").w + GUTTER) - (slot + 1) * (panelSize("browser").w + GUTTER),
        y: THREAD_ROW_Y,
        ...size,
      };
    case "explorer":
      return {
        x: EXPLORER_X - slot * (panelSize("explorer").w + GUTTER),
        y: PANEL_BAND_Y,
        ...size,
      };
    case "editor":
      return {
        x: EDITOR_X + slot * (panelSize("editor").w + GUTTER),
        y: PANEL_BAND_Y - GUTTER - panelSize("editor").h,
        ...size,
      };
    // Git panels get a row of their own above the editors — one per working
    // tree. Queuing them beside the explorers would have two kinds growing
    // leftward on the same line, which is the collision the editor row exists
    // to avoid.
    case "git":
      return {
        x: EDITOR_X + slot * (panelSize("git").w + GUTTER),
        y: PANEL_BAND_Y - GUTTER * 2 - panelSize("editor").h - panelSize("git").h,
        ...size,
      };
    // Review lists queue up rightward on the thread row, past Hermes: one panel
    // per repo binding, beside the threads the pull requests came out of.
    case "prs":
      return { x: RIGHT_BAND_X + slot * (panelSize("prs").w + GUTTER), y: THREAD_ROW_Y, ...size };
    // Issue lists share the thread row but start past the review lists' own
    // reserve: a second row under them would cross into the drawing space at
    // y 0, so the two grow along one line with a gap between their starts.
    case "issues":
      return {
        x:
          RIGHT_BAND_X +
          PRS_ROW_RESERVE * (panelSize("prs").w + GUTTER) +
          slot * (panelSize("issues").w + GUTTER),
        y: THREAD_ROW_Y,
        ...size,
      };
    default:
      // A kind this build has no station for still has to land somewhere it can
      // be seen and dragged off. It goes where a fresh panel goes.
      return { x: 0, y: PANEL_BAND_Y, ...size };
  }
}

/** Explorers queue up leftward from the far side of settings. */
const EXPLORER_X = -(panelSize("settings").w + GUTTER) - (panelSize("explorer").w + GUTTER);

/**
 * Editors get their own row *above* the panel band rather than beside the
 * explorers: both kinds grow one panel per open thing, and two rows growing on
 * the same line meet.
 */
const EDITOR_X = -(panelSize("settings").w + GUTTER) - panelSize("editor").w;

/** The kinds whose panels make up the kanban region `?station=board` flies to. */
export function isKanbanRegionKind(kind: PanelKind): boolean {
  return kind === "column" || kind === "composer";
}

/** Smallest box holding every given box. Null when there are none. */
export function unionBoxes(boxes: ReadonlyArray<Box>): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The far side of the band: where the rows past Hermes start. */
const RIGHT_BAND_X = panelSize("board").w + GUTTER + panelSize("hermes").w + GUTTER;

/**
 * How much of the thread row the review lists get before the issue lists start.
 * Two repos' worth; a third queues past the issues, which {@link nextFreeSlot}
 * then steps over.
 */
const PRS_ROW_RESERVE = 2;

/** Where a panel dropped at a point lands: under the pointer, held by its bar. */
export function panelPlacementAt(
  point: { readonly x: number; readonly y: number },
  kind: PanelKind,
): Box {
  const size = panelSize(kind);
  return { x: point.x - size.w / 2, y: point.y - 16, ...size };
}

/** Whether two boxes share any area. Touching edges do not count. */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** How far a search for free space walks before it gives up and stacks. */
const FREE_SPACE_RINGS = 8;

/**
 * The wanted box, or the nearest empty one to it.
 *
 * Every rule above says where a panel *belongs* — under the pointer, beside the
 * one that opened it, at its address in the band. None of them know what is
 * already standing there, so a second panel opened the same way landed on top
 * of the first. This is the last pass over all of them: keep the intended spot
 * when it is free, otherwise step out through the grid the panel's own size
 * makes and take the closest cell that is clear.
 *
 * Falls back to the wanted box when the neighbourhood is full — a panel put
 * somewhere you can see, even stacked, beats one flung off the canvas.
 */
export function clearOfPanels(wanted: Box, occupied: ReadonlyArray<Box>, gap = GUTTER): Box {
  const free = (box: Box): boolean => !occupied.some((other) => boxesOverlap(box, other));
  if (free(wanted)) return wanted;
  const stepX = wanted.w + gap;
  const stepY = wanted.h + gap;
  for (let ring = 1; ring <= FREE_SPACE_RINGS; ring += 1) {
    // Along the line first, and rightward before leftward: every kind that
    // queues on this canvas queues sideways, and a panel pushed down off the
    // thread row walks toward the drawing space instead of joining the row.
    for (const row of ringOffsets(ring)) {
      for (const column of ringOffsets(ring)) {
        // Only the ring's edge: everything inside it failed on an earlier pass.
        if (Math.max(Math.abs(column), Math.abs(row)) !== ring) continue;
        const box = { ...wanted, x: wanted.x + column * stepX, y: wanted.y + row * stepY };
        if (free(box)) return box;
      }
    }
  }
  return wanted;
}

/** A ring's offsets on one axis: nearest the middle first, forward before back. */
function ringOffsets(ring: number): ReadonlyArray<number> {
  const offsets: Array<number> = [0];
  for (let step = 1; step <= ring; step += 1) offsets.push(step, -step);
  return offsets;
}

/**
 * How much of the screen a panel is, 0 (gone) to 1 (all of it).
 *
 * Two terms, because either alone gets a real case wrong. How large it looks
 * takes the *longer* axis: a tall narrow thread panel centred in a wide window
 * fills the screen to a reader while covering under half its area. How much of
 * it is actually there takes the *shorter*: a panel hanging off the edge with
 * one strip showing is full height and still not what you are looking at.
 */
export function panelPresence(panel: Box, viewport: Box): number {
  const width =
    Math.min(panel.x + panel.w, viewport.x + viewport.w) - Math.max(panel.x, viewport.x);
  const height =
    Math.min(panel.y + panel.h, viewport.y + viewport.h) - Math.max(panel.y, viewport.y);
  if (width <= 0 || height <= 0) return 0;
  if (viewport.w <= 0 || viewport.h <= 0) return 0;
  const size = Math.max(width / viewport.w, height / viewport.h);
  // Normalized by what could fit, so zooming past the window edge still counts.
  const shown = Math.min(
    width / Math.min(panel.w, viewport.w),
    height / Math.min(panel.h, viewport.h),
  );
  return Math.min(1, size * shown);
}

/**
 * Past this much of the screen, a panel is what you are looking at.
 *
 * Deliberately below half: the old bar meant a panel you had already zoomed
 * onto still refused clicks and scrolls until it nearly filled the window,
 * which read as the canvas eating your input rather than gating it.
 */
export const LIVE_PRESENCE = 0.35;

/**
 * Whether a panel gets the pointer. Zooming is the whole gesture: once a panel
 * dominates the screen it behaves like the page it is, and zooming back out
 * hands the pointer to the canvas so the same drag draws instead of clicking.
 * Anything but the select tool stays a drawing gesture — the pen has to work
 * over the board, not inside it. A focused panel is the page, full stop.
 */
export function isPanelLive(input: {
  readonly presence: number;
  readonly isEditing: boolean;
  readonly toolId: string;
  readonly focused?: boolean;
}): boolean {
  if (input.focused === true) return true;
  if (input.isEditing) return true;
  if (input.toolId !== "select") return false;
  return input.presence >= LIVE_PRESENCE;
}

/**
 * The room tldraw's own UI needs, in screen pixels: the menu row along the top,
 * the style panel down the right, the toolbar across the bottom. A station that
 * ignores this parks the panel under the colour picker, and the drawing tools
 * stop being reachable while you are on a page.
 */
export interface ChromeReserve {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const CHROME_RESERVE: ChromeReserve = { top: 52, right: 196, bottom: 84, left: 8 };

/** With the tools put away there is no chrome to dodge — just a margin. */
export const BARE_RESERVE: ChromeReserve = { top: 16, right: 16, bottom: 16, left: 16 };

/**
 * tldraw drops the style panel and the menu row into popovers below this width,
 * so the desktop reserve holds back a strip that is not there — 196px of a
 * 390px phone, more than half the screen, kept clear for furniture that moved.
 */
export const MOBILE_CHROME_MAX_WIDTH = 700;

/** Only the toolbar is still a fixed strip on a phone, and it is at the bottom. */
export const MOBILE_RESERVE: ChromeReserve = { top: 8, right: 8, bottom: 96, left: 8 };

/** Which reserve a camera move has to dodge on the screen it is moving on. */
export function chromeReserve(input: {
  readonly screenWidth: number;
  readonly toolsHidden: boolean;
}): ChromeReserve {
  if (input.toolsHidden) return BARE_RESERVE;
  return input.screenWidth < MOBILE_CHROME_MAX_WIDTH ? MOBILE_RESERVE : CHROME_RESERVE;
}

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where the camera goes to look at a station: the panel centred in what is left
 * of the window after tldraw's chrome, never blown up past 1:1 — a panel
 * scaled beyond its authored size is just soft text.
 *
 * Focusing a station no longer *is* this camera move — a focused panel is drawn
 * at full window size outside the canvas transform. This is where you land when
 * you leave focus, so the panel you were on is still the thing in front of you.
 */
export function stationCamera(
  panel: Box,
  screen: { readonly w: number; readonly h: number },
  reserve: ChromeReserve = CHROME_RESERVE,
): Camera {
  const availableW = Math.max(120, screen.w - reserve.left - reserve.right);
  const availableH = Math.max(120, screen.h - reserve.top - reserve.bottom);
  const z = Math.max(0.1, Math.min(1, availableW / panel.w, availableH / panel.h));
  // tldraw maps a page point to the screen as `(page + camera) * z`.
  const screenX = reserve.left + (availableW - panel.w * z) / 2;
  const screenY = reserve.top + (availableH - panel.h * z) / 2;
  return { x: screenX / z - panel.x, y: screenY / z - panel.y, z };
}

/**
 * Where a page-space box lands on screen, in CSS pixels.
 *
 * The panels are real DOM outside tldraw's own transform (see `PanelLayer`), so
 * something has to redo the mapping tldraw applies to its shape layer.
 */
export function screenBox(box: Box, camera: Camera): Box {
  return {
    x: (box.x + camera.x) * camera.z,
    y: (box.y + camera.y) * camera.z,
    w: box.w * camera.z,
    h: box.h * camera.z,
  };
}

/**
 * Which panels the canvas must be holding right now, whatever the human did:
 * the capture composer, one per thread the board is running, one per live
 * browser tab — and one per column id the caller says has cards in it.
 *
 * The columns are the interesting entry. There is no list of columns: a column
 * is a `column` panel somebody put on the canvas ({@link boardColumns}), and
 * closing one removes it. What cannot happen is a card sitting in a column with
 * no panel, so `columnIds` is "the ids the cards carry" and this mints the
 * panels they are missing. An empty column nobody asked for is never minted.
 *
 * Hermes, settings and the gallery used to be force-present, and force-presence
 * is not a page you can close: deleting one put it straight back on the next
 * reconcile pass. Closing them is now closing them, and the palette or the
 * canvas menu puts one back.
 *
 * `board` is deliberately absent: a monolithic board panel from an older
 * snapshot is stale here, so the reconciler reaps it and the column panels
 * take its place — the migration is the ordinary create/reap pass.
 */
export function desiredStations(
  activeThreadIds: ReadonlyArray<string>,
  browserEntityIds: ReadonlyArray<string> = [],
  columnIds: ReadonlyArray<string> = [],
  terminalEntityIds: ReadonlyArray<string> = [],
): ReadonlyArray<PanelRef> {
  const seen = new Set<string>();
  const threads: Array<PanelRef> = [];
  for (const threadId of activeThreadIds) {
    if (threadId.length === 0 || seen.has(threadId)) continue;
    seen.add(threadId);
    threads.push({ kind: "thread", entityId: threadId });
  }
  // One panel per live server browser tab: the canvas is where a browser is
  // watched, so a session with no panel is a page nobody can see.
  const browsers: Array<PanelRef> = [];
  const seenBrowsers = new Set<string>();
  for (const entityId of browserEntityIds) {
    if (entityId.length === 0 || seenBrowsers.has(entityId)) continue;
    seenBrowsers.add(entityId);
    browsers.push({ kind: "browser", entityId });
  }
  // One panel per shell a thread is running, on the same rule as the browser
  // tabs: the work an agent does in a terminal is watched from the canvas, not
  // from inside the thread it was typed in.
  const terminals: Array<PanelRef> = [];
  const seenTerminals = new Set<string>();
  for (const entityId of terminalEntityIds) {
    if (entityId.length === 0 || seenTerminals.has(entityId)) continue;
    seenTerminals.add(entityId);
    terminals.push({ kind: "terminal", entityId });
  }
  return [
    ...columnIds.map((column): PanelRef => ({ kind: "column", entityId: column })),
    { kind: "composer", entityId: "" },
    ...threads,
    ...browsers,
    ...terminals,
  ];
}

/**
 * The panels a thread opened that are already on the canvas and stay there:
 * every one whose thread is still on the board.
 *
 * A shell or a tab appears the first time the thread uses it and then it is
 * *there* — the command finishing or the agent closing the tab does not clear
 * the panel out from under you mid-session. What ends it is the thread ending:
 * archive the card and its row goes with it.
 */
export function keptThreadPanels(
  existing: ReadonlyArray<PanelRef>,
  activeThreadIds: ReadonlyArray<string>,
): ReadonlyArray<PanelRef> {
  const active = new Set(activeThreadIds);
  return existing.filter((ref) => {
    const threadId = owningThreadId(ref.entityId);
    return threadId !== null && active.has(threadId);
  });
}

/** Room between a thread panel and the panels it opened under it. */
const SATELLITE_GAP = 96;

/** Gap between two panels a thread opened, side by side under it. */
const SATELLITE_GUTTER = 40;

/**
 * Where a panel a thread opened stands: under that thread's panel, in a row,
 * in the order the thread opened them.
 *
 * Read off the thread's *live* box rather than the placement table, so a thread
 * dragged somewhere takes its terminals and its browser tabs with it — the
 * arrow drawn between them ({@link panelLinks}) has to stay short enough to
 * read as ownership.
 */
export function satellitePlacement(thread: Box, kind: PanelKind, slot: number): Box {
  const size = panelSize(kind);
  return {
    x: thread.x + slot * (size.w + SATELLITE_GUTTER),
    y: thread.y + thread.h + SATELLITE_GAP,
    ...size,
  };
}

/**
 * What a canvas that has never held a panel opens with — a kanban to start
 * from, plus the pages a first-time canvas should have on it.
 *
 * {@link SEED_COLUMN_IDS} is a starting composition, not a schema: every one of
 * those columns can be renamed, reordered, closed or joined by another the
 * moment the canvas exists, and nothing reads the list again.
 *
 * Only ever used against an empty page. On a canvas that already has panels the
 * absence of one is a decision somebody made, not a gap to fill.
 */
export function seedStations(
  columnIds: ReadonlyArray<string> = SEED_COLUMN_IDS,
): ReadonlyArray<PanelRef> {
  return [
    ...desiredStations([], [], columnIds),
    { kind: "hermes", entityId: "" },
    { kind: "settings", entityId: "" },
    { kind: "terminal", entityId: "" },
    { kind: "explorer", entityId: "" },
    { kind: "threads", entityId: "" },
  ];
}

/**
 * Panels on the page that nothing points at any more.
 *
 * Only kinds the registry marks `reapable` are candidates: a thread panel
 * stands for a card the board owns, so archiving the card has to take the panel
 * with it, or the canvas keeps showing the thing that was archived. A panel a
 * human opened is theirs — closing it is the only thing that removes it.
 *
 * `keep` is the station the camera is on: leaving it in place means navigating
 * to a thread cannot delete the page you just asked for.
 */
export function staleStations(
  desired: ReadonlyArray<PanelRef>,
  existing: ReadonlyArray<PanelRef>,
  keep: StationRef | null = null,
): ReadonlyArray<PanelRef> {
  const wanted = new Set(desired.map(panelIdentity));
  if (keep !== null) wanted.add(panelIdentity(keep));
  return existing.filter((ref) => panelReapable(ref) && !wanted.has(panelIdentity(ref)));
}

/**
 * The next free slot for a kind that queues its instances up in a row, given
 * what is already on the page. Adding a second terminal or a third editor has
 * to land beside the others rather than on top of them.
 */
export function nextPanelSlot(kind: PanelKind, existing: ReadonlyArray<PanelRef>): number {
  return existing.filter((ref) => ref.kind === kind).length;
}

/** How far along a row the search for an empty slot walks. */
const MAX_ROW_SLOTS = 64;

/**
 * The first slot in a kind's row with nothing standing in it.
 *
 * {@link nextPanelSlot} counts refs, which is not the same question: a thread
 * dragged off the row leaves its slot empty and still consumes a number, so the
 * next one counted its way onto whatever had taken that place. Reading the page
 * instead keeps the row packed left to right — the fourth thread lands in the
 * gap the second left, which is where the eye already looks for it.
 */
export function nextFreeSlot(ref: StationRef, occupied: ReadonlyArray<Box>): number {
  for (let slot = 0; slot < MAX_ROW_SLOTS; slot += 1) {
    const box = panelPlacement(ref, slot);
    if (!occupied.some((other) => boxesOverlap(box, other))) return slot;
  }
  return 0;
}

/**
 * The lane threads queue up in: the row's first {@link THREAD_LANE_SLOTS}
 * places, as one rectangle.
 *
 * A frame is drawn around this so where the next thread will appear is
 * something you can see on the canvas rather than something you have to know.
 * It is the *address space*, not the union of the threads standing in it — a
 * lane that shrank to its contents would move whenever a thread was closed, and
 * the point of it is that it does not move.
 */
export const THREAD_LANE_SLOTS = 4;

/** The lane holding this many places. Never narrower than {@link THREAD_LANE_SLOTS}. */
export function threadLaneBox(slots: number): Box {
  const places = Math.max(THREAD_LANE_SLOTS, Math.trunc(slots));
  return {
    x: 0,
    y: THREAD_ROW_Y,
    w: (places - 1) * (panelSize("thread").w + GUTTER) + panelSize("thread").w,
    h: panelSize("thread").h,
  };
}

/** The lane at its authored width, for the frame preset drawn around it. */
export const THREAD_LANE_SIZE = {
  w: threadLaneBox(THREAD_LANE_SLOTS).w,
  h: threadLaneBox(THREAD_LANE_SLOTS).h,
} as const;

/**
 * Stations with no panel on the page yet, with the slot each one goes in.
 *
 * The slot is the ref's index among the desired panels of its own kind, so it
 * is counted for every kind that queues up in a row — threads under the board,
 * and the columns across it, whose order is board settings rather than a table
 * in this module.
 */
export function missingStations(
  desired: ReadonlyArray<PanelRef>,
  existing: ReadonlyArray<PanelRef>,
): ReadonlyArray<{ readonly ref: PanelRef; readonly threadIndex: number }> {
  const have = new Set(existing.map(panelIdentity));
  const missing: Array<{ ref: PanelRef; threadIndex: number }> = [];
  const counts = new Map<PanelKind, number>();
  for (const ref of desired) {
    const slot = counts.get(ref.kind) ?? 0;
    counts.set(ref.kind, slot + 1);
    if (have.has(panelIdentity(ref))) continue;
    missing.push({ ref, threadIndex: slot });
  }
  return missing;
}
