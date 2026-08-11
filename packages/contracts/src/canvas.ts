import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Board canvas contracts.
 *
 * The canvas is the shell the kanban floats on: one tldraw document per
 * environment, persisted server-side so Hermes can read it and draw on it.
 *
 * Two directions, deliberately asymmetric:
 * - **Human → server**: the browser owns the tldraw store and pushes the whole
 *   snapshot as opaque JSON. The server never parses it to write it back.
 * - **Hermes → human**: Hermes never authors tldraw records. It enqueues a
 *   high-level {@link CanvasInjection} (nodes, edges, a note, a focus request)
 *   and the browser materializes it with the real tldraw editor API. That keeps
 *   the model off tldraw's record schema and out of its version drift.
 */

export const CanvasDocId = TrimmedNonEmptyString.pipe(Schema.brand("CanvasDocId"));
export type CanvasDocId = typeof CanvasDocId.Type;

/** The board's canvas. One per environment until there is a reason for more. */
export const DEFAULT_CANVAS_DOC_ID = "board" as CanvasDocId;

// ---------------------------------------------------------------------------
// Document (opaque tldraw snapshot)
// ---------------------------------------------------------------------------

export const CanvasDocument = Schema.Struct({
  docId: CanvasDocId,
  /** A tldraw store snapshot, JSON-encoded. Opaque to the server. */
  snapshot: Schema.NullOr(Schema.String),
  /** Bumped on every save. A save carrying a stale revision is rejected. */
  revision: Schema.Number,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CanvasDocument = typeof CanvasDocument.Type;

export const CanvasGetInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
});
export type CanvasGetInput = typeof CanvasGetInput.Type;

export const CanvasGetResult = Schema.Struct({
  document: CanvasDocument,
});
export type CanvasGetResult = typeof CanvasGetResult.Type;

/**
 * The records that changed since the last save, instead of the whole document.
 *
 * A stroke touches one record; sending the entire canvas for it means the
 * document goes over the wire every debounce tick, and the cost grows with
 * everything ever drawn rather than with the edit. The server merges this into
 * the snapshot it already holds — it still does not read tldraw's schema, only
 * the record map's address.
 */
export const CanvasSavePatch = Schema.Struct({
  /** JSON object of `{ [recordId]: record }`, merged over the record map. */
  putJson: Schema.String,
  /** Record ids to drop from the map. */
  removeIds: Schema.Array(Schema.String),
});
export type CanvasSavePatch = typeof CanvasSavePatch.Type;

export const CanvasSaveInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
  /** The whole document. Omit only when sending `patch` instead. */
  snapshot: Schema.optionalKey(Schema.String),
  /**
   * A partial write against the stored snapshot. Only valid when the client
   * knows the server holds exactly what it last sent, so it always carries a
   * `baseRevision`; anything the server cannot merge comes back unsaved and the
   * client falls back to a whole-document write.
   */
  patch: Schema.optionalKey(CanvasSavePatch),
  /**
   * The revision the client last saw. Omit to force-overwrite. A mismatch is a
   * second tab that saved first — the client reloads instead of clobbering it.
   */
  baseRevision: Schema.optionalKey(Schema.Number),
});
export type CanvasSaveInput = typeof CanvasSaveInput.Type;

export const CanvasSaveResult = Schema.Struct({
  docId: CanvasDocId,
  revision: Schema.Number,
  /**
   * False when `baseRevision` was stale, or when a `patch` could not be merged
   * into what is stored. Either way the client refetches and sends the whole
   * document next time.
   */
  saved: Schema.Boolean,
});
export type CanvasSaveResult = typeof CanvasSaveResult.Type;

// ---------------------------------------------------------------------------
// Injections (Hermes → canvas)
// ---------------------------------------------------------------------------

export const CANVAS_NODE_COLORS = [
  "black",
  "blue",
  "green",
  "grey",
  "orange",
  "red",
  "violet",
  "yellow",
] as const;
export const CanvasNodeColor = Schema.Literals(CANVAS_NODE_COLORS);
export type CanvasNodeColor = typeof CanvasNodeColor.Type;

export const CANVAS_NODE_SHAPES = ["rectangle", "ellipse", "diamond", "note"] as const;
export const CanvasNodeShape = Schema.Literals(CANVAS_NODE_SHAPES);
export type CanvasNodeShape = typeof CanvasNodeShape.Type;

/** One labelled box. `key` is how edges refer to it, scoped to the injection. */
export const CanvasNode = Schema.Struct({
  key: TrimmedNonEmptyString,
  text: TrimmedString,
  shape: Schema.optionalKey(CanvasNodeShape),
  color: Schema.optionalKey(CanvasNodeColor),
  // Finite, not Number: JSON.parse admits 1e400 → Infinity, JSON.stringify
  // turns it back into null, and a coordinate that round-trips into null makes
  // the whole injection list undeliverable over the RPC contract.
  /** Canvas coordinates. Omit both and the layout falls back to a grid. */
  x: Schema.optionalKey(Schema.Finite),
  y: Schema.optionalKey(Schema.Finite),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  /** Ties the box to a board card, so clicking it can open the card. */
  cardId: Schema.optionalKey(Schema.NullOr(TrimmedString)),
});
export type CanvasNode = typeof CanvasNode.Type;

/** An arrow between two node keys in the same injection. */
export const CanvasEdge = Schema.Struct({
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedString),
});
export type CanvasEdge = typeof CanvasEdge.Type;

export const CanvasInjectionSpec = Schema.Struct({
  /** Frame title. Every injection lands in its own frame so it is undoable. */
  title: TrimmedString,
  nodes: Schema.Array(CanvasNode),
  edges: Schema.Array(CanvasEdge),
  /** Free prose parked beside the diagram. */
  note: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  /** Pan and zoom the viewport to this drawing once it lands. */
  focus: Schema.optionalKey(Schema.Boolean),
});
export type CanvasInjectionSpec = typeof CanvasInjectionSpec.Type;

export const CanvasInjection = Schema.Struct({
  id: TrimmedNonEmptyString,
  docId: CanvasDocId,
  spec: CanvasInjectionSpec,
  createdAt: Schema.DateTimeUtcFromString,
  /** Set once a browser has materialized it. Unapplied ones replay on reload. */
  appliedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CanvasInjection = typeof CanvasInjection.Type;

export const CanvasListInjectionsInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
});
export type CanvasListInjectionsInput = typeof CanvasListInjectionsInput.Type;

export const CanvasListInjectionsResult = Schema.Struct({
  injections: Schema.Array(CanvasInjection),
});
export type CanvasListInjectionsResult = typeof CanvasListInjectionsResult.Type;

export const CanvasAckInjectionsInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString),
});
export type CanvasAckInjectionsInput = typeof CanvasAckInjectionsInput.Type;

export const CanvasAckInjectionsResult = Schema.Struct({
  acked: Schema.Number,
});
export type CanvasAckInjectionsResult = typeof CanvasAckInjectionsResult.Type;

// ---------------------------------------------------------------------------
// Messages (a picture, or a comment, addressed to a reader)
// ---------------------------------------------------------------------------

export const CANVAS_MESSAGE_AUTHOR_KINDS = ["human", "thread", "hermes"] as const;
export const CanvasMessageAuthorKind = Schema.Literals(CANVAS_MESSAGE_AUTHOR_KINDS);
export type CanvasMessageAuthorKind = typeof CanvasMessageAuthorKind.Type;

export const CANVAS_MESSAGE_TARGETS = ["hermes", "thread", "human"] as const;
export const CanvasMessageTarget = Schema.Literals(CANVAS_MESSAGE_TARGETS);
export type CanvasMessageTarget = typeof CanvasMessageTarget.Type;

/** A PNG or JPEG, base64 with no data-URL prefix. */
export const CanvasImage = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  data: TrimmedNonEmptyString,
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
});
export type CanvasImage = typeof CanvasImage.Type;

/** Bigger than a generous board screenshot and it is a file, not a message. */
export const CANVAS_MESSAGE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * One addressed thing on the canvas. A crop of the board plus a comment is the
 * shape this exists for: it survives outside the opaque snapshot, so a reader
 * that is not a browser can still be handed the picture.
 */
export const CanvasMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  docId: CanvasDocId,
  authorKind: CanvasMessageAuthorKind,
  authorId: Schema.NullOr(TrimmedString),
  text: TrimmedString,
  /** Null when the reader did not ask for bytes — check `hasImage`, not this. */
  image: Schema.NullOr(CanvasImage),
  /** True whenever a picture is stored, whether or not it was loaded. */
  hasImage: Schema.Boolean,
  target: CanvasMessageTarget,
  /** Thread id when `target` is `thread`; null means whoever is listening. */
  targetId: Schema.NullOr(TrimmedString),
  createdAt: Schema.DateTimeUtcFromString,
  /** Set once its reader has taken it. Undelivered ones keep being offered. */
  deliveredAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CanvasMessage = typeof CanvasMessage.Type;

export const CanvasPostMessageInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
  authorKind: CanvasMessageAuthorKind,
  authorId: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  text: TrimmedString,
  image: Schema.optionalKey(Schema.NullOr(CanvasImage)),
  target: CanvasMessageTarget,
  targetId: Schema.optionalKey(Schema.NullOr(TrimmedString)),
});
export type CanvasPostMessageInput = typeof CanvasPostMessageInput.Type;

export const CanvasPostMessageResult = Schema.Struct({
  message: CanvasMessage,
});
export type CanvasPostMessageResult = typeof CanvasPostMessageResult.Type;

export const CanvasListMessagesInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
  target: Schema.optionalKey(CanvasMessageTarget),
  targetId: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  /** Default true — a reader normally wants its inbox, not its history. */
  undeliveredOnly: Schema.optionalKey(Schema.Boolean),
  /** Default false: images are large, and most readers only need the comment. */
  includeImages: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Number),
});
export type CanvasListMessagesInput = typeof CanvasListMessagesInput.Type;

export const CanvasListMessagesResult = Schema.Struct({
  messages: Schema.Array(CanvasMessage),
});
export type CanvasListMessagesResult = typeof CanvasListMessagesResult.Type;

export const CanvasAckMessagesInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString),
});
export type CanvasAckMessagesInput = typeof CanvasAckMessagesInput.Type;

export const CanvasAckMessagesResult = Schema.Struct({
  acked: Schema.Number,
});
export type CanvasAckMessagesResult = typeof CanvasAckMessagesResult.Type;

// ---------------------------------------------------------------------------
// Digest (canvas → Hermes)
// ---------------------------------------------------------------------------

/** One readable thing on the canvas, flattened out of the opaque snapshot. */
export const CanvasDigestShape = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  /** Page coordinates, resolved through parent frames — not frame-relative. */
  x: Schema.Number,
  y: Schema.Number,
});
export type CanvasDigestShape = typeof CanvasDigestShape.Type;

/**
 * What Hermes sees when it looks at the canvas: every shape that carries text,
 * plus a count of the ones that do not (freehand strokes, images).
 */
export const CanvasDigest = Schema.Struct({
  docId: CanvasDocId,
  revision: Schema.Number,
  shapeCount: Schema.Number,
  /** Shapes with no text — drawings Hermes can count but cannot read. */
  untitledCount: Schema.Number,
  shapes: Schema.Array(CanvasDigestShape),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CanvasDigest = typeof CanvasDigest.Type;

export const CanvasDigestInput = Schema.Struct({
  docId: Schema.optionalKey(CanvasDocId),
});
export type CanvasDigestInput = typeof CanvasDigestInput.Type;

// ---------------------------------------------------------------------------
// Canvas UI (which pieces of tldraw's chrome the owner wants on screen)
// ---------------------------------------------------------------------------

/**
 * Every toolbar tool the canvas can offer, in the order the toolbar draws
 * them. Ids are tldraw's own tool ids; the web maps each to its stock toolbar
 * item. Most owners run a handful of these — the full set is one preset away.
 */
export const CANVAS_TOOL_IDS = [
  "select",
  "hand",
  "draw",
  "eraser",
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "text",
  "note",
  "frame",
  "highlight",
  "laser",
  "asset",
  "triangle",
  "diamond",
  "hexagon",
  "oval",
  "rhombus",
  "star",
  "cloud",
  "heart",
  "x-box",
  "check-box",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "arrow-right",
] as const;
export const CanvasToolId = Schema.Literals(CANVAS_TOOL_IDS);
export type CanvasToolId = typeof CanvasToolId.Type;

/** tldraw's `DefaultColorStyle` values — the swatches the style panel can show. */
export const CANVAS_COLOR_IDS = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;
export const CanvasColorId = Schema.Literals(CANVAS_COLOR_IDS);
export type CanvasColorId = typeof CanvasColorId.Type;

/** `minimal` is swatches + stroke size; `full` is tldraw's stock panel. */
export const CANVAS_STYLE_PANEL_MODES = ["hidden", "minimal", "full"] as const;
export const CanvasStylePanelMode = Schema.Literals(CANVAS_STYLE_PANEL_MODES);
export type CanvasStylePanelMode = typeof CanvasStylePanelMode.Type;

export const DEFAULT_MINIMAL_CANVAS_TOOLS: ReadonlyArray<CanvasToolId> = [
  "select",
  "hand",
  "draw",
  "eraser",
  "rectangle",
  "ellipse",
  "text",
];
export const DEFAULT_MINIMAL_CANVAS_COLORS: ReadonlyArray<CanvasColorId> = ["black", "blue"];

/**
 * Which parts of tldraw's chrome the canvas mounts. Defaults are the minimal
 * board: a few tools, two colors, no minimap, no menu cluster. Everything the
 * defaults hide is a toggle in Settings → Board → Canvas toolbar; the stock
 * tldraw UI is the "everything" preset.
 */
export const CanvasUiSettings = Schema.Struct({
  /** Toolbar buttons, drawn in {@link CANVAS_TOOL_IDS} order. */
  tools: Schema.Array(CanvasToolId).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MINIMAL_CANVAS_TOOLS)),
  ),
  /** Style panel swatches. Ignored while `stylePanel` is `full`. */
  colors: Schema.Array(CanvasColorId).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MINIMAL_CANVAS_COLORS)),
  ),
  stylePanel: CanvasStylePanelMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("minimal" as const)),
  ),
  /** The zoom + minimap cluster in the bottom-left. */
  showMinimap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Main menu, actions menu and help menu. Undo/redo stay regardless. */
  showMenus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CanvasUiSettings = typeof CanvasUiSettings.Type;
export const DEFAULT_CANVAS_UI_SETTINGS: CanvasUiSettings = Schema.decodeSync(CanvasUiSettings)({});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CanvasPersistenceError extends Schema.TaggedErrorClass<CanvasPersistenceError>()(
  "CanvasPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Canvas persistence failed during ${this.operation}${
      this.detail ? `: ${this.detail}` : "."
    }`;
  }
}

export const CanvasError = CanvasPersistenceError;
export type CanvasError = CanvasPersistenceError;
