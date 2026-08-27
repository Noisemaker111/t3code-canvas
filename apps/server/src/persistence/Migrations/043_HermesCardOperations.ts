import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS hermes_card_operations (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      card_id TEXT,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      detail TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT,
      error_text TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_hermes_card_operations_card_updated
    ON hermes_card_operations(card_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_hermes_card_operations_lease
    ON hermes_card_operations(status, lease_expires_at)
  `;
});
