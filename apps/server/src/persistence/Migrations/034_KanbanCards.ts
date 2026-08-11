import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Kanban board persistence.
 *
 * Cards flow through the pipeline columns (prompts → research → validate →
 * improve → pr → main). They are stored server-side so the board syncs across
 * every device the user connects from.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL,
      position REAL NOT NULL,
      thread_id TEXT,
      pr_url TEXT,
      model_selection_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_position
    ON kanban_cards(column_id, position)
  `;
});
