import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Last known forge CI verdict per card, tied to the PR URL it describes. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_pr_checks (
      card_id TEXT PRIMARY KEY NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      pr_url TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    )
  `;
});
