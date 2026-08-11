/**
 * Migration 033 - conversation_log view.
 *
 * A read-only, flattened view over the message/activity/turn projections so the
 * full conversation record — every prompt, response, and tool call, with the
 * time it took and the tokens it used — is queryable with a single plain SQL
 * `SELECT * FROM conversation_log`. Nothing writes to it; it derives entirely
 * from existing projection tables, so it adds no write path and cannot fall out
 * of sync.
 *
 * Columns: created_at, updated_at, project_id, thread_id, turn_id, entry_type
 * ('prompt' | 'response' | 'tool_call' | 'system'), role, tool_kind, text,
 * tokens, duration_ms.
 *
 * - Assistant `tokens` come from the turn's latest context-window snapshot
 *   (per-turn output tokens the harness reported); `duration_ms` is the turn's
 *   started_at -> completed_at span.
 * - Tool-call `tokens` come from the count computed at ingestion (see
 *   ProviderRuntimeIngestion) and stored on the activity payload.
 * - User prompts carry no token/time columns (there is nothing to attribute).
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP VIEW IF EXISTS conversation_log`.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    CREATE VIEW conversation_log AS
    SELECT
      m.created_at AS created_at,
      m.updated_at AS updated_at,
      t.project_id AS project_id,
      m.thread_id AS thread_id,
      m.turn_id AS turn_id,
      CASE
        WHEN m.role = 'assistant' THEN 'response'
        WHEN m.role = 'user' THEN 'prompt'
        ELSE m.role
      END AS entry_type,
      m.role AS role,
      NULL AS tool_kind,
      m.text AS text,
      CASE WHEN m.role = 'assistant' THEN (
        SELECT COALESCE(
          json_extract(cw.payload_json, '$.lastOutputTokens'),
          json_extract(cw.payload_json, '$.outputTokens'),
          json_extract(cw.payload_json, '$.usedTokens')
        )
        FROM projection_thread_activities cw
        WHERE cw.turn_id = m.turn_id AND cw.kind = 'context-window.updated'
        ORDER BY cw.created_at DESC
        LIMIT 1
      ) ELSE NULL END AS tokens,
      CASE WHEN m.role = 'assistant' THEN (
        SELECT CAST((julianday(tr.completed_at) - julianday(tr.started_at)) * 86400000 AS INTEGER)
        FROM projection_turns tr
        WHERE tr.thread_id = m.thread_id AND tr.turn_id = m.turn_id
          AND tr.started_at IS NOT NULL AND tr.completed_at IS NOT NULL
        LIMIT 1
      ) ELSE NULL END AS duration_ms
    FROM projection_thread_messages m
    JOIN projection_threads t ON t.thread_id = m.thread_id

    UNION ALL

    SELECT
      a.created_at AS created_at,
      a.created_at AS updated_at,
      t.project_id AS project_id,
      a.thread_id AS thread_id,
      a.turn_id AS turn_id,
      'tool_call' AS entry_type,
      'tool' AS role,
      a.kind AS tool_kind,
      CASE
        WHEN json_extract(a.payload_json, '$.detail') IS NOT NULL
          THEN a.summary || ' — ' || json_extract(a.payload_json, '$.detail')
        ELSE a.summary
      END AS text,
      json_extract(a.payload_json, '$.tokens') AS tokens,
      NULL AS duration_ms
    FROM projection_thread_activities a
    JOIN projection_threads t ON t.thread_id = a.thread_id
    WHERE a.kind = 'tool.completed'
  `.pipe(Effect.catch(() => Effect.void));
});
