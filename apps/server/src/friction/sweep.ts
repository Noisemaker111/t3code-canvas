/**
 * The periodic pass that turns projected failures into papercuts.
 *
 * Reads the activity rows written since the last sweep, runs the pure detector
 * over them, and records what crossed the bar. Bounded by the watermark, so the
 * cost is proportional to what happened, not to the size of the projection.
 *
 * @module friction/sweep
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  detectFriction,
  detectWorkarounds,
  readSweepWatermark,
  writeSweepWatermark,
  type FrictionActivityRow,
} from "./detector.ts";
import { recordFriction } from "./frictionStore.ts";

/** First sweep after a restart looks back this far rather than at everything. */
const COLD_START_LOOKBACK_MS = 6 * 60 * 60 * 1000;

const ROW_LIMIT = 2000;

export const runFrictionSweep = Effect.fn("friction.sweep")(function* (
  options: {
    readonly nowIso?: string;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = options.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  const nowMs = Date.parse(nowIso);
  const since = readSweepWatermark() ?? new Date(nowMs - COLD_START_LOOKBACK_MS).toISOString();

  // `tool.updated` carries the harness's own `status: "failed"` and the command
  // that produced it, which is the only exact failure signal in the projection —
  // `tool.completed` has to be pattern-matched for words like "error". Reading
  // both is what lets a single failure count.
  const rows = yield* sql`
    SELECT
      thread_id AS "threadId",
      kind AS "kind",
      tone AS "tone",
      summary AS "summary",
      json_extract(payload_json, '$.detail') AS "detail",
      json_extract(payload_json, '$.message') AS "message",
      json_extract(payload_json, '$.status') AS "status",
      json_extract(payload_json, '$.itemType') AS "itemType",
      COALESCE(
        json_extract(payload_json, '$.data.input.command'),
        json_extract(payload_json, '$.data.command')
      ) AS "command",
      created_at AS "createdAt"
    FROM projection_thread_activities
    WHERE created_at > ${since}
      AND (
        tone = 'error'
        OR kind = 'tool.completed'
        OR (kind = 'tool.updated' AND json_extract(payload_json, '$.status') = 'failed')
      )
    ORDER BY created_at ASC
    LIMIT ${ROW_LIMIT}
  `;

  if (rows.length === 0) {
    writeSweepWatermark(nowIso);
    return 0;
  }

  const activities: ReadonlyArray<FrictionActivityRow> = rows.map((row) => ({
    threadId: String(row["threadId"] ?? ""),
    kind: String(row["kind"] ?? ""),
    tone: row["tone"] === null || row["tone"] === undefined ? null : String(row["tone"]),
    summary:
      row["summary"] === null || row["summary"] === undefined ? null : String(row["summary"]),
    // `runtime.error` carries its text as `message`; tool activities use `detail`.
    detail:
      row["detail"] !== null && row["detail"] !== undefined
        ? String(row["detail"])
        : row["message"] !== null && row["message"] !== undefined
          ? String(row["message"])
          : null,
    createdAt: String(row["createdAt"] ?? nowIso),
    status: row["status"] === null || row["status"] === undefined ? null : String(row["status"]),
    itemType:
      row["itemType"] === null || row["itemType"] === undefined ? null : String(row["itemType"]),
    command:
      row["command"] === null || row["command"] === undefined ? null : String(row["command"]),
  }));

  const found = [...detectFriction(activities), ...detectWorkarounds(activities)];
  for (const papercut of found) recordFriction(papercut);

  const lastAt = activities[activities.length - 1]?.createdAt ?? nowIso;
  // Advance to the last row read, not to `now`: rows written mid-sweep must be
  // picked up next time rather than skipped.
  writeSweepWatermark(rows.length >= ROW_LIMIT ? lastAt : nowIso);
  return found.length;
});
