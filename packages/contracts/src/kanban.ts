import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HermesRouteProvenance, HermesTaskUsageEstimate } from "./hermesRouting.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Kanban board contracts.
 *
 * A column is an id a card carries, not a member of a closed set. Which columns
 * the board *has* — their order, their names — is board settings
 * (`BoardSettings.columns`), so a board can be the shipped pipeline or "ideas /
 * research / implement / review" with nothing here changed.
 *
 * The shipped pipeline is {@link KANBAN_COLUMNS}: prompts → active → pr / done.
 * - prompts: capture + ready queue (structure/edit before Active; prepStatus gates launch)
 * - active: one coding-agent thread per card
 * - pr: review / PR stage
 * - done: the pull request merged. Clearing a card off the board is archiving
 *   it (`archivedAt`), which is a different thing and stays that way: Hermes
 *   reads Done as work that shipped.
 *
 * Hermes still knows those four by name — they are what its built-in rules are
 * written against. A column of your own holds cards and runs the rule rows you
 * give it; it is never routed by a name this file does not know.
 *
 * Legacy `draft` column ids normalize to `prompts` on read.
 */

export const KanbanCardId = TrimmedNonEmptyString.pipe(Schema.brand("KanbanCardId"));
export type KanbanCardId = typeof KanbanCardId.Type;

/**
 * A column id. Any id, because a column is a panel somebody put on the canvas
 * and there is no list of them anywhere.
 *
 * There used to be a `KANBAN_COLUMNS` const beside this and an
 * `isBuiltinComponentId` guard over it, which is the closed union this type
 * already contradicted on the next line. The four ids a fresh canvas starts
 * with are seed data and live where that is said —
 * `components/canvas/panels/boardColumns.ts`.
 */
export const ComponentId = TrimmedNonEmptyString;
export type ComponentId = typeof ComponentId.Type;

/**
 * Skill / Hermes structure progress while a card is still in **prompts**.
 * Active/pr/done cards are treated as ready regardless.
 */
/** `failed` = Hermes structure/route attempt did not land; eligible to retry. */
export const KANBAN_PREP_STATUSES = ["untouched", "processing", "ready", "failed"] as const;
export const KanbanPrepStatus = Schema.Literals(KANBAN_PREP_STATUSES);
export type KanbanPrepStatus = typeof KanbanPrepStatus.Type;

export const HERMES_OPERATION_STATUSES = ["running", "applied", "failed", "interrupted"] as const;
export const HermesOperationStatus = Schema.Literals(HERMES_OPERATION_STATUSES);
export type HermesOperationStatus = typeof HermesOperationStatus.Type;

export const HermesCardOperation = Schema.Struct({
  id: TrimmedNonEmptyString,
  method: TrimmedNonEmptyString,
  status: HermesOperationStatus,
  attempt: Schema.Number,
  detail: TrimmedNonEmptyString,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.DateTimeUtcFromString,
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type HermesCardOperation = typeof HermesCardOperation.Type;

/**
 * Image or video the user attached when capturing a card. Bytes live on disk
 * under the server attachments dir; the board only carries this metadata.
 * Hermes sets `include` when structuring — false means skip for thread/prompt
 * context; omitted media never invents empty slots.
 */
export const KANBAN_CARD_ATTACHMENT_KINDS = ["image", "video"] as const;
export const KanbanCardAttachmentKind = Schema.Literals(KANBAN_CARD_ATTACHMENT_KINDS);
export type KanbanCardAttachmentKind = typeof KanbanCardAttachmentKind.Type;

export const KANBAN_CARD_MAX_ATTACHMENTS = 8;
export const KANBAN_CARD_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const KANBAN_CARD_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const KANBAN_CARD_MAX_ATTACHMENT_DATA_URL_CHARS = 70_000_000;

export const KanbanCardAttachment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: KanbanCardAttachmentKind,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Number,
  /** Hermes keeps this for launch/context when true; default true until judged. */
  include: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type KanbanCardAttachment = typeof KanbanCardAttachment.Type;

/** Upload payload on create — data URL is written to disk, never listed back. */
export const KanbanUploadCardAttachment = Schema.Struct({
  kind: KanbanCardAttachmentKind,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Number,
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(KANBAN_CARD_MAX_ATTACHMENT_DATA_URL_CHARS),
  ),
});
export type KanbanUploadCardAttachment = typeof KanbanUploadCardAttachment.Type;

/** Provenance for one automated column move: which rule, and when. */
export const KanbanRuleMove = Schema.Struct({
  /** Tick-log rule id, e.g. `mergeable-pr`. */
  rule: TrimmedNonEmptyString,
  from: Schema.NullOr(ComponentId),
  to: ComponentId,
  at: Schema.DateTimeUtcFromString,
});
export type KanbanRuleMove = typeof KanbanRuleMove.Type;

/**
 * When the card first reached each stage, projected off its own `column_move`
 * history. A card carries its whole clock at every column, so `createdAt` →
 * `shippedAt` reads the same in Done as it did in Active.
 */
export const KanbanCardTimeline = Schema.Struct({
  /** First move into `active` — when a coding agent took the card. */
  launchedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** First move into `pr`. */
  prOpenedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** First move into `done` — the ship. */
  shippedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type KanbanCardTimeline = typeof KanbanCardTimeline.Type;

/**
 * What the card's linked thread has spent, rolled up from the thread's own
 * per-turn context-window snapshots. Null until the card has a thread that
 * reported usage.
 */
export const KanbanCardTokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** input + output. Cached input is already counted inside `inputTokens`. */
  totalTokens: Schema.Number,
  /** Turns the rollup covers. */
  turns: Schema.Number,
  /** Newest snapshot the rollup read. */
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type KanbanCardTokenUsage = typeof KanbanCardTokenUsage.Type;

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  title: TrimmedNonEmptyString,
  /** Free-form prompt / description body. May be empty. */
  body: TrimmedString,
  /** The component holding this card. A card sits at one, and only one. */
  at: ComponentId,
  /** Sort key within that component; lower sorts first. */
  position: Schema.Number,
  /** Thread this card is being worked in, once a session is started. */
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  /** Pull request URL once the card reaches the PR column. */
  prUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** Pull request title as the forge accepted it. The card's own title is the fallback. */
  prTitle: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Pull request number, so the card can link `#1450` without parsing the URL. */
  prNumber: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * Target project for Active launch. Hermes routes it; auto-launch only
   * happens when projectId is already set (never a guessed project).
   */
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Independent authority for a user-pinned versus Hermes-resolved project. */
  projectRouteProvenance: Schema.NullOr(HermesRouteProvenance).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Provider instance and model to use when this card launches. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Human-readable explanation for the selected route. Authority is carried
   * separately by modelRouteProvenance; never infer it from this field.
   */
  modelRouteReason: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Structured authority for the selection. This replaces inferring human vs
   * Hermes from whether modelRouteReason happens to be null.
   */
  modelRouteProvenance: Schema.NullOr(HermesRouteProvenance).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Percentage-of-capacity estimate shown on the card for the selected route. */
  modelRouteUsage: Schema.NullOr(HermesTaskUsageEstimate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Branch this card's worktree is cut from. Null falls back to the project's
   * `defaultBaseBranch`, then to the repo's own default branch — so a long-lived
   * integration branch is set once on the project and overridden per card.
   */
  baseBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Prompts-column skill/structure progress: untouched | processing | ready.
   * Active/pr/done cards are treated as ready regardless.
   */
  prepStatus: KanbanPrepStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("untouched" as const)),
  ),
  /** Composer media surviving Draft → structure → launch. Empty when unused. */
  attachments: Schema.Array(KanbanCardAttachment).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Latest durable Hermes mutation receipt for this card. */
  hermesOperation: Schema.NullOr(HermesCardOperation).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The rule that made this card's most recent column move, projected off the
   * card's own history — null when a human made it. Card history is the store;
   * this is the board's read of its newest `column_move` row.
   */
  lastRuleMove: Schema.NullOr(KanbanRuleMove).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  /**
   * When the card last entered its current column — the clock the board face
   * shows. `updatedAt` cannot answer it: any edit resets that.
   */
  columnEnteredAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Set when the card is archived off the board. Recoverable, never deleted. */
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Stage clock: launched / PR / shipped, projected off card history. */
  timeline: KanbanCardTimeline.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ launchedAt: null, prOpenedAt: null, shippedAt: null }),
    ),
  ),
  /** Measured spend of the linked thread. Null before the thread reports any. */
  tokenUsage: Schema.NullOr(KanbanCardTokenUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type KanbanCard = typeof KanbanCard.Type;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const KanbanListInput = Schema.Struct({
  /** Archived cards are off the board; the Archive page and restore need them. */
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type KanbanListInput = typeof KanbanListInput.Type;

/** One thing Hermes did to one card on its last tick. */
export const HermesCardActivity = Schema.Struct({
  cardId: Schema.String,
  /** Past tense, card-side: "structured", "moved to Prompts", "launched". */
  action: Schema.String,
  at: Schema.String,
  ok: Schema.Boolean,
});
export type HermesCardActivity = typeof HermesCardActivity.Type;

export const HERMES_WATCH_KINDS = [
  "structure",
  "route",
  "review",
  "blocked",
  "answer",
  "helper",
  "message",
] as const;
export const HermesWatchKind = Schema.Literals(HERMES_WATCH_KINDS);
export type HermesWatchKind = typeof HermesWatchKind.Type;

/**
 * One card Hermes is carrying in its judgment queue. A card can sit in the
 * queue tick after tick while the model decides nothing, which is invisible
 * from the board: `reviews` is the count of model looks that changed nothing,
 * so a card that is being re-judged forever says so on its face.
 */
export const HermesCardWatch = Schema.Struct({
  cardId: Schema.String,
  kind: HermesWatchKind,
  /** Verbatim queue line — why Hermes says this card is undecided. */
  why: Schema.String,
  /** Model looks at this card that left the board unchanged. */
  reviews: Schema.Number,
  /** When the card entered the queue and stayed in it. */
  sinceAt: Schema.String,
  /** Last model look, null while the card is queued but not yet judged. */
  lastReviewAt: Schema.NullOr(Schema.String),
  /** Enough fruitless looks that another one will not help. */
  stalled: Schema.Boolean,
});
export type HermesCardWatch = typeof HermesCardWatch.Type;

/** Board-chip view of the Hermes brain (same `t3j.service` as the board). */
export const HermesBoardStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** The loop is scheduled and ticking, not merely switched on. */
  running: Schema.Boolean,
  /** A tick is in flight right now. A tick may outlast its own interval. */
  busy: Schema.Boolean,
  intervalMs: Schema.Number,
  model: Schema.String,
  /** Last cheap scheduler check, including checks that did not call a model. */
  lastHeartbeatAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Last scheduler check that called a Hermes backend. */
  lastModelAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Why the latest heartbeat skipped the model. Null after a semantic run. */
  lastSkipReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * True when `lastSkipReason` is a failing box check (no forge auth, no
   * writable disk, …), not routine "nothing to do". A box check blocks every
   * tick until it is fixed, so the chip reads this to warn rather than say
   * "watching" in the same green it uses for an idle board.
   */
  lastSkipIsBoxBlock: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastBeatAt: Schema.NullOr(Schema.String),
  lastSummary: Schema.NullOr(Schema.String),
  lastTier: Schema.NullOr(Schema.String),
  /** When the loop next fires. Null while nothing is scheduled. */
  nextTickAt: Schema.NullOr(Schema.String),
  /** Last tick's failure, verbatim. Null when the last tick was clean. */
  lastError: Schema.NullOr(Schema.String),
  /**
   * Why the board brain's `{instanceId, model}` selection resolves to no
   * transport. Null when it resolves. A board that has this set fails every
   * tick it takes, so the chip says it rather than showing an idle green until
   * the next card happens to arrive.
   */
  providerError: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Ticks that have failed back to back. Reset by the first clean tick. */
  consecutiveFailures: Schema.Number,
  /**
   * Brain on, but every structure→launch policy off: it will tick and touch
   * nothing. The chip has to say so — this is the state that reads as broken.
   */
  pipelineIdle: Schema.Boolean,
  /** What the last tick did, per card. Drives the per-card "applied" badge. */
  cardActivity: Schema.Array(HermesCardActivity),
  /** Cards the loop is still undecided about, with their fruitless-look count. */
  cardWatch: Schema.Array(HermesCardWatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Deadline by which an unchanged actionable board is re-judged anyway. The
   * tick interval is not the answer for a parked card: an unchanged snapshot
   * skips the model, so this is when the card is actually looked at again.
   */
  nextModelCheckAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HermesBoardStatus = typeof HermesBoardStatus.Type;

export const KANBAN_PR_CHECK_STATES = ["passing", "failing", "pending", "unknown"] as const;
export const KanbanPrCheckState = Schema.Literals(KANBAN_PR_CHECK_STATES);
export type KanbanPrCheckState = typeof KanbanPrCheckState.Type;

export const KANBAN_PR_CHECK_UNKNOWN_REASONS = ["no_checks", "unavailable"] as const;
export const KanbanPrCheckUnknownReason = Schema.Literals(KANBAN_PR_CHECK_UNKNOWN_REASONS);
export type KanbanPrCheckUnknownReason = typeof KanbanPrCheckUnknownReason.Type;

/** Forge CI verdict for one pull request, as the board last saw it. */
export const KanbanCiChecks = Schema.Struct({
  /** `unknown` when the forge reports no checks at all — not a pass. */
  state: KanbanPrCheckState,
  total: Schema.Number,
  passing: Schema.Number,
  failing: Schema.Number,
  pending: Schema.Number,
  /** Names of the red checks, forge-verbatim. Empty unless `state` is failing. */
  failingNames: Schema.Array(Schema.String),
  /** First failing check's run URL, when the forge gave one. */
  failingUrl: Schema.NullOr(Schema.String),
  /** Why an unknown verdict is unknown. Null for real pending/pass/fail states. */
  unknownReason: Schema.NullOr(KanbanPrCheckUnknownReason).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Forge/provider failure detail safe to put in UI. Null unless the read failed. */
  unknownDetail: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  checkedAt: Schema.DateTimeUtcFromString,
});
export type KanbanCiChecks = typeof KanbanCiChecks.Type;

/** Durable forge CI verdict for one card's PR. */
export const KanbanPrChecks = Schema.Struct({
  cardId: KanbanCardId,
  ...KanbanCiChecks.fields,
});
export type KanbanPrChecks = typeof KanbanPrChecks.Type;

export const KanbanListResult = Schema.Struct({
  cards: Schema.Array(KanbanCard),
  hermes: Schema.optionalKey(HermesBoardStatus),
  /** One entry per card whose PR checks the board has read. */
  prChecks: Schema.optionalKey(Schema.Array(KanbanPrChecks)),
});
export type KanbanListResult = typeof KanbanListResult.Type;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const KanbanCreateCardInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: Schema.optionalKey(TrimmedString),
  /** Defaults to the seed intake component when omitted. */
  at: Schema.optionalKey(ComponentId),
  prepStatus: Schema.optionalKey(KanbanPrepStatus),
  /** Optional target project for later Active launch. */
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  projectRouteProvenance: Schema.optionalKey(Schema.NullOr(HermesRouteProvenance)),
  /** Optional thread link when a coding thread is mirrored onto the board. */
  threadId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  modelRouteReason: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  modelRouteProvenance: Schema.optionalKey(Schema.NullOr(HermesRouteProvenance)),
  modelRouteUsage: Schema.optionalKey(Schema.NullOr(HermesTaskUsageEstimate)),
  /** Branch to cut this card's worktree from; null uses the project default. */
  baseBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** Image/video uploads from the board composer. Omitted on plain-text sends. */
  attachments: Schema.optionalKey(
    Schema.Array(KanbanUploadCardAttachment).check(Schema.isMaxLength(KANBAN_CARD_MAX_ATTACHMENTS)),
  ),
});
export type KanbanCreateCardInput = typeof KanbanCreateCardInput.Type;

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const KanbanUpdateCardInput = Schema.Struct({
  id: KanbanCardId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  body: Schema.optionalKey(TrimmedString),
  at: Schema.optionalKey(ComponentId),
  position: Schema.optionalKey(Schema.Number),
  threadId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  prUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  prTitle: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  prNumber: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  projectRouteProvenance: Schema.optionalKey(Schema.NullOr(HermesRouteProvenance)),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Human-readable route explanation; provenance carries authority. */
  modelRouteReason: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  modelRouteProvenance: Schema.optionalKey(Schema.NullOr(HermesRouteProvenance)),
  modelRouteUsage: Schema.optionalKey(Schema.NullOr(HermesTaskUsageEstimate)),
  /** Branch to cut this card's worktree from; null uses the project default. */
  baseBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  prepStatus: Schema.optionalKey(KanbanPrepStatus),
  /**
   * Replace the card's attachment metadata (include flags). Ids must already
   * exist on the card — this does not upload new bytes.
   */
  attachments: Schema.optionalKey(Schema.Array(KanbanCardAttachment)),
  /** True archives the card off the board; false restores it. */
  archived: Schema.optionalKey(Schema.Boolean),
  /**
   * Rule id to stamp on the `column_move` history row this update writes. The
   * card's provenance chip reads it back; a human move leaves it unset.
   */
  movedBy: Schema.optionalKey(TrimmedNonEmptyString),
});
export type KanbanUpdateCardInput = typeof KanbanUpdateCardInput.Type;

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const KanbanDeleteCardInput = Schema.Struct({
  id: KanbanCardId,
});
export type KanbanDeleteCardInput = typeof KanbanDeleteCardInput.Type;

export const KanbanDeleteCardResult = Schema.Struct({
  id: KanbanCardId,
  deleted: Schema.Boolean,
});
export type KanbanDeleteCardResult = typeof KanbanDeleteCardResult.Type;

export const KanbanCardResult = KanbanCard;
export type KanbanCardResult = typeof KanbanCardResult.Type;

// ---------------------------------------------------------------------------
// PR pipeline — the board owns git, the coding agent does not
// ---------------------------------------------------------------------------

/** Open (or adopt) the pull request for an Active card's thread. */
export const KanbanOpenPrInput = Schema.Struct({
  id: KanbanCardId,
});
export type KanbanOpenPrInput = typeof KanbanOpenPrInput.Type;

export const KanbanOpenPrResult = Schema.Struct({
  card: KanbanCard,
  prUrl: TrimmedNonEmptyString,
  /** True when the branch already had an open PR and it was reused. */
  reusedExistingPr: Schema.Boolean,
  /** Empty when the worktree had nothing left to commit. */
  commitSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type KanbanOpenPrResult = typeof KanbanOpenPrResult.Type;

/** Merge an already-open pull request. Fails loudly rather than moving the card. */
export const KanbanMergePrInput = Schema.Struct({
  id: KanbanCardId,
});
export type KanbanMergePrInput = typeof KanbanMergePrInput.Type;

export const KanbanMergePrResult = Schema.Struct({
  card: KanbanCard,
  prUrl: TrimmedNonEmptyString,
  mergeCommitSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type KanbanMergePrResult = typeof KanbanMergePrResult.Type;

/**
 * Close a pull request without merging it. `reference` targets a PR this card
 * does not itself own — an orphan-reconcile card closing the PR named in its
 * own body — and defaults to the card's own `prUrl` when omitted.
 */
export const KanbanClosePrInput = Schema.Struct({
  id: KanbanCardId,
  reference: Schema.optionalKey(TrimmedNonEmptyString),
});
export type KanbanClosePrInput = typeof KanbanClosePrInput.Type;

export const KanbanClosePrResult = Schema.Struct({
  card: KanbanCard,
  prUrl: TrimmedNonEmptyString,
  closed: Schema.Boolean,
});
export type KanbanClosePrResult = typeof KanbanClosePrResult.Type;

// ---------------------------------------------------------------------------
// Card history (append-only audit trail — never deleted with the card)
// ---------------------------------------------------------------------------

export const KANBAN_CARD_HISTORY_KINDS = [
  "created",
  "body_edit",
  "skill",
  "polish",
  "promote",
  "column_move",
  "launch",
  "error",
] as const;
export const KanbanCardHistoryKind = Schema.Literals(KANBAN_CARD_HISTORY_KINDS);
export type KanbanCardHistoryKind = typeof KanbanCardHistoryKind.Type;

export const KanbanCardHistoryEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  cardId: KanbanCardId,
  kind: KanbanCardHistoryKind,
  skillId: Schema.NullOr(TrimmedString),
  inputText: Schema.NullOr(TrimmedString),
  outputText: Schema.NullOr(TrimmedString),
  errorText: Schema.NullOr(TrimmedString),
  modelSelection: Schema.NullOr(ModelSelection),
  /** Free-form JSON bag (runId, fromColumn, toColumn, …). */
  meta: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  createdAt: Schema.DateTimeUtcFromString,
});
export type KanbanCardHistoryEntry = typeof KanbanCardHistoryEntry.Type;

export const KanbanListCardHistoryInput = Schema.Struct({
  cardId: KanbanCardId,
});
export type KanbanListCardHistoryInput = typeof KanbanListCardHistoryInput.Type;

export const KanbanListCardHistoryResult = Schema.Struct({
  entries: Schema.Array(KanbanCardHistoryEntry),
});
export type KanbanListCardHistoryResult = typeof KanbanListCardHistoryResult.Type;

export const KanbanAppendCardHistoryEntryInput = Schema.Struct({
  kind: KanbanCardHistoryKind,
  skillId: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  inputText: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  outputText: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  errorText: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
export type KanbanAppendCardHistoryEntryInput = typeof KanbanAppendCardHistoryEntryInput.Type;

export const KanbanAppendCardHistoryInput = Schema.Struct({
  cardId: KanbanCardId,
  entries: Schema.Array(KanbanAppendCardHistoryEntryInput),
});
export type KanbanAppendCardHistoryInput = typeof KanbanAppendCardHistoryInput.Type;

export const KanbanAppendCardHistoryResult = Schema.Struct({
  cardId: KanbanCardId,
  appended: Schema.Number,
});
export type KanbanAppendCardHistoryResult = typeof KanbanAppendCardHistoryResult.Type;

// ---------------------------------------------------------------------------
// Open pull requests — the review list, bound to a set of repos
// ---------------------------------------------------------------------------

/** One open pull request on one of the board's repos. */
export const KanbanOpenPr = Schema.Struct({
  /** The board project the repo is checked out as. */
  projectId: TrimmedNonEmptyString,
  /** `owner/name`, or the remote URL when the forge gave no slug. */
  repo: TrimmedNonEmptyString,
  number: Schema.Number,
  title: TrimmedString,
  url: Schema.String,
  headRefName: TrimmedString,
  baseRefName: TrimmedString,
  /** Current forge CI verdict; unknown always carries a reason. */
  checks: KanbanCiChecks,
  /** Last forge activity, for sorting a list by what moved. Null when the forge gave none. */
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type KanbanOpenPr = typeof KanbanOpenPr.Type;

export const KanbanListOpenPrsInput = Schema.Struct({
  /**
   * Repos to read, as `owner/name` or the bare name. Empty is every repo the
   * board has a project for; a repo no project answers to fails the call.
   */
  repos: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Pull requests per repo. Default 20, max 50. */
  limit: Schema.optionalKey(Schema.Number),
});
export type KanbanListOpenPrsInput = typeof KanbanListOpenPrsInput.Type;

export const KanbanListOpenPrsResult = Schema.Struct({
  prs: Schema.Array(KanbanOpenPr),
});
export type KanbanListOpenPrsResult = typeof KanbanListOpenPrsResult.Type;

// ---------------------------------------------------------------------------
// Open issues — the issue list, bound to a set of repos
// ---------------------------------------------------------------------------

/** One open issue on one of the board's repos. */
export const KanbanOpenIssue = Schema.Struct({
  /** The board project the repo is checked out as. */
  projectId: TrimmedNonEmptyString,
  /** `owner/name`, or the remote URL when the forge gave no slug. */
  repo: TrimmedNonEmptyString,
  number: Schema.Number,
  title: TrimmedString,
  url: Schema.String,
  /** The forge's own labels, in forge order. */
  labels: Schema.Array(TrimmedString),
});
export type KanbanOpenIssue = typeof KanbanOpenIssue.Type;

export const KanbanListOpenIssuesInput = Schema.Struct({
  /**
   * Repos to read, as `owner/name` or the bare name. Empty is every repo the
   * board has a project for; a repo no project answers to fails the call.
   */
  repos: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Issues per repo. Default 20, max 50. */
  limit: Schema.optionalKey(Schema.Number),
});
export type KanbanListOpenIssuesInput = typeof KanbanListOpenIssuesInput.Type;

export const KanbanListOpenIssuesResult = Schema.Struct({
  issues: Schema.Array(KanbanOpenIssue),
});
export type KanbanListOpenIssuesResult = typeof KanbanListOpenIssuesResult.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class KanbanCardNotFoundError extends Schema.TaggedErrorClass<KanbanCardNotFoundError>()(
  "KanbanCardNotFoundError",
  {
    id: KanbanCardId,
  },
) {
  override get message(): string {
    return `Kanban card '${this.id}' was not found.`;
  }
}

export class KanbanPersistenceError extends Schema.TaggedErrorClass<KanbanPersistenceError>()(
  "KanbanPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Kanban persistence failed during ${this.operation}${
      this.detail ? `: ${this.detail}` : "."
    }`;
  }
}

/**
 * The forge would not answer a board read. Deliberately outside `KanbanError`:
 * it is not the store failing, and a caller listing pull requests has to be able
 * to tell "no open pull requests" from "nobody could say".
 */
export class KanbanForgeError extends Schema.TaggedErrorClass<KanbanForgeError>()(
  "KanbanForgeError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Kanban could not read the forge during ${this.operation}: ${this.detail}`;
  }
}

export const KanbanError = Schema.Union([KanbanCardNotFoundError, KanbanPersistenceError]);
export type KanbanError = typeof KanbanError.Type;
export type KanbanErrorType = KanbanCardNotFoundError | KanbanPersistenceError;
