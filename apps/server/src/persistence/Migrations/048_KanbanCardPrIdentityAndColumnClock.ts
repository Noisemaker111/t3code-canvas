import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** PR identity on the card face, and the clock that says how long it has sat here. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN pr_title TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN pr_number INTEGER
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN column_entered_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  // Existing cards have no move record, so the last write is the closest thing
  // to when they arrived; without it every card would read "just now" forever.
  yield* sql`
    UPDATE kanban_cards
    SET column_entered_at = COALESCE(updated_at, created_at)
    WHERE column_entered_at IS NULL
  `.pipe(Effect.catch(() => Effect.void));
});
