/**
 * KanbanStore – server-persisted kanban board.
 *
 * CRUD over the `kanban_cards` table. Cards flow prompts → active → pr / done.
 * Prompts = capture + ready queue (prepStatus gates launch); Active = coding thread; PR = review.
 * Persisting on the server keeps the board in sync across devices.
 *
 * @module KanbanStore
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as WorktreeReaper from "../vcs/WorktreeReaper.ts";

import { type CardUsageSnapshotRow, rollUpCardTokenUsage } from "./cardTokenUsage.ts";

import {
  type KanbanAppendCardHistoryEntryInput,
  type KanbanAppendCardHistoryInput,
  type KanbanAppendCardHistoryResult,
  type KanbanCard,
  type KanbanCardAttachment,
  type KanbanCardHistoryEntry,
  type HermesCardOperation,
  HermesRouteProvenance,
  HermesTaskUsageEstimate,
  KanbanCardId,
  KanbanCardNotFoundError,
  type ComponentId,
  type KanbanCreateCardInput,
  type KanbanDeleteCardInput,
  type KanbanDeleteCardResult,
  type KanbanErrorType,
  type KanbanListCardHistoryInput,
  type KanbanListInput,
  type KanbanListCardHistoryResult,
  type KanbanListResult,
  type KanbanPrChecks,
  KanbanPrChecks as KanbanPrChecksSchema,
  KanbanPersistenceError,
  type KanbanUpdateCardInput,
  type ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import {
  decodeAttachmentsJson,
  encodeAttachmentsJson,
  persistKanbanUploads,
} from "./kanbanAttachments.ts";
import { explainMoveBlock } from "@t3tools/shared/moveGate";
import { fireMoment } from "./components/moments.ts";

const DEFAULT_COLUMN: ComponentId = "prompts";

/**
 * Map legacy column ids so older rows still decode after pipeline changes.
 *
 * Anything else is kept as written: which columns a board has is board settings
 * (`BoardSettings.columns`), so the store cannot know whether `research` is a
 * typo or a column somebody made. Collapsing it to Prompts would delete the
 * board's own lanes on the next read.
 */
export function normalizeComponentId(raw: string): ComponentId {
  const id = raw.trim();
  if (id === "main") return "pr";
  // The pre-collapse Draft inbox: a lane the board removed, not one you name.
  if (id === "draft") return "prompts";
  return id.length === 0 ? DEFAULT_COLUMN : id;
}

function normalizePrepStatus(raw: unknown): "untouched" | "processing" | "ready" | "failed" {
  if (raw === "processing" || raw === "ready" || raw === "untouched" || raw === "failed") {
    return raw;
  }
  return "untouched";
}

// The row shape returned from SQLite (snake_case aliased to camelCase).
const KanbanCardRow = Schema.Struct({
  id: KanbanCardId,
  title: Schema.String,
  body: Schema.String,
  column: Schema.String,
  position: Schema.Number,
  threadId: Schema.NullOr(Schema.String),
  prUrl: Schema.NullOr(Schema.String),
  prTitle: Schema.optional(Schema.NullOr(Schema.String)),
  prNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  projectId: Schema.NullOr(Schema.String),
  modelSelectionJson: Schema.NullOr(Schema.String),
  modelRouteReason: Schema.optional(Schema.NullOr(Schema.String)),
  baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  prepStatus: Schema.optional(Schema.String),
  hermesOperationId: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationMethod: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationStatus: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationAttempt: Schema.optional(Schema.NullOr(Schema.Number)),
  hermesOperationDetail: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationError: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
  hermesOperationFinishedAt: Schema.optional(Schema.NullOr(Schema.String)),
  lastMoveMetaJson: Schema.optional(Schema.NullOr(Schema.String)),
  lastMoveAt: Schema.optional(Schema.NullOr(Schema.String)),
  attachmentsJson: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  columnEnteredAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  archivedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  launchedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  prOpenedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  shippedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
});

// SQLite hands back untyped columns; decode leniently then normalize.
const KanbanCardRawRow = Schema.Struct({
  id: Schema.String,
  title: Schema.Unknown,
  body: Schema.Unknown,
  column: Schema.Unknown,
  position: Schema.Unknown,
  threadId: Schema.Unknown,
  prUrl: Schema.Unknown,
  prTitle: Schema.optional(Schema.Unknown),
  prNumber: Schema.optional(Schema.Unknown),
  projectId: Schema.optional(Schema.Unknown),
  modelSelectionJson: Schema.optional(Schema.Unknown),
  modelRouteReason: Schema.optional(Schema.Unknown),
  baseBranch: Schema.optional(Schema.Unknown),
  prepStatus: Schema.optional(Schema.Unknown),
  hermesOperationId: Schema.optional(Schema.Unknown),
  hermesOperationMethod: Schema.optional(Schema.Unknown),
  hermesOperationStatus: Schema.optional(Schema.Unknown),
  hermesOperationAttempt: Schema.optional(Schema.Unknown),
  hermesOperationDetail: Schema.optional(Schema.Unknown),
  hermesOperationError: Schema.optional(Schema.Unknown),
  hermesOperationStartedAt: Schema.optional(Schema.Unknown),
  hermesOperationFinishedAt: Schema.optional(Schema.Unknown),
  lastMoveMetaJson: Schema.optional(Schema.Unknown),
  lastMoveAt: Schema.optional(Schema.Unknown),
  attachmentsJson: Schema.optional(Schema.Unknown),
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
  columnEnteredAt: Schema.optional(Schema.Unknown),
  archivedAt: Schema.optional(Schema.Unknown),
  launchedAt: Schema.optional(Schema.Unknown),
  prOpenedAt: Schema.optional(Schema.Unknown),
  shippedAt: Schema.optional(Schema.Unknown),
});

const decodeKanbanCardRow = Schema.decodeUnknownEffect(KanbanCardRow);

const RuleMoveMeta = Schema.Struct({
  rule: Schema.String,
  fromColumn: Schema.optional(Schema.String),
  toColumn: Schema.String,
});
const decodeRuleMoveMeta = Schema.decodeUnknownOption(RuleMoveMeta);

/**
 * The newest `column_move` history row, when a rule wrote it. A human move
 * carries no `rule`, so it reads as null and the card's chip disappears —
 * which is right: the last move is the provenance.
 */
function toRuleMove(metaJson: string | null, at: string | null): KanbanCard["lastRuleMove"] {
  if (!metaJson || !at) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaJson);
  } catch {
    return null;
  }
  return Option.match(decodeRuleMoveMeta(parsed), {
    onNone: () => null,
    onSome: (meta) =>
      meta.rule.trim().length === 0
        ? null
        : {
            rule: meta.rule.trim(),
            from: meta.fromColumn ? normalizeComponentId(meta.fromColumn) : null,
            to: normalizeComponentId(meta.toColumn),
            at: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(at),
          },
  });
}

const ModelRouteMeta = Schema.Struct({
  version: Schema.Literal(1),
  reason: Schema.NullOr(Schema.String),
  projectProvenance: Schema.NullOr(HermesRouteProvenance),
  provenance: Schema.NullOr(HermesRouteProvenance),
  usage: Schema.NullOr(HermesTaskUsageEstimate),
});
type ModelRouteMeta = typeof ModelRouteMeta.Type;
const decodeModelRouteMetaOption = Schema.decodeUnknownOption(ModelRouteMeta);

function legacyModelRouteMeta(reason: string | null): ModelRouteMeta {
  return {
    version: 1,
    reason,
    projectProvenance: null,
    provenance: reason === null ? null : { source: "fallback", skill: null, at: "legacy" },
    usage: null,
  };
}

function decodeModelRouteMeta(raw: string | null | undefined): ModelRouteMeta {
  if (!raw) return legacyModelRouteMeta(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return legacyModelRouteMeta(raw);
  }
  return Option.getOrElse(decodeModelRouteMetaOption(parsed), () => legacyModelRouteMeta(raw));
}

function encodeModelRouteMeta(input: Omit<ModelRouteMeta, "version">): string | null {
  if (input.projectProvenance === null && input.provenance === null && input.usage === null)
    return input.reason;
  return JSON.stringify({ version: 1, ...input } satisfies ModelRouteMeta);
}

function toKanbanCard(row: typeof KanbanCardRow.Type): KanbanCard {
  const hermesOperation: HermesCardOperation | null =
    row.hermesOperationId &&
    row.hermesOperationMethod &&
    row.hermesOperationStatus &&
    row.hermesOperationAttempt !== null &&
    row.hermesOperationAttempt !== undefined &&
    row.hermesOperationDetail &&
    row.hermesOperationStartedAt
      ? {
          id: row.hermesOperationId,
          method: row.hermesOperationMethod,
          status: row.hermesOperationStatus as HermesCardOperation["status"],
          attempt: row.hermesOperationAttempt,
          detail: row.hermesOperationDetail,
          error: row.hermesOperationError ?? null,
          startedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
            row.hermesOperationStartedAt,
          ),
          finishedAt: row.hermesOperationFinishedAt
            ? Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(row.hermesOperationFinishedAt)
            : null,
        }
      : null;
  const routeMeta = decodeModelRouteMeta(row.modelRouteReason);
  return {
    lastRuleMove: toRuleMove(row.lastMoveMetaJson ?? null, row.lastMoveAt ?? null),
    id: row.id,
    title: row.title,
    body: row.body,
    at: normalizeComponentId(row.column),
    position: row.position,
    threadId: row.threadId,
    prUrl: row.prUrl,
    prTitle: row.prTitle && row.prTitle.length > 0 ? row.prTitle : null,
    prNumber: row.prNumber ?? null,
    projectId:
      row.projectId && row.projectId.length > 0 ? (row.projectId as KanbanCard["projectId"]) : null,
    projectRouteProvenance: routeMeta.projectProvenance,
    modelSelection:
      row.modelSelectionJson && row.modelSelectionJson.length > 0
        ? (JSON.parse(row.modelSelectionJson) as KanbanCard["modelSelection"])
        : null,
    modelRouteReason: routeMeta.reason,
    modelRouteProvenance: routeMeta.provenance,
    modelRouteUsage: routeMeta.usage,
    baseBranch: row.baseBranch && row.baseBranch.length > 0 ? row.baseBranch : null,
    prepStatus: normalizePrepStatus(row.prepStatus),
    attachments: decodeAttachmentsJson(
      typeof row.attachmentsJson === "string" ? row.attachmentsJson : null,
    ),
    hermesOperation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    columnEnteredAt: row.columnEnteredAt ?? row.createdAt,
    archivedAt: row.archivedAt ?? null,
    timeline: toTimeline(row),
    tokenUsage: null,
  };
}

/**
 * A card only has a `column_move` row for a column it moved into. One created
 * straight into `pr` — an adopted orphan pull request — never moved anywhere,
 * and reading history alone would call it un-opened while it sits in PR. Where
 * the card stands is the stamp of last resort.
 */
function toTimeline(row: typeof KanbanCardRow.Type): KanbanCard["timeline"] {
  const at = normalizeComponentId(row.column);
  const enteredAt = row.columnEnteredAt ?? row.createdAt;
  const stampFor = (
    moved: DateTime.Utc | null | undefined,
    stage: ComponentId,
  ): DateTime.Utc | null => moved ?? (at === stage ? enteredAt : null);
  return {
    launchedAt: stampFor(row.launchedAt, "active"),
    prOpenedAt: stampFor(row.prOpenedAt, "pr"),
    shippedAt: stampFor(row.shippedAt, "done"),
  };
}

/** First arrival in a column, from the card's own append-only move history. */
function firstMoveInto(column: string): string {
  return `(SELECT MIN(h.created_at) FROM kanban_card_history h
    WHERE h.card_id = kanban_cards.id AND h.kind = 'column_move'
      AND json_extract(h.meta_json, '$.toColumn') = '${column}')`;
}

const SELECT_COLUMNS = `
  id AS "id",
  title AS "title",
  body AS "body",
  column_id AS "column",
  position AS "position",
  thread_id AS "threadId",
  pr_url AS "prUrl",
  pr_title AS "prTitle",
  pr_number AS "prNumber",
  project_id AS "projectId",
  model_selection_json AS "modelSelectionJson",
  model_route_reason AS "modelRouteReason",
  base_branch AS "baseBranch",
  prep_status AS "prepStatus",
  (SELECT op.id FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationId",
  (SELECT op.method FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationMethod",
  (SELECT op.status FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationStatus",
  (SELECT op.attempt FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationAttempt",
  (SELECT op.detail FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationDetail",
  (SELECT op.error_text FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationError",
  (SELECT op.started_at FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationStartedAt",
  (SELECT op.finished_at FROM hermes_card_operations op WHERE op.card_id = kanban_cards.id ORDER BY op.updated_at DESC, op.id DESC LIMIT 1) AS "hermesOperationFinishedAt",
  (SELECT h.meta_json FROM kanban_card_history h WHERE h.card_id = kanban_cards.id AND h.kind = 'column_move' ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS "lastMoveMetaJson",
  (SELECT h.created_at FROM kanban_card_history h WHERE h.card_id = kanban_cards.id AND h.kind = 'column_move' ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS "lastMoveAt",
  attachments_json AS "attachmentsJson",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  column_entered_at AS "columnEnteredAt",
  archived_at AS "archivedAt",
  ${firstMoveInto("active")} AS "launchedAt",
  ${firstMoveInto("pr")} AS "prOpenedAt",
  ${firstMoveInto("done")} AS "shippedAt"
`;

const HistoryRawRow = Schema.Struct({
  id: Schema.Unknown,
  cardId: Schema.Unknown,
  kind: Schema.Unknown,
  skillId: Schema.optional(Schema.Unknown),
  inputText: Schema.optional(Schema.Unknown),
  outputText: Schema.optional(Schema.Unknown),
  errorText: Schema.optional(Schema.Unknown),
  modelSelectionJson: Schema.optional(Schema.Unknown),
  metaJson: Schema.optional(Schema.Unknown),
  createdAt: Schema.Unknown,
});

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value;
}

function toHistoryEntry(row: typeof HistoryRawRow.Type): KanbanCardHistoryEntry {
  const metaRaw = asNullableString(row.metaJson);
  let meta: KanbanCardHistoryEntry["meta"] = null;
  if (metaRaw && metaRaw.length > 0) {
    try {
      meta = JSON.parse(metaRaw) as KanbanCardHistoryEntry["meta"];
    } catch {
      meta = null;
    }
  }
  const modelRaw = asNullableString(row.modelSelectionJson);
  let modelSelection: KanbanCardHistoryEntry["modelSelection"] = null;
  if (modelRaw && modelRaw.length > 0) {
    try {
      modelSelection = JSON.parse(modelRaw) as KanbanCardHistoryEntry["modelSelection"];
    } catch {
      modelSelection = null;
    }
  }
  const createdAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(String(row.createdAt));
  return {
    id: String(row.id),
    cardId: KanbanCardId.make(String(row.cardId)),
    kind: row.kind as KanbanCardHistoryEntry["kind"],
    skillId: asNullableString(row.skillId),
    inputText: asNullableString(row.inputText),
    outputText: asNullableString(row.outputText),
    errorText: asNullableString(row.errorText),
    modelSelection,
    meta,
    createdAt,
  };
}

export class KanbanStore extends Context.Service<
  KanbanStore,
  {
    readonly list: (input?: KanbanListInput) => Effect.Effect<KanbanListResult, KanbanErrorType>;
    readonly create: (input: KanbanCreateCardInput) => Effect.Effect<KanbanCard, KanbanErrorType>;
    readonly update: (input: KanbanUpdateCardInput) => Effect.Effect<KanbanCard, KanbanErrorType>;
    readonly remove: (
      input: KanbanDeleteCardInput,
    ) => Effect.Effect<KanbanDeleteCardResult, KanbanErrorType>;
    readonly listHistory: (
      input: KanbanListCardHistoryInput,
    ) => Effect.Effect<KanbanListCardHistoryResult, KanbanErrorType>;
    readonly appendHistory: (
      input: KanbanAppendCardHistoryInput,
    ) => Effect.Effect<KanbanAppendCardHistoryResult, KanbanErrorType>;
    readonly listPrChecks: () => Effect.Effect<ReadonlyArray<KanbanPrChecks>, KanbanErrorType>;
    readonly savePrChecks: (input: {
      readonly cardId: KanbanCardId;
      readonly prUrl: string;
      readonly checks: KanbanPrChecks;
    }) => Effect.Effect<void, KanbanErrorType>;
  }
>()("t3/kanban/KanbanStore") {}

function persistenceError(operation: string) {
  return (cause: unknown): KanbanErrorType =>
    new KanbanPersistenceError({
      operation,
      detail: cause instanceof Error ? cause.message : undefined,
      cause,
    });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: KanbanCardRawRow,
    execute: () =>
      sql`SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM kanban_cards WHERE archived_at IS NULL ORDER BY column_id ASC, position ASC, created_at ASC`,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: KanbanCardRawRow,
    execute: () =>
      sql`SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM kanban_cards ORDER BY archived_at DESC, column_id ASC, position ASC, created_at ASC`,
  });

  const findRowById = SqlSchema.findOneOption({
    Request: KanbanCardId,
    Result: KanbanCardRawRow,
    execute: (id) => sql`SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM kanban_cards WHERE id = ${id}`,
  });

  const maxPositionInColumn = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ maxPosition: Schema.NullOr(Schema.Number) }),
    execute: (column) =>
      sql`SELECT MAX(position) AS "maxPosition" FROM kanban_cards WHERE column_id = ${column}`,
  });

  const decodeRow = (row: typeof KanbanCardRawRow.Type, operation: string) =>
    decodeKanbanCardRow(row).pipe(
      Effect.mapError((cause) => persistenceError(operation)(cause)),
      Effect.map(toKanbanCard),
    );

  /**
   * Fill in each card's measured spend from its linked thread. One query for
   * the whole set, newest snapshot per turn only — a card's usage is a read of
   * the thread record, never a second copy of it.
   */
  const attachTokenUsage = (
    cards: ReadonlyArray<KanbanCard>,
  ): Effect.Effect<ReadonlyArray<KanbanCard>, never> => {
    const threadIds = [...new Set(cards.flatMap((card) => (card.threadId ? [card.threadId] : [])))];
    if (threadIds.length === 0) return Effect.succeed(cards);
    return sql<{
      readonly threadId: string;
      readonly turnId: string | null;
      readonly createdAt: string;
      readonly payloadJson: string;
    }>`
      SELECT "threadId", "turnId", "createdAt", "payloadJson"
      FROM (
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          created_at AS "createdAt",
          payload_json AS "payloadJson",
          ROW_NUMBER() OVER (
            PARTITION BY thread_id, COALESCE(turn_id, activity_id)
            ORDER BY created_at DESC, activity_id DESC
          ) AS rn
        FROM projection_thread_activities
        WHERE kind = 'context-window.updated' AND thread_id IN ${sql.in(threadIds)}
      )
      WHERE rn = 1
    `.pipe(
      Effect.map((rows) => {
        const byThread = new Map<string, CardUsageSnapshotRow[]>();
        for (const row of rows) {
          let payload: unknown;
          try {
            payload = JSON.parse(row.payloadJson);
          } catch {
            continue;
          }
          const held = byThread.get(row.threadId) ?? [];
          held.push({ turnId: row.turnId, createdAt: row.createdAt, payload });
          byThread.set(row.threadId, held);
        }
        return cards.map((card) => {
          const snapshots = card.threadId ? byThread.get(card.threadId) : undefined;
          if (!snapshots) return card;
          return { ...card, tokenUsage: rollUpCardTokenUsage(snapshots) };
        });
      }),
      // Usage is a read of another projection: it decorates the card, it never
      // gates it. A board must still list when that projection cannot be read.
      Effect.orElseSucceed(() => cards),
    );
  };

  const list: KanbanStore["Service"]["list"] = (input) =>
    (input?.includeArchived === true ? listAllRows : listRows)(void 0).pipe(
      Effect.mapError(persistenceError("KanbanStore.list")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRow(row, "KanbanStore.list:decode")),
      ),
      Effect.flatMap(attachTokenUsage),
      Effect.map((cards) => ({ cards })),
    );

  const listPrChecks: KanbanStore["Service"]["listPrChecks"] = () =>
    sql<{ readonly checksJson: string }>`
      SELECT checks.checks_json AS "checksJson"
      FROM kanban_pr_checks checks
      INNER JOIN kanban_cards cards
        ON cards.id = checks.card_id AND cards.pr_url = checks.pr_url
    `.pipe(
      Effect.mapError(persistenceError("KanbanStore.listPrChecks")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(KanbanPrChecksSchema))(
            row.checksJson,
          ).pipe(Effect.mapError(persistenceError("KanbanStore.listPrChecks:decode"))),
        ),
      ),
    );

  const savePrChecks: KanbanStore["Service"]["savePrChecks"] = (input) => {
    const checksJson = Schema.encodeSync(Schema.fromJsonString(KanbanPrChecksSchema))(input.checks);
    return sql`
      INSERT INTO kanban_pr_checks (card_id, pr_url, checks_json, checked_at)
      VALUES (${input.cardId}, ${input.prUrl}, ${checksJson}, ${DateTime.formatIso(input.checks.checkedAt)})
      ON CONFLICT(card_id) DO UPDATE SET
        pr_url = excluded.pr_url,
        checks_json = excluded.checks_json,
        checked_at = excluded.checked_at
    `.pipe(Effect.mapError(persistenceError("KanbanStore.savePrChecks")), Effect.asVoid);
  };

  const getById = (id: KanbanCardId, operation: string) =>
    findRowById(id).pipe(
      Effect.mapError(persistenceError(operation)),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.fail(new KanbanCardNotFoundError({ id })),
          onSome: (row) => decodeRow(row, operation),
        }),
      ),
      Effect.flatMap((card) =>
        attachTokenUsage([card]).pipe(Effect.map((cards) => cards[0] ?? card)),
      ),
    );

  const create: KanbanStore["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const column = input.at ?? DEFAULT_COLUMN;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("KanbanStore.create:id")),
      );
      const id = KanbanCardId.make(uuid);
      const maxRow = yield* maxPositionInColumn(column).pipe(
        Effect.mapError(persistenceError("KanbanStore.create:position")),
      );
      const position = (maxRow.maxPosition ?? 0) + 1;
      const body = input.body ?? "";
      const prepStatus = input.prepStatus ?? "untouched";
      const projectId =
        input.projectId !== undefined && input.projectId !== null && input.projectId.length > 0
          ? input.projectId
          : null;
      const modelSelectionJson = input.modelSelection ? JSON.stringify(input.modelSelection) : null;
      const baseBranch = input.baseBranch ?? null;
      const threadId = input.threadId ?? null;

      let attachments: ReadonlyArray<KanbanCardAttachment> = [];
      const uploads = input.attachments ?? [];
      if (uploads.length > 0) {
        const config = yield* Effect.serviceOption(ServerConfig);
        if (Option.isNone(config)) {
          return yield* new KanbanPersistenceError({
            operation: "KanbanStore.create:attachments",
            detail: "Server attachments directory is unavailable.",
            cause: undefined,
          });
        }
        const ids: string[] = [];
        for (let i = 0; i < uploads.length; i++) {
          const attachmentId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(persistenceError("KanbanStore.create:attachmentId")),
          );
          ids.push(attachmentId);
        }
        const persisted = persistKanbanUploads({
          attachmentsDir: config.value.attachmentsDir,
          uploads,
          ids,
        });
        if (!persisted.ok) {
          return yield* new KanbanPersistenceError({
            operation: "KanbanStore.create:attachments",
            detail: persisted.error,
            cause: undefined,
          });
        }
        attachments = persisted.attachments;
      }
      const attachmentsJson = attachments.length > 0 ? encodeAttachmentsJson(attachments) : null;
      const modelRouteMeta = encodeModelRouteMeta({
        reason: input.modelRouteReason ?? null,
        projectProvenance: input.projectRouteProvenance ?? null,
        provenance: input.modelRouteProvenance ?? null,
        usage: input.modelRouteUsage ?? null,
      });

      yield* sql`
        INSERT INTO kanban_cards (
          id, title, body, column_id, position, thread_id, pr_url, project_id, model_selection_json, model_route_reason, base_branch, prep_status, attachments_json, created_at, updated_at, column_entered_at
        ) VALUES (
          ${id}, ${input.title}, ${body}, ${column}, ${position}, ${threadId}, NULL, ${projectId}, ${modelSelectionJson}, ${modelRouteMeta}, ${baseBranch}, ${prepStatus}, ${attachmentsJson}, ${nowIso}, ${nowIso}, ${nowIso}
        )
      `.pipe(Effect.mapError(persistenceError("KanbanStore.create:insert")));

      // Seed the permanent audit trail with the original prompt.
      const historyId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("KanbanStore.create:historyId")),
      );
      yield* sql`
        INSERT INTO kanban_card_history (
          id, card_id, kind, skill_id, input_text, output_text, error_text, model_selection_json, meta_json, created_at
        ) VALUES (
          ${historyId}, ${id}, ${"created"}, NULL, NULL, ${body}, NULL, ${modelSelectionJson},
          ${JSON.stringify({
            title: input.title,
            column,
            projectId,
            attachmentCount: attachments.length,
          })}, ${nowIso}
        )
      `.pipe(Effect.catch(() => Effect.void));

      return yield* getById(id, "KanbanStore.create:read");
    });

  const update: KanbanStore["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      // Read the current card first so callers get a typed not-found error and
      // so partial updates merge cleanly (including explicit null clears).
      const current = yield* getById(input.id, "KanbanStore.update:read");
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);

      const title = input.title ?? current.title;
      const body = input.body ?? current.body;
      const column = input.at ?? current.at;
      const position = input.position ?? current.position;
      const threadId = input.threadId !== undefined ? input.threadId : current.threadId;
      const prUrl = input.prUrl !== undefined ? input.prUrl : current.prUrl;
      const prTitle = input.prTitle !== undefined ? input.prTitle : current.prTitle;
      const prNumber = input.prNumber !== undefined ? input.prNumber : current.prNumber;
      const projectId = input.projectId !== undefined ? input.projectId : current.projectId;
      const modelSelection =
        input.modelSelection !== undefined ? input.modelSelection : current.modelSelection;
      const projectRouteProvenance =
        input.projectRouteProvenance !== undefined
          ? input.projectRouteProvenance
          : current.projectRouteProvenance;
      const modelRouteReason =
        input.modelRouteReason !== undefined ? input.modelRouteReason : current.modelRouteReason;
      const modelRouteProvenance =
        input.modelRouteProvenance !== undefined
          ? input.modelRouteProvenance
          : current.modelRouteProvenance;
      const modelRouteUsage =
        input.modelRouteUsage !== undefined ? input.modelRouteUsage : current.modelRouteUsage;
      const modelRouteMeta = encodeModelRouteMeta({
        reason: modelRouteReason,
        projectProvenance: projectRouteProvenance,
        provenance: modelRouteProvenance,
        usage: modelRouteUsage,
      });
      const baseBranch = input.baseBranch !== undefined ? input.baseBranch : current.baseBranch;
      const prepStatus = input.prepStatus ?? current.prepStatus;

      // The move gate, on the one path every writer goes through — the store,
      // not the two callers that used to remember to ask.
      //
      // It judges the card as it will be, not as it was: a launch supplies the
      // thread and the column in the same write, and a card that has to already
      // satisfy the gate before the write that satisfies it can never move. Only
      // an actual change of column is a move; `update` merges a column into
      // every partial write.
      //
      // A refusal is not a persistence failure. It rides KanbanPersistenceError
      // because the wire union has no third member yet, and `detail` carries the
      // sentence the caller shows.
      if (input.at !== undefined) {
        const target = normalizeComponentId(input.at);
        if (target !== current.at) {
          const refusal = explainMoveBlock({ ...current, threadId, prUrl, prepStatus }, target);
          if (refusal !== null) {
            return yield* new KanbanPersistenceError({
              operation: "KanbanStore.update:move-refused",
              detail: refusal,
              cause: undefined,
            });
          }
        }
      }

      const columnEnteredAt =
        column === current.at
          ? current.columnEnteredAt
            ? DateTime.formatIso(current.columnEnteredAt)
            : nowIso
          : nowIso;
      const attachments = input.attachments !== undefined ? input.attachments : current.attachments;
      const attachmentsJson = attachments.length > 0 ? encodeAttachmentsJson(attachments) : null;
      const archivedAt =
        input.archived === undefined
          ? current.archivedAt === null
            ? null
            : DateTime.formatIso(current.archivedAt)
          : input.archived
            ? nowIso
            : null;

      yield* sql`
        UPDATE kanban_cards
        SET
          title = ${title},
          body = ${body},
          column_id = ${column},
          position = ${position},
          thread_id = ${threadId},
          pr_url = ${prUrl},
          pr_title = ${prTitle},
          pr_number = ${prNumber},
          project_id = ${projectId},
          model_selection_json = ${modelSelection ? JSON.stringify(modelSelection) : null},
          model_route_reason = ${modelRouteMeta},
          base_branch = ${baseBranch},
          prep_status = ${prepStatus},
          attachments_json = ${attachmentsJson},
          column_entered_at = ${columnEnteredAt},
          archived_at = ${archivedAt},
          updated_at = ${nowIso}
        WHERE id = ${input.id}
      `.pipe(Effect.mapError(persistenceError("KanbanStore.update:write")));

      // Append-only trail for body edits and column moves (never overwrite prior steps).
      if (input.body !== undefined && input.body !== current.body) {
        const historyId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(persistenceError("KanbanStore.update:historyId")),
        );
        yield* sql`
          INSERT INTO kanban_card_history (
            id, card_id, kind, skill_id, input_text, output_text, error_text, model_selection_json, meta_json, created_at
          ) VALUES (
            ${historyId}, ${input.id}, ${"body_edit"}, NULL, ${current.body}, ${body}, NULL, NULL, NULL, ${nowIso}
          )
        `.pipe(Effect.catch(() => Effect.void));
      }
      const moved = input.at !== undefined && column !== current.at;
      if (moved) {
        const historyId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(persistenceError("KanbanStore.update:moveHistoryId")),
        );
        yield* sql`
          INSERT INTO kanban_card_history (
            id, card_id, kind, skill_id, input_text, output_text, error_text, model_selection_json, meta_json, created_at
          ) VALUES (
            ${historyId}, ${input.id}, ${"column_move"}, NULL, NULL, NULL, NULL, NULL,
            ${JSON.stringify({
              fromColumn: current.at,
              toColumn: column,
              ...(input.movedBy === undefined ? {} : { rule: input.movedBy }),
            })}, ${nowIso}
          )
        `.pipe(Effect.catch(() => Effect.void));
      }

      // Archiving clears a card from the board without moving it, so its
      // coding session ends with no `exit` to hang the reap on. That one stays
      // here; leaving a component is a rule now.
      const becameArchived = input.archived === true && current.archivedAt === null;
      if (becameArchived && current.threadId) {
        const reaper = yield* Effect.serviceOption(WorktreeReaper.WorktreeReaper);
        if (Option.isSome(reaper)) {
          yield* reaper.value
            .reapThreadWorktree(current.threadId as ThreadId)
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }

      // The moments, on the write that causes them. `left` runs against the
      // component the card is leaving and `entered` against the one it lands
      // on, so an exit rule still sees the card where its rules apply.
      if (moved) {
        const cardId = input.id as string;
        yield* fireMoment((moments) => moments.left({ cardId, from: current.at, to: column }));
        yield* fireMoment((moments) => moments.entered({ cardId, at: column, from: current.at }));
      }

      return yield* getById(input.id, "KanbanStore.update:read");
    });

  const remove: KanbanStore["Service"]["remove"] = (input) =>
    // History rows are intentionally left in place so prompt→skill trails survive delete.
    Effect.gen(function* () {
      const rows = yield* sql`
        DELETE FROM kanban_cards WHERE id = ${input.id}
        RETURNING id AS "id", thread_id AS "threadId"
      `.pipe(Effect.mapError(persistenceError("KanbanStore.remove")));

      // A card deleted while it still owns a thread takes the last reference
      // to that workspace with it — reap now or it leaks until a sweep.
      const threadId = rows[0]?.["threadId"];
      if (typeof threadId === "string" && threadId.length > 0) {
        const reaper = yield* Effect.serviceOption(WorktreeReaper.WorktreeReaper);
        if (Option.isSome(reaper)) {
          yield* reaper.value
            .reapThreadWorktree(threadId as ThreadId)
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }

      return { id: input.id, deleted: rows.length > 0 };
    });

  const listHistoryRows = SqlSchema.findAll({
    Request: KanbanCardId,
    Result: HistoryRawRow,
    execute: (cardId) => sql`
      SELECT
        id AS "id",
        card_id AS "cardId",
        kind AS "kind",
        skill_id AS "skillId",
        input_text AS "inputText",
        output_text AS "outputText",
        error_text AS "errorText",
        model_selection_json AS "modelSelectionJson",
        meta_json AS "metaJson",
        created_at AS "createdAt"
      FROM kanban_card_history
      WHERE card_id = ${cardId}
      ORDER BY created_at ASC, id ASC
    `,
  });

  const listHistory: KanbanStore["Service"]["listHistory"] = (input) =>
    listHistoryRows(input.cardId).pipe(
      Effect.mapError(persistenceError("KanbanStore.listHistory")),
      Effect.map((rows) => ({
        entries: rows.map((row) => toHistoryEntry(row)),
      })),
    );

  const appendHistory: KanbanStore["Service"]["appendHistory"] = (input) =>
    Effect.gen(function* () {
      if (input.entries.length === 0) {
        return { cardId: input.cardId, appended: 0 };
      }
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      let appended = 0;
      for (const entry of input.entries) {
        const historyId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(persistenceError("KanbanStore.appendHistory:id")),
        );
        yield* insertHistoryRow(sql, {
          id: historyId,
          cardId: input.cardId,
          entry,
          createdAt: nowIso,
        }).pipe(Effect.mapError(persistenceError("KanbanStore.appendHistory:insert")));
        appended += 1;
      }
      return { cardId: input.cardId, appended };
    });

  return {
    list,
    create,
    update,
    remove,
    listHistory,
    appendHistory,
    listPrChecks,
    savePrChecks,
  } satisfies KanbanStore["Service"];
});

function insertHistoryRow(
  sql: SqlClient.SqlClient,
  input: {
    id: string;
    cardId: string;
    entry: KanbanAppendCardHistoryEntryInput;
    createdAt: string;
  },
) {
  const modelSelectionJson = input.entry.modelSelection
    ? JSON.stringify(input.entry.modelSelection)
    : null;
  const metaJson = input.entry.meta ? JSON.stringify(input.entry.meta) : null;
  return sql`
    INSERT INTO kanban_card_history (
      id, card_id, kind, skill_id, input_text, output_text, error_text, model_selection_json, meta_json, created_at
    ) VALUES (
      ${input.id},
      ${input.cardId},
      ${input.entry.kind},
      ${input.entry.skillId ?? null},
      ${input.entry.inputText ?? null},
      ${input.entry.outputText ?? null},
      ${input.entry.errorText ?? null},
      ${modelSelectionJson},
      ${metaJson},
      ${input.createdAt}
    )
  `;
}

export const layer = Layer.effect(KanbanStore, make);
