import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Freeze the last received text once another projection proves streaming ended. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_messages
    SET is_streaming = 0
    WHERE is_streaming = 1
      AND (
        EXISTS (
          SELECT 1
          FROM projection_threads AS thread
          WHERE thread.thread_id = projection_thread_messages.thread_id
            AND (thread.archived_at IS NOT NULL OR thread.deleted_at IS NOT NULL)
        )
        OR EXISTS (
          SELECT 1
          FROM projection_thread_sessions AS session
          WHERE session.thread_id = projection_thread_messages.thread_id
            AND session.active_turn_id IS NULL
            AND session.status IN ('idle', 'ready', 'interrupted', 'stopped', 'error')
            AND session.updated_at >= projection_thread_messages.updated_at
        )
      )
  `;
});
