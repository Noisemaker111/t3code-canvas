/**
 * 035 BtwMessages
 *
 * Persistence for the btw side-chat. Each thread has a single btw session
 * (`btw_session_id`) whose messages are stored here, entirely separate from the
 * coding transcript. Clearing a session deletes its rows for the thread.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS btw_messages (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      btw_session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_btw_messages_thread_created
    ON btw_messages(thread_id, created_at, row_id)
  `;
});
