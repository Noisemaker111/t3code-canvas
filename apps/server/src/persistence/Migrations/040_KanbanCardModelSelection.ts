import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist the provider instance/model selected when a prompt card is created. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN model_selection_json TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
