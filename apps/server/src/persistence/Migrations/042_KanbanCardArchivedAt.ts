import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Archive a kanban card off the board without deleting it. Cards with
 * `archived_at` set are excluded from the default list, so neither the board
 * nor a Hermes tick sees them; the Archive settings page restores them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN archived_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_archived_at
    ON kanban_cards(archived_at)
  `.pipe(Effect.catch(() => Effect.void));
});
