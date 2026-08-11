import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_CleanupStalePendingTurns", (it) => {
  it.effect("removes only pending starts with a durable terminal signal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'pending-archived', 'project-1', 'Archived',
          '{"instanceId":"codex","model":"gpt-5"}', 'approval-required', 'default',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:11:00.000Z',
          '2026-08-01T00:11:00.000Z', 0, 0, 0
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES
          ('pending-failed', NULL, 'message-failed', NULL, 'pending',
            '2026-08-01T00:10:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]'),
          ('pending-terminal', NULL, 'message-terminal', NULL, 'pending',
            '2026-08-01T00:10:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]'),
          ('pending-archived', NULL, 'message-archived', NULL, 'pending',
            '2026-08-01T00:10:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]'),
          ('pending-starting', NULL, 'message-starting', NULL, 'pending',
            '2026-08-01T00:10:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]'),
          ('pending-old-ready', NULL, 'message-old-ready', NULL, 'pending',
            '2026-08-01T00:10:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]')
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-start-failed', 'pending-failed', NULL, 'error',
          'provider.turn.start.failed', 'Provider turn start failed', '{}', NULL,
          '2026-08-01T00:11:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES
          ('pending-terminal', 'ready', 'codex', 'approval-required', NULL, 'failed',
            '2026-08-01T00:11:00.000Z'),
          ('pending-starting', 'starting', 'codex', 'approval-required', NULL, NULL,
            '2026-08-01T00:11:00.000Z'),
          ('pending-old-ready', 'ready', 'codex', 'approval-required', NULL, NULL,
            '2026-08-01T00:09:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE turn_id IS NULL AND state = 'pending'
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "pending-old-ready" },
        { threadId: "pending-starting" },
      ]);
    }),
  );
});
