import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Collapse retired intermediate stages into Research before the stricter
 * four-column board contract is served to clients. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE kanban_cards
    SET column_id = 'research'
    WHERE column_id IN ('validate', 'improve')
  `;
});
