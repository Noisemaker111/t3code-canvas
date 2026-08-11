/**
 * Maintenance — the only path that deletes accumulated history.
 *
 * Five independent targets, each surveyed before it is purged and each purged
 * only by an explicit request naming the exact item count it was shown. Nothing
 * here is scheduled, swept, or called from startup: the sole callers are the
 * `/api/maintenance` routes, which a human drives from Settings → Maintenance.
 *
 * `canvas` additionally demands a typed phrase. The owner's standing rule is
 * that the canvas is never wiped as a side effect of anything, so it cannot be
 * reached by a stray POST that happens to carry the right count.
 *
 * @module maintenance/Maintenance
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { frictionLogPath, purgeFrictionLog } from "../friction/frictionStore.ts";
import { healthIncidentLogPath, purgeHealthIncidents } from "../health/incidentLog.ts";
import { hermesTickLogPath, purgeHermesTickLog } from "../kanban/hermes/tickLogStore.ts";
import { hermesUsageLogPaths, purgeHermesUsageLog } from "../kanban/hermes/usageLogStore.ts";
import { fileBytes } from "./fileBytes.ts";

export const MAINTENANCE_TARGET_IDS = [
  "friction",
  "archived",
  "hermes-logs",
  "health",
  "canvas",
] as const;

export type MaintenanceTargetId = (typeof MAINTENANCE_TARGET_IDS)[number];

/** The phrase a target demands be typed back, or `null` for count-only targets. */
export const MAINTENANCE_PHRASES: Readonly<Record<MaintenanceTargetId, string | null>> = {
  friction: null,
  archived: null,
  "hermes-logs": null,
  health: null,
  canvas: "wipe canvas",
};

export interface MaintenanceLine {
  readonly label: string;
  readonly count: number;
}

export interface MaintenanceSurvey {
  readonly target: MaintenanceTargetId;
  readonly title: string;
  /** What this deletes, in the words the confirmation dialog repeats back. */
  readonly summary: string;
  /** The headline number. A purge request must echo this exact value. */
  readonly items: number;
  readonly bytes: number;
  readonly lines: ReadonlyArray<MaintenanceLine>;
  readonly requiresPhrase: string | null;
}

export interface MaintenancePurgeResult extends MaintenanceSurvey {
  readonly purgedAt: string;
}

export function isMaintenanceTargetId(value: unknown): value is MaintenanceTargetId {
  return (
    typeof value === "string" && (MAINTENANCE_TARGET_IDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The gate every purge passes through, split out from the route so the rules are
 * testable without a server: a known target, the count the caller was actually
 * shown, and the typed phrase where one is demanded.
 */
export type MaintenanceGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string };

export function checkPurgeConfirmation(input: {
  readonly target: MaintenanceTargetId;
  readonly confirmItems: unknown;
  readonly confirmPhrase: unknown;
  readonly survey: MaintenanceSurvey;
}): MaintenanceGate {
  const phrase = MAINTENANCE_PHRASES[input.target];
  if (phrase !== null) {
    const typed = typeof input.confirmPhrase === "string" ? input.confirmPhrase.trim() : "";
    if (typed.toLowerCase() !== phrase) {
      return {
        ok: false,
        status: 400,
        error: `Type "${phrase}" to confirm. This is the only thing that wipes the canvas, and it is never done for you.`,
      };
    }
  }
  if (typeof input.confirmItems !== "number" || !Number.isFinite(input.confirmItems)) {
    return {
      ok: false,
      status: 400,
      error: "confirmItems must be the item count you were shown.",
    };
  }
  if (input.confirmItems !== input.survey.items) {
    return {
      ok: false,
      status: 409,
      error: `This changed while you were looking at it: you confirmed ${input.confirmItems} item(s), there are now ${input.survey.items}. Re-read it and confirm again.`,
    };
  }
  if (input.survey.items === 0) {
    return { ok: false, status: 409, error: "Nothing to delete." };
  }
  return { ok: true };
}

const ARCHIVED_THREADS = `SELECT thread_id FROM projection_threads WHERE archived_at IS NOT NULL OR deleted_at IS NOT NULL`;
const ARCHIVED_CARDS = `SELECT id FROM kanban_cards WHERE archived_at IS NOT NULL`;

function firstNumber(rows: ReadonlyArray<unknown>, key: string): number {
  const row = rows[0];
  if (row === undefined || row === null || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const count = (sql: SqlClient.SqlClient, from: string) =>
  sql`SELECT COUNT(*) AS n FROM ${sql.unsafe(from)}`.pipe(
    Effect.map((rows) => firstNumber(rows, "n")),
    Effect.orElseSucceed(() => 0),
  );

const bytesOf = (sql: SqlClient.SqlClient, expression: string, from: string) =>
  sql`SELECT COALESCE(SUM(${sql.unsafe(expression)}), 0) AS n FROM ${sql.unsafe(from)}`.pipe(
    Effect.map((rows) => firstNumber(rows, "n")),
    Effect.orElseSucceed(() => 0),
  );

const scopedToArchivedThreads = (table: string) =>
  `${table} WHERE thread_id IN (${ARCHIVED_THREADS})`;

const surveyFriction = Effect.sync((): MaintenanceSurvey => {
  const path = frictionLogPath();
  const entries = purgeFrictionLog({ dryRun: true });
  return {
    target: "friction",
    title: "Friction log",
    summary: "Every papercut entry — agent reports, detector hits, Hermes board failures.",
    items: entries,
    bytes: path === null ? 0 : fileBytes(path),
    lines: [{ label: "papercut entries", count: entries }],
    requiresPhrase: null,
  };
});

const surveyHermesLogs = Effect.sync((): MaintenanceSurvey => {
  const ticks = purgeHermesTickLog({ dryRun: true });
  const usage = purgeHermesUsageLog({ dryRun: true });
  const tickPath = hermesTickLogPath();
  const bytes =
    (tickPath === null ? 0 : fileBytes(tickPath)) +
    hermesUsageLogPaths().reduce((total, path) => total + fileBytes(path), 0);
  return {
    target: "hermes-logs",
    title: "Hermes tick and usage logs",
    summary: "Past tick transcripts and the per-tick spend rows. Hermes itself keeps running.",
    items: ticks + usage,
    bytes,
    lines: [
      { label: "tick transcripts (ticks.jsonl)", count: ticks },
      { label: "usage rows (usage.jsonl)", count: usage },
    ],
    requiresPhrase: null,
  };
});

const surveyHealth = Effect.sync((): MaintenanceSurvey => {
  const path = healthIncidentLogPath();
  const entries = purgeHealthIncidents({ dryRun: true });
  return {
    target: "health",
    title: "Health incident log",
    summary: "Every recorded degradation and failed health check. Live checks keep running.",
    items: entries,
    bytes: path === null ? 0 : fileBytes(path),
    lines: [{ label: "incident entries", count: entries }],
    requiresPhrase: null,
  };
});

const surveyArchived = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* count(
    sql,
    `projection_threads WHERE archived_at IS NOT NULL OR deleted_at IS NOT NULL`,
  );
  const cards = yield* count(sql, `kanban_cards WHERE archived_at IS NOT NULL`);
  const messages = yield* count(sql, scopedToArchivedThreads("projection_thread_messages"));
  const activities = yield* count(sql, scopedToArchivedThreads("projection_thread_activities"));
  const turns = yield* count(sql, scopedToArchivedThreads("projection_turns"));
  const events = yield* count(sql, `orchestration_events WHERE stream_id IN (${ARCHIVED_THREADS})`);
  const messageBytes = yield* bytesOf(
    sql,
    "LENGTH(text)",
    scopedToArchivedThreads("projection_thread_messages"),
  );
  const activityBytes = yield* bytesOf(
    sql,
    "LENGTH(payload_json)",
    scopedToArchivedThreads("projection_thread_activities"),
  );
  const eventBytes = yield* bytesOf(
    sql,
    "LENGTH(payload_json) + LENGTH(metadata_json)",
    `orchestration_events WHERE stream_id IN (${ARCHIVED_THREADS})`,
  );
  const diffBytes = yield* bytesOf(
    sql,
    "LENGTH(diff)",
    scopedToArchivedThreads("checkpoint_diff_blobs"),
  );
  return {
    target: "archived",
    title: "Archived history",
    summary:
      "Threads already archived or deleted, archived cards, and every transcript, activity, turn and event belonging to them. Live threads and live cards are not touched.",
    items: threads + cards,
    bytes: messageBytes + activityBytes + eventBytes + diffBytes,
    lines: [
      { label: "archived / deleted threads", count: threads },
      { label: "archived cards", count: cards },
      { label: "thread messages", count: messages },
      { label: "thread activities", count: activities },
      { label: "turns", count: turns },
      { label: "orchestration events", count: events },
    ],
    requiresPhrase: null,
  } satisfies MaintenanceSurvey;
});

const surveyCanvas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const documents = yield* count(sql, "canvas_documents");
  const injections = yield* count(sql, "canvas_injections");
  const messages = yield* count(sql, "canvas_messages");
  const snapshotBytes = yield* bytesOf(sql, "LENGTH(snapshot_json)", "canvas_documents");
  return {
    target: "canvas",
    title: "Canvas drawing",
    summary:
      "The whole tldraw document, every queued drawing, and every message addressed to the canvas. Nothing else in T3 wipes this, and nothing else ever will.",
    items: documents + injections + messages,
    bytes: snapshotBytes,
    lines: [
      { label: "canvas documents", count: documents },
      { label: "queued injections", count: injections },
      { label: "canvas messages", count: messages },
    ],
    requiresPhrase: MAINTENANCE_PHRASES.canvas,
  } satisfies MaintenanceSurvey;
});

export const surveyMaintenanceTarget = (
  target: MaintenanceTargetId,
): Effect.Effect<MaintenanceSurvey, never, SqlClient.SqlClient> => {
  switch (target) {
    case "friction":
      return surveyFriction;
    case "hermes-logs":
      return surveyHermesLogs;
    case "health":
      return surveyHealth;
    case "archived":
      return surveyArchived;
    case "canvas":
      return surveyCanvas;
  }
};

export const surveyMaintenance = Effect.forEach(MAINTENANCE_TARGET_IDS, surveyMaintenanceTarget);

const purgeArchived = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "projection_thread_messages",
    "projection_thread_activities",
    "projection_thread_sessions",
    "projection_thread_proposed_plans",
    "projection_turns",
    "projection_pending_approvals",
    "checkpoint_diff_blobs",
  ]) {
    yield* sql`DELETE FROM ${sql.unsafe(table)} WHERE thread_id IN (${sql.unsafe(ARCHIVED_THREADS)})`;
  }
  yield* sql`DELETE FROM orchestration_events WHERE stream_id IN (${sql.unsafe(ARCHIVED_THREADS)})`;
  yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_id IN (${sql.unsafe(ARCHIVED_THREADS)})`;
  yield* sql`DELETE FROM kanban_card_history WHERE card_id IN (${sql.unsafe(ARCHIVED_CARDS)})`;
  yield* sql`DELETE FROM kanban_cards WHERE archived_at IS NOT NULL`;
  yield* sql`DELETE FROM projection_threads WHERE archived_at IS NOT NULL OR deleted_at IS NOT NULL`;
});

const purgeCanvas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM canvas_messages`;
  yield* sql`DELETE FROM canvas_injections`;
  yield* sql`DELETE FROM canvas_documents`;
});

/**
 * Delete one target and report exactly what went. The survey is taken first and
 * returned as the receipt, so the number the caller confirmed is the number the
 * caller is told was removed.
 */
export const purgeMaintenanceTarget = (
  target: MaintenanceTargetId,
): Effect.Effect<MaintenancePurgeResult, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const survey = yield* surveyMaintenanceTarget(target);
    switch (target) {
      case "friction":
        purgeFrictionLog();
        break;
      case "hermes-logs":
        purgeHermesTickLog();
        purgeHermesUsageLog();
        break;
      case "health":
        purgeHealthIncidents();
        break;
      case "archived":
        yield* purgeArchived.pipe(Effect.orElseSucceed(() => undefined));
        break;
      case "canvas":
        yield* purgeCanvas.pipe(Effect.orElseSucceed(() => undefined));
        break;
    }
    return { ...survey, purgedAt: DateTime.formatIso(yield* DateTime.now) };
  });
