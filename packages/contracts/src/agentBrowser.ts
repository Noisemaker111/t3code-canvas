import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId, PreviewViewportSize } from "./preview.ts";

/**
 * Server-hosted agent browser: a headless Chromium page per (thread, tab),
 * driven by agents through the preview_* automation operations and mirrored
 * live onto the board canvas through the attach stream below. Humans drive the
 * same page by forwarding raw input events.
 */

export const AGENT_BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** Thread key for browser tabs a human opened from the canvas with no agent. */
export const BOARD_BROWSER_THREAD_ID = "__t3_board_browser__";

/**
 * Cookie jars, by name.
 *
 * A tab runs in a profile, and a profile is a real Chromium user-data directory
 * on the box: its cookies, storage and logins persist and are shared by every
 * tab in it. `default` is the one a tab gets when nothing says otherwise.
 *
 * Naming them is what makes two of anything possible — signed in as two users
 * at once, a clean jar to reproduce a logged-out bug, one thread on staging
 * while another is on production. They run side by side; a profile is one
 * Chromium process, started the first time a tab asks for it.
 */
export const AGENT_BROWSER_DEFAULT_PROFILE = "default";

/** Profile names are directory names on the box, so they are kept boring. */
export const AgentBrowserProfileName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9 _-]{0,31}$/i),
);
export type AgentBrowserProfileName = typeof AgentBrowserProfileName.Type;

/**
 * The profile a request means: trimmed, lowercased, and `default` for anything
 * empty or unusable. Callers hand this whatever a human typed.
 */
export function normalizeAgentBrowserProfile(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return AGENT_BROWSER_DEFAULT_PROFILE;
  const cleaned = trimmed
    .replaceAll(/[^a-z0-9 _-]/g, "-")
    .slice(0, 32)
    .trim();
  // A name of nothing but separators is not a name: `///` is the default jar,
  // not a directory called `---`.
  return /[a-z0-9]/.test(cleaned) ? cleaned : AGENT_BROWSER_DEFAULT_PROFILE;
}

/**
 * Capture width is bucketed rather than exact: a viewer's width changes with
 * every drag of a panel edge and every notch of canvas zoom, and each distinct
 * value is a screencast restart. One bucket per step, and a panel has to change
 * size by a lot before the box re-encodes anything.
 */
export const AGENT_BROWSER_CAPTURE_WIDTH_STEP = 320;
export const AGENT_BROWSER_MIN_CAPTURE_WIDTH = 640;
export const AGENT_BROWSER_MAX_CAPTURE_WIDTH = 1920;

/** The bucket a viewer of this pixel width asks the box to capture at. */
export function agentBrowserCaptureWidth(renderedWidth: number): number {
  if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) {
    return AGENT_BROWSER_MIN_CAPTURE_WIDTH;
  }
  const stepped =
    Math.ceil(renderedWidth / AGENT_BROWSER_CAPTURE_WIDTH_STEP) * AGENT_BROWSER_CAPTURE_WIDTH_STEP;
  return Math.min(
    AGENT_BROWSER_MAX_CAPTURE_WIDTH,
    Math.max(AGENT_BROWSER_MIN_CAPTURE_WIDTH, stepped),
  );
}

export const AgentBrowserSessionStatus = Schema.Literals(["running", "closed"]);
export type AgentBrowserSessionStatus = typeof AgentBrowserSessionStatus.Type;

export const AgentBrowserSessionSummary = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** Which cookie jar this tab runs in. */
  profile: Schema.String,
  status: AgentBrowserSessionStatus,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  viewport: PreviewViewportSize,
  updatedAt: Schema.String,
});
export type AgentBrowserSessionSummary = typeof AgentBrowserSessionSummary.Type;

const AgentBrowserTabRef = {
  threadId: ThreadId,
  tabId: PreviewTabId,
};

export const AgentBrowserOpenInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  url: Schema.optional(TrimmedNonEmptyString),
  /**
   * Which cookie jar to open in. Absent means `default`; a name the box has
   * never seen is created on the spot, so "open this in a clean jar" is one
   * word rather than a setup step.
   */
  profile: Schema.optional(AgentBrowserProfileName),
});
export type AgentBrowserOpenInput = typeof AgentBrowserOpenInput.Type;

export const AgentBrowserNavigateInput = Schema.Struct({
  ...AgentBrowserTabRef,
  url: TrimmedNonEmptyString,
});
export type AgentBrowserNavigateInput = typeof AgentBrowserNavigateInput.Type;

export const AgentBrowserHistoryInput = Schema.Struct({
  ...AgentBrowserTabRef,
  direction: Schema.Literals(["back", "forward", "reload"]),
});
export type AgentBrowserHistoryInput = typeof AgentBrowserHistoryInput.Type;

export const AgentBrowserCloseInput = Schema.Struct(AgentBrowserTabRef);
export type AgentBrowserCloseInput = typeof AgentBrowserCloseInput.Type;

export const AgentBrowserResizeInput = Schema.Struct({
  ...AgentBrowserTabRef,
  viewport: PreviewViewportSize,
});
export type AgentBrowserResizeInput = typeof AgentBrowserResizeInput.Type;

export const AgentBrowserAttachInput = Schema.Struct({
  ...AgentBrowserTabRef,
  /**
   * How wide the viewer draws the page, in device pixels, bucketed by
   * {@link agentBrowserCaptureWidth}. The box captures for the largest attached
   * viewer instead of always encoding the full viewport: a panel drawn 440px
   * wide was being sent 1280px JPEGs, sixty times a second.
   *
   * Absent means "capture at the page's own size" — an older client, or a
   * viewer that has not measured itself yet.
   */
  captureWidth: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(AGENT_BROWSER_MIN_CAPTURE_WIDTH)).check(
      Schema.isLessThanOrEqualTo(AGENT_BROWSER_MAX_CAPTURE_WIDTH),
    ),
  ),
});
export type AgentBrowserAttachInput = typeof AgentBrowserAttachInput.Type;

const InputModifiers = Schema.optional(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.",
  }),
);

const AgentBrowserMouseEvent = Schema.Struct({
  kind: Schema.Literals(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
  x: Schema.Number,
  y: Schema.Number,
  button: Schema.optional(Schema.Literals(["none", "left", "middle", "right"])),
  clickCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  deltaX: Schema.optional(Schema.Number),
  deltaY: Schema.optional(Schema.Number),
  modifiers: InputModifiers,
});
export type AgentBrowserMouseEvent = typeof AgentBrowserMouseEvent.Type;

const AgentBrowserKeyEvent = Schema.Struct({
  kind: Schema.Literals(["keyDown", "keyUp", "char"]),
  key: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  modifiers: InputModifiers,
});
export type AgentBrowserKeyEvent = typeof AgentBrowserKeyEvent.Type;

export const AgentBrowserInputEvent = Schema.Union([AgentBrowserMouseEvent, AgentBrowserKeyEvent]);
export type AgentBrowserInputEvent = typeof AgentBrowserInputEvent.Type;

export const AgentBrowserInputInput = Schema.Struct({
  ...AgentBrowserTabRef,
  event: AgentBrowserInputEvent,
});
export type AgentBrowserInputInput = typeof AgentBrowserInputInput.Type;

/** One CDP screencast frame, JPEG bytes base64-encoded for the JSON RPC socket. */
export const AgentBrowserFrame = Schema.Struct({
  data: Schema.String,
  deviceWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  deviceHeight: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type AgentBrowserFrame = typeof AgentBrowserFrame.Type;

const AgentBrowserAttachStatusEvent = Schema.Struct({
  type: Schema.Literal("status"),
  session: AgentBrowserSessionSummary,
});

const AgentBrowserAttachFrameEvent = Schema.Struct({
  type: Schema.Literal("frame"),
  frame: AgentBrowserFrame,
});

const AgentBrowserAttachClosedEvent = Schema.Struct({
  type: Schema.Literal("closed"),
  ...AgentBrowserTabRef,
});

/**
 * What the page said and what it fetched.
 *
 * The box has always collected both — agents read them through `preview_*` —
 * and the human watching the same page could see neither. "Use my app and find
 * issues" is mostly a question about these two lists, so they ride the attach
 * stream to whoever is watching, one entry at a time.
 */
export const AgentBrowserConsoleEntry = Schema.Struct({
  /** Per-tab counter. Two log lines in the same millisecond are still two rows. */
  seq: Schema.Int,
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
});
export type AgentBrowserConsoleEntry = typeof AgentBrowserConsoleEntry.Type;

export const AgentBrowserNetworkEntry = Schema.Struct({
  seq: Schema.Int,
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Int),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type AgentBrowserNetworkEntry = typeof AgentBrowserNetworkEntry.Type;

/** What the page had already said before this viewer arrived. Sent once. */
const AgentBrowserAttachLogsEvent = Schema.Struct({
  type: Schema.Literal("logs"),
  console: Schema.Array(AgentBrowserConsoleEntry),
  network: Schema.Array(AgentBrowserNetworkEntry),
});

const AgentBrowserAttachConsoleEvent = Schema.Struct({
  type: Schema.Literal("console"),
  entry: AgentBrowserConsoleEntry,
});

const AgentBrowserAttachNetworkEvent = Schema.Struct({
  type: Schema.Literal("network"),
  entry: AgentBrowserNetworkEntry,
});

export const AgentBrowserAttachStreamEvent = Schema.Union([
  AgentBrowserAttachStatusEvent,
  AgentBrowserAttachFrameEvent,
  AgentBrowserAttachLogsEvent,
  AgentBrowserAttachConsoleEvent,
  AgentBrowserAttachNetworkEvent,
  AgentBrowserAttachClosedEvent,
]);
export type AgentBrowserAttachStreamEvent = typeof AgentBrowserAttachStreamEvent.Type;

const AgentBrowserSessionsSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  sessions: Schema.Array(AgentBrowserSessionSummary),
});

const AgentBrowserSessionsUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  session: AgentBrowserSessionSummary,
});

const AgentBrowserSessionsRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  ...AgentBrowserTabRef,
});

export const AgentBrowserSessionsStreamEvent = Schema.Union([
  AgentBrowserSessionsSnapshotEvent,
  AgentBrowserSessionsUpsertEvent,
  AgentBrowserSessionsRemoveEvent,
]);
export type AgentBrowserSessionsStreamEvent = typeof AgentBrowserSessionsStreamEvent.Type;

export class AgentBrowserUnavailableError extends Schema.TaggedErrorClass<AgentBrowserUnavailableError>()(
  "AgentBrowserUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return `Agent browser is unavailable: ${this.reason}`;
  }
}

export class AgentBrowserLaunchError extends Schema.TaggedErrorClass<AgentBrowserLaunchError>()(
  "AgentBrowserLaunchError",
  {
    executablePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to launch agent browser at ${this.executablePath}`;
  }
}

export class AgentBrowserSessionNotFoundError extends Schema.TaggedErrorClass<AgentBrowserSessionNotFoundError>()(
  "AgentBrowserSessionNotFoundError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `No agent browser session for thread ${this.threadId} tab ${this.tabId}`;
  }
}

export class AgentBrowserOperationError extends Schema.TaggedErrorClass<AgentBrowserOperationError>()(
  "AgentBrowserOperationError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    tabId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Agent browser ${this.operation} failed for thread ${this.threadId} tab ${this.tabId}`;
  }
}

export const AgentBrowserError = Schema.Union([
  AgentBrowserUnavailableError,
  AgentBrowserLaunchError,
  AgentBrowserSessionNotFoundError,
  AgentBrowserOperationError,
]);
export type AgentBrowserError = typeof AgentBrowserError.Type;
