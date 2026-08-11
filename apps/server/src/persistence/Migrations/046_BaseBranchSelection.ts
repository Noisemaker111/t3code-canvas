import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Where new work is cut from: per card, defaulting to the project's own branch. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN base_branch TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_base_branch TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
