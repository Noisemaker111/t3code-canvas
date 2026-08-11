import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_SettleStaleStreamingMessages", (it) => {
  it.effect("settles only messages with a durable terminal signal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'message-archived-thread', 'project-1', 'Archived',
          '{"instanceId":"codex","model":"gpt-5"}', 'approval-required', 'default',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:11:00.000Z',
          '2026-08-01T00:11:00.000Z', 0, 0, 0
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('message-archived', 'message-archived-thread', NULL, 'assistant', 'partial', 1,
            '2026-08-01T00:10:00.000Z', '2026-08-01T00:10:00.000Z'),
          ('message-terminal', 'message-terminal-thread', NULL, 'assistant', 'partial', 1,
            '2026-08-01T00:10:00.000Z', '2026-08-01T00:10:00.000Z'),
          ('message-starting', 'message-starting-thread', NULL, 'assistant', 'partial', 1,
            '2026-08-01T00:10:00.000Z', '2026-08-01T00:10:00.000Z'),
          ('message-old-ready', 'message-old-ready-thread', NULL, 'assistant', 'partial', 1,
            '2026-08-01T00:10:00.000Z', '2026-08-01T00:10:00.000Z')
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES
          ('message-terminal-thread', 'ready', 'codex', 'approval-required', NULL, NULL,
            '2026-08-01T00:11:00.000Z'),
          ('message-starting-thread', 'starting', 'codex', 'approval-required', NULL, NULL,
            '2026-08-01T00:11:00.000Z'),
          ('message-old-ready-thread', 'ready', 'codex', 'approval-required', NULL, NULL,
            '2026-08-01T00:09:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{ readonly messageId: string; readonly isStreaming: number }>`
        SELECT message_id AS "messageId", is_streaming AS "isStreaming"
        FROM projection_thread_messages
        ORDER BY message_id
      `;
      assert.deepStrictEqual(rows, [
        { messageId: "message-archived", isStreaming: 0 },
        { messageId: "message-old-ready", isStreaming: 1 },
        { messageId: "message-starting", isStreaming: 1 },
        { messageId: "message-terminal", isStreaming: 0 },
      ]);
    }),
  );
});
