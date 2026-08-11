import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Append-only audit trail for kanban cards: original prompt, each skill
 * input/output, edits, moves. Survives card delete (no FK cascade).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_history (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      skill_id TEXT,
      input_text TEXT,
      output_text TEXT,
      error_text TEXT,
      model_selection_json TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_card_history_card_created
    ON kanban_card_history(card_id, created_at)
  `;
});
