/**
 * Frames — a rectangle on the canvas you can name, size, lock and go to.
 *
 * A frame holds nothing of its own. The panels standing inside it are ordinary
 * canvas panels at their own authored sizes; the frame is the border drawn
 * around them, and moving it moves what is standing in it. That is the whole
 * relationship — there are no slots, no tab strips and no bound grids, so
 * nothing here stretches a panel to fill a gap.
 *
 * What "standing in it" means is {@link frameMembers}: mostly inside the border
 * ({@link frameGrabsBox}), or locked in by hand, which is also this canvas's
 * grouping gesture.
 *
 * No tldraw and no React in here: where the border goes, what a preset is,
 * which frame a phone-width window fits to. `FrameShapeUtil` turns these into
 * records; `FrameHost` turns them into pixels.
 *
 * @module components/canvas/panels/panelFrames
 */

import { SEED_COLUMN_IDS } from "./boardColumns";
import {
  isFrameLayoutId,
  layoutContentBox,
  type FrameLayoutId,
  type FramePlacement,
} from "./frameLayouts";
import type { PanelKind, PanelSize } from "./panelRegistry";
import {
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  KANBAN_REGION_SIZE,
  LIVE_PRESENCE,
  THREAD_LANE_SIZE,
  MOBILE_CHROME_MAX_WIDTH,
  type Box,
  type PanelRef,
} from "./panelStations";

export { FRAME_HEADER_HEIGHT, FRAME_PADDING };

/** Smallest a frame may be dragged to before its own chrome stops fitting. */
export const FRAME_MIN_SIZE: PanelSize = { w: 320, h: 240 };

/** The part of a frame panels stand in: everything under the title bar. */
export function frameContentBox(box: Box): Box {
  return {
    x: box.x,
    y: box.y + FRAME_HEADER_HEIGHT,
    w: box.w,
    h: Math.max(0, box.h - FRAME_HEADER_HEIGHT),
  };
}

/**
 * The frame drawn around a group of panels: their union, padded, with the title
 * bar above it. Panels keep the positions they already had — a frame is drawn
 * around a composition, never a layout that re-places one.
 */
export function frameAround(content: Box): Box {
  return {
    x: content.x - FRAME_PADDING,
    y: content.y - FRAME_PADDING - FRAME_HEADER_HEIGHT,
    w: Math.max(FRAME_MIN_SIZE.w, content.w + FRAME_PADDING * 2),
    h: Math.max(FRAME_MIN_SIZE.h, content.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT),
  };
}

/**
 * The frames you can drop on the canvas.
 *
 * Two families. `custom`/`desktop`/`mobile` are empty rectangles — a screen to
 * compose in. `kanban`/`agents`/`ide` come with a composition already standing
 * in them ({@link module:components/canvas/panels/frameLayouts}); the panels
 * are ordinary panels once created, so the frame is still only the border.
 *
 * `board` is the frame the canvas draws around the kanban a canvas is seeded
 * with. `kanban` is the same layout as something you add — you can have both,
 * and several of each.
 */
export const FRAME_PRESET_IDS = [
  "custom",
  "desktop",
  "mobile",
  "board",
  "threads",
  "kanban",
  "agents",
  "ide",
] as const;
export type FramePresetId = (typeof FRAME_PRESET_IDS)[number];

export interface FramePreset {
  readonly id: FramePresetId;
  readonly label: string;
  /** Authored size — what a fresh frame of this preset is created at. */
  readonly size: PanelSize;
}

export const FRAME_PRESETS: Record<FramePresetId, FramePreset> = {
  custom: { id: "custom", label: "Frame", size: { w: 1480, h: 920 } },
  // Desktop and Mobile are frames whose content area is a real screen: the
  // frame's box is the screen plus its own title bar, so what is inside the
  // bar is exactly 1920x1080 (or 390x844) of canvas at 1:1.
  desktop: { id: "desktop", label: "Desktop", size: { w: 1920, h: 1080 + FRAME_HEADER_HEIGHT } },
  mobile: { id: "mobile", label: "Mobile", size: { w: 390, h: 844 + FRAME_HEADER_HEIGHT } },
  // The kanban region, bordered: the columns and the composer at the sizes they
  // already have on the canvas, with a rectangle drawn around them.
  board: {
    id: "board",
    label: "Board",
    size: {
      w: KANBAN_REGION_SIZE.w + FRAME_PADDING * 2,
      h: KANBAN_REGION_SIZE.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT,
    },
  },
  // The thread lane, bordered: the first few places on the thread row, so the
  // spot new threads appear in is drawn on the canvas. Sized from the row's own
  // pitch rather than from the threads standing in it — an empty lane is still
  // the answer to "where will it go".
  threads: {
    id: "threads",
    label: "Thread lane",
    size: {
      w: THREAD_LANE_SIZE.w + FRAME_PADDING * 2,
      h: THREAD_LANE_SIZE.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT,
    },
  },
  // The three laid-out frames. These sizes are only what a frame is created at
  // before its layout is measured — `frameForLayout` resizes it to whatever the
  // composition actually came to, which for the kanban depends on how many
  // columns the board has.
  kanban: {
    id: "kanban",
    label: "Kanban",
    size: {
      w: KANBAN_REGION_SIZE.w + FRAME_PADDING * 2,
      h: KANBAN_REGION_SIZE.h + FRAME_PADDING * 2 + FRAME_HEADER_HEIGHT,
    },
  },
  agents: { id: "agents", label: "Agents", size: { w: 1330, h: 1030 } },
  ide: { id: "ide", label: "IDE", size: { w: 1990, h: 1030 } },
};

/** The layout a preset stands in for, or null for the empty rectangles. */
export function presetLayoutId(preset: FramePresetId): FrameLayoutId | null {
  return isFrameLayoutId(preset) ? preset : null;
}

/**
 * The frame to draw around a layout's contents, and where each panel goes on
 * the page, given the point the frame is being dropped at.
 *
 * The frame is sized to the composition rather than the composition squeezed
 * into the frame: that is the whole difference between this and the docking
 * frames it replaces, and it is why a six-column board gets a wider Kanban
 * frame instead of six thinner columns.
 */
export function frameForLayout(input: {
  readonly placements: ReadonlyArray<FramePlacement>;
  /** Where the drop happened, in page coordinates. The frame is centered on it. */
  readonly at: { readonly x: number; readonly y: number };
}): {
  readonly frame: Box;
  readonly panels: ReadonlyArray<{ readonly ref: PanelRef; readonly box: Box }>;
} {
  const content = layoutContentBox(input.placements) ?? { x: 0, y: 0, ...FRAME_MIN_SIZE };
  const frame = frameAround(content);
  const origin = { x: input.at.x - frame.w / 2, y: input.at.y - FRAME_HEADER_HEIGHT / 2 };
  // The layout's own coordinates, shifted so its top-left corner lands one
  // padding inside the border. Offsets between panels are untouched: the frame
  // is drawn around the composition, never a grid that re-places it.
  const shift = { x: origin.x - frame.x, y: origin.y - frame.y };
  return {
    frame: { ...origin, w: frame.w, h: frame.h },
    panels: input.placements.map((placement) => ({
      ref: placement.ref,
      box: {
        x: shift.x + placement.box.x,
        y: shift.y + placement.box.y,
        w: placement.box.w,
        h: placement.box.h,
      },
    })),
  };
}

/**
 * Where a panel opened *from* another one goes: the free space beside it inside
 * their frame, so a thread picked out of a list lands in the frame the list is
 * standing in rather than in the thread row on the far side of the canvas.
 *
 * To the right of the source panel when the frame has room for at least
 * `minSize` there, otherwise under it. Null when neither fits — the caller
 * falls back to the panel's own address, which is what a frame too small to
 * hold the page honestly means.
 */
export function placeBesideInFrame(input: {
  /** The frame's content area, in page coordinates. */
  readonly content: Box;
  /** The panel the request came from, in page coordinates. */
  readonly source: Box;
  readonly size: PanelSize;
  readonly minSize: PanelSize;
}): Box | null {
  const gap = FRAME_PADDING / 2;
  const right = input.source.x + input.source.w + gap;
  const rightW = input.content.x + input.content.w - right;
  if (rightW >= input.minSize.w) {
    return {
      x: right,
      y: input.source.y,
      w: Math.min(input.size.w, rightW),
      h: Math.min(input.size.h, input.content.y + input.content.h - input.source.y),
    };
  }
  const below = input.source.y + input.source.h + gap;
  const belowH = input.content.y + input.content.h - below;
  if (belowH >= input.minSize.h) {
    return {
      x: input.source.x,
      y: below,
      w: Math.min(input.size.w, input.content.x + input.content.w - input.source.x),
      h: Math.min(input.size.h, belowH),
    };
  }
  return null;
}

/**
 * Where a new column panel goes when the board's other columns are standing in
 * a frame: on the end of that row, inside the same border, at the height its
 * neighbours already have.
 *
 * Adding a column in settings has to show up in the Kanban frame you are
 * looking at, not at its address on the far side of the canvas — and the frame
 * has to grow to hold it, since a frame is drawn around a composition and this
 * is now part of one.
 */
export function appendToColumnRow(input: {
  /** The rightmost column panel already standing in the frame. */
  readonly last: Box;
  /** That frame's box, title bar included. */
  readonly frame: Box;
  readonly width: number;
}): { readonly panel: Box; readonly frame: Box } {
  const panel = {
    x: input.last.x + input.last.w + COLUMN_ROW_GUTTER,
    y: input.last.y,
    w: input.width,
    h: input.last.h,
  };
  const right = panel.x + panel.w + FRAME_PADDING;
  return {
    panel,
    frame: { ...input.frame, w: Math.max(input.frame.w, right - input.frame.x) },
  };
}

/** Gap between two column panels in a row. Tighter than the layout gutter. */
const COLUMN_ROW_GUTTER = 26;

export function framePreset(id: FramePresetId): FramePreset {
  return FRAME_PRESETS[id];
}

/**
 * The frames a human can place. `board` is missing on purpose: the canvas draws
 * that one around the kanban region it seeds, and adding a second empty Board
 * frame would be a screen claiming to be the board with nothing standing in it.
 * The `kanban` preset is how you get another one — with its own columns in it.
 */
export const FRAME_ADDABLE_PRESET_IDS: ReadonlyArray<FramePresetId> = FRAME_PRESET_IDS.filter(
  (id) => id !== "board" && id !== "threads",
);

/**
 * The screens a frame's content area can be set to. A frame *is* the screen —
 * canvas units are CSS pixels at 1:1, so a frame whose content box is 1920x1080
 * is that monitor, not a rectangle of its ratio.
 *
 * Ids carry the size so a saved frame still says what it was if a label is
 * ever reworded. Deliberately not the in-app browser's device catalog
 * (`@t3tools/shared/previewViewport`): that list is Chrome DevTools' emulation
 * devices — phones and tablets, no desktop sizes.
 */
export const FRAME_SIZE_IDS = ["1920x1080", "2560x1440", "1280x720", "390x844", "430x932"] as const;

export type FrameSizeId = (typeof FRAME_SIZE_IDS)[number];

export interface FrameScreenSize {
  readonly id: FrameSizeId;
  readonly label: string;
  readonly size: PanelSize;
}

export const FRAME_SIZES: Record<FrameSizeId, FrameScreenSize> = {
  "1920x1080": { id: "1920x1080", label: "Desktop", size: { w: 1920, h: 1080 } },
  "2560x1440": { id: "2560x1440", label: "Desktop large", size: { w: 2560, h: 1440 } },
  "1280x720": { id: "1280x720", label: "Laptop", size: { w: 1280, h: 720 } },
  "390x844": { id: "390x844", label: "Mobile", size: { w: 390, h: 844 } },
  "430x932": { id: "430x932", label: "Mobile large", size: { w: 430, h: 932 } },
};

export function frameSize(id: FrameSizeId): FrameScreenSize {
  return FRAME_SIZES[id];
}

/**
 * Which screen a frame's content area is currently the size of, or null when a
 * human has dragged it to something of their own. Null is an answer — the
 * picker says "Custom" rather than claiming the frame is still a phone.
 */
export function matchFrameSize(size: PanelSize): FrameSizeId | null {
  return (
    FRAME_SIZE_IDS.find((id) => {
      const preset = FRAME_SIZES[id].size;
      return Math.round(size.w) === preset.w && Math.round(size.h) === preset.h;
    }) ?? null
  );
}

export function frameSizeLabel(size: PanelSize): string {
  return `${Math.round(size.w)} × ${Math.round(size.h)}`;
}

/**
 * Whether a frame stands for a phone rather than a desktop.
 *
 * The line is the width at which the app itself folds into its phone layout
 * (`MOBILE_CHROME_MAX_WIDTH`), not a list of preset ids: a frame dragged to
 * 400x860 by hand is a phone composition as much as the 390x844 preset is.
 */
export function isPhoneFrame(size: PanelSize): boolean {
  return size.w < MOBILE_CHROME_MAX_WIDTH;
}

export interface FrameFitCandidate<Id> {
  readonly id: Id;
  readonly box: Box;
  /** How much of the window this frame already is (`panelPresence`). */
  readonly presence: number;
}

/**
 * Which frame a phone-width window fits itself to, or null for none.
 *
 * A phone cannot show 1920 units at 1:1, and panning a composition through a
 * 390px window is reading a wall through a letterbox — so below the width where
 * tldraw itself folds into a phone layout, the camera fits a frame instead of
 * being panned. With more than one frame on the canvas that is a choice, and
 * an arbitrary one would mean resizing the window took you somewhere different
 * each time. The order, stated once:
 *
 * 1. Nothing at all unless the window is phone-width and at least one frame is
 *    already on screen — resizing while you are off drawing elsewhere on the
 *    canvas must not yank the camera across it.
 * 2. A phone-sized frame beats a desktop one. Laying a phone screen out beside
 *    the desktop one is what it is for: on a phone you get the phone one.
 * 3. Then the largest by area — the desktop fallback, and the roomier of two
 *    phones.
 * 4. Then topmost, then leftmost, then by id: a total order, so two identical
 *    frames still resolve the same way on every resize.
 */
export function frameToFit<Id>(input: {
  readonly screenWidth: number;
  readonly frames: ReadonlyArray<FrameFitCandidate<Id>>;
}): Id | null {
  if (input.screenWidth >= MOBILE_CHROME_MAX_WIDTH) return null;
  if (!input.frames.some((frame) => frame.presence >= LIVE_PRESENCE)) return null;
  return [...input.frames].sort(byFitPreference)[0]?.id ?? null;
}

function byFitPreference<Id>(a: FrameFitCandidate<Id>, b: FrameFitCandidate<Id>): number {
  const phone = Number(isPhoneFrame(b.box)) - Number(isPhoneFrame(a.box));
  if (phone !== 0) return phone;
  const area = b.box.w * b.box.h - a.box.w * a.box.h;
  if (area !== 0) return area;
  if (a.box.y !== b.box.y) return a.box.y - b.box.y;
  if (a.box.x !== b.box.x) return a.box.x - b.box.x;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Where a frame's children go when the frame moves: exactly where they were,
 * plus the same delta. Moving a screen never re-lays-out what is standing on
 * it — the offsets inside the border are the composition.
 */
export function frameChildMoves<T extends { readonly x: number; readonly y: number }>(
  children: ReadonlyArray<T>,
  delta: { readonly x: number; readonly y: number },
): ReadonlyArray<T> {
  return children.map((child) => ({ ...child, x: child.x + delta.x, y: child.y + delta.y }));
}

/**
 * What a move must leave where it is: the pages a locked frame is holding,
 * when that frame is one of the shapes being moved.
 *
 * tldraw drops a locked shape from a translate and carries the rest of the
 * selection anyway, so dragging a locked frame together with the pages standing
 * in it walked the pages out from under their own border and left the border
 * behind. A lock pins the screen, not only its rectangle.
 */
export function anchoredByLockedFrames<Id>(input: {
  /** Everything the gesture is moving — the selection, for tldraw's translate. */
  readonly moving: ReadonlyArray<Id>;
  readonly lockedFrames: ReadonlyArray<{
    readonly id: Id;
    readonly holding: ReadonlyArray<Id>;
  }>;
}): ReadonlySet<Id> {
  const moving = new Set(input.moving);
  const anchored = new Set<Id>();
  for (const frame of input.lockedFrames) {
    if (!moving.has(frame.id)) continue;
    for (const held of frame.holding) if (moving.has(held)) anchored.add(held);
  }
  return anchored;
}

/** Whether a box is standing wholly inside a frame's content area. */
export function isInsideFrame(content: Box, box: Box): boolean {
  return (
    box.x >= content.x &&
    box.y >= content.y &&
    box.x + box.w <= content.x + content.w &&
    box.y + box.h <= content.y + content.h
  );
}

/**
 * How much of a shape has to stand inside a frame before the frame carries it.
 *
 * Whole containment is too strict to be the rule: a page nudged a few units
 * past the border, a title bar overhanging the top, a stroke whose bounds bleed
 * over the edge — each is plainly part of the composition, and each used to be
 * left standing on the canvas when the frame moved. That is what "it didn't
 * grab all of it" is. Half the shape's own area is the line instead.
 */
export const FRAME_GRAB_RATIO = 0.5;

/**
 * Whether a frame carries this box when it moves: wholly inside, or at least
 * {@link FRAME_GRAB_RATIO} of its own area inside. A box with no area — a
 * straight line, a bare point — is carried when its middle is inside.
 *
 * Membership is read against the frame's box *before* a move and everything it
 * holds travels by the same delta, so a shape can never slide out of the frame
 * partway through the drag it started inside of.
 */
export function frameGrabsBox(content: Box, box: Box): boolean {
  if (isInsideFrame(content, box)) return true;
  const area = box.w * box.h;
  const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  if (area <= 0)
    return (
      middle.x >= content.x &&
      middle.x <= content.x + content.w &&
      middle.y >= content.y &&
      middle.y <= content.y + content.h
    );
  return overlapArea(content, box) / area >= FRAME_GRAB_RATIO;
}

/**
 * Which frames have to go to the back of the page, given every shape on it in
 * paint order.
 *
 * A frame is a border drawn around a composition, but the rectangle it draws is
 * filled and hit-testable like any other shape — so a page painted under one is
 * unreachable on the canvas: the click, the drag and the selection all land on
 * the frame. Panels brought to the front by a title-bar drag climb over it and
 * keep working, which is how one column ends up behaving unlike its three
 * neighbours with no per-column code anywhere.
 *
 * All of them or none: the order between frames is theirs to keep, and a canvas
 * where no frame is above a shape is already right and must not be rewritten.
 */
export function framesToSendBack<Id>(
  shapes: ReadonlyArray<{ readonly id: Id; readonly isFrame: boolean }>,
): ReadonlyArray<Id> {
  const firstContent = shapes.findIndex((shape) => !shape.isFrame);
  const lastFrame = shapes.findLastIndex((shape) => shape.isFrame);
  if (firstContent === -1 || lastFrame < firstContent) return [];
  return shapes.filter((shape) => shape.isFrame).map((shape) => shape.id);
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w <= 0 || h <= 0 ? 0 : w * h;
}

/** What the cog says under the contents switch. */
export function frameContentsSummary(count: number, locked: boolean): string {
  const shapes = `${count} ${count === 1 ? "shape" : "shapes"}`;
  if (locked) return `${shapes} locked in — they travel with the frame wherever they stand`;
  if (count === 0) return "Nothing standing in this frame yet";
  return `${shapes} standing in this frame travel with it`;
}

export interface FrameCandidate<Id> {
  readonly id: Id;
  /** The shape's bounds on the page. */
  readonly box: Box;
  /** The frame this shape has been locked into, if a human locked it into one. */
  readonly pinnedTo: Id | null;
}

/**
 * What a frame carries: everything locked into it, plus everything standing in
 * it that is not locked into some other frame.
 *
 * Two ways in, one list out. Geometry is the default because drawing a frame
 * around a composition is how frames are used, and locking is the override for
 * when geometry is not what you meant — a page you want carried even though it
 * hangs out of the border, or a page you want left where it is while the frame
 * it happens to overlap moves away.
 *
 * Returns candidates in the order given, so a move applies in paint order.
 */
export function frameMembers<Id>(input: {
  readonly frameId: Id;
  /** The frame's content area — under its title bar. */
  readonly content: Box;
  readonly candidates: ReadonlyArray<FrameCandidate<Id>>;
}): ReadonlyArray<Id> {
  return input.candidates
    .filter((candidate) =>
      candidate.pinnedTo === null
        ? frameGrabsBox(input.content, candidate.box)
        : candidate.pinnedTo === input.frameId,
    )
    .map((candidate) => candidate.id);
}

/**
 * The docking record a frame saved before frames became borders: panels parked
 * in slots, and the query a tiled main slot was bound to. Read only to hand
 * those pages back to the canvas ({@link legacyFrameStations}).
 */
export interface LegacyFrameProps {
  readonly query: string;
  readonly slots: ReadonlyArray<{
    readonly panels: ReadonlyArray<{ readonly kind: PanelKind; readonly entityId: string }>;
  }>;
}

/**
 * The pages such a frame is holding — every slot's panels, plus the columns a
 * `kanban` query pinned into it without their appearing in any slot. Dropping
 * these on load would delete pages nobody closed.
 */
export function legacyFrameStations(props: LegacyFrameProps): ReadonlyArray<PanelRef> {
  const docked = props.slots.flatMap((slot) =>
    slot.panels.map((panel): PanelRef => ({ kind: panel.kind, entityId: panel.entityId })),
  );
  const bound =
    props.query === "kanban"
      ? SEED_COLUMN_IDS.map((column): PanelRef => ({ kind: "column", entityId: column }))
      : [];
  return [...docked, ...bound];
}

/**
 * Title the removed `dev` gallery used on its frame. After the gallery panel is
 * reaped the border can remain as an empty rectangle titled this; that is what
 * {@link staleEmptyGalleryFrameIds} drops — never a hand-named empty custom
 * frame.
 */
export const REMOVED_GALLERY_FRAME_TITLE = "Dev gallery";

/** Whether this frame title is exactly the removed gallery's label. */
export function isRemovedGalleryFrameTitle(title: string): boolean {
  return title.trim() === REMOVED_GALLERY_FRAME_TITLE;
}

/**
 * Empty frames left when the gallery panels were reaped from an older snapshot.
 *
 * Only frames whose title is exactly {@link REMOVED_GALLERY_FRAME_TITLE} and
 * that hold no shapes. An empty "Frame" or a named composition somebody left
 * open is not this.
 */
export function staleEmptyGalleryFrameIds<Id>(
  frames: ReadonlyArray<{
    readonly id: Id;
    readonly title: string;
    /** Shapes standing in or locked into the frame. */
    readonly childCount: number;
  }>,
): ReadonlyArray<Id> {
  return frames
    .filter((frame) => isRemovedGalleryFrameTitle(frame.title) && frame.childCount === 0)
    .map((frame) => frame.id);
}
