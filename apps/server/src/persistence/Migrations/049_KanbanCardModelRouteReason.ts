import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Why a card holds the model it holds: null = a human's pick, text = routed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN model_route_reason TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
