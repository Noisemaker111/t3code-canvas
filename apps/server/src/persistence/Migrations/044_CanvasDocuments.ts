import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The board canvas: one opaque tldraw snapshot per document, plus the queue of
 * Hermes-authored drawings waiting for a browser to materialize them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS canvas_documents (
      doc_id TEXT PRIMARY KEY NOT NULL,
      snapshot_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS canvas_injections (
      id TEXT PRIMARY KEY NOT NULL,
      doc_id TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_canvas_injections_pending
    ON canvas_injections(doc_id, applied_at, created_at)
  `;
});
