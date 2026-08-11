import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Pending rows have no provider turn id yet. Keep them while a session is
 * starting, but remove them once another durable projection proves the start
 * cannot still complete.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND (
        EXISTS (
          SELECT 1
          FROM projection_threads AS thread
          WHERE thread.thread_id = projection_turns.thread_id
            AND (thread.archived_at IS NOT NULL OR thread.deleted_at IS NOT NULL)
        )
        OR EXISTS (
          SELECT 1
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_turns.thread_id
            AND activity.kind = 'provider.turn.start.failed'
            AND activity.created_at >= projection_turns.requested_at
        )
        OR EXISTS (
          SELECT 1
          FROM projection_thread_sessions AS session
          WHERE session.thread_id = projection_turns.thread_id
            AND session.active_turn_id IS NULL
            AND session.status IN ('idle', 'ready', 'interrupted', 'stopped', 'error')
            AND session.updated_at >= projection_turns.requested_at
        )
      )
  `;
});
