import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Composer image/video metadata on cards (bytes live under attachmentsDir). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN attachments_json TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
