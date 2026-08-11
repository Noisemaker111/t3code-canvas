import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Optional project assignment on kanban cards.
 * Hermes chooses which project a prompt belongs to and only launches
 * cards that already have project_id set.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN project_id TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
