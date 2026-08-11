import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Sanctioned areas of the board canvas, and the messages addressed to them.
 *
 * Areas are rows rather than records inside the opaque tldraw snapshot because
 * the whole point is that a reader who is not a browser — Hermes, a coding
 * agent — can ask "where is my area" without parsing tldraw.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS canvas_areas (
      area_id TEXT PRIMARY KEY NOT NULL,
      doc_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL,
      y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      owner_kind TEXT NOT NULL DEFAULT 'human',
      owner_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_canvas_areas_doc ON canvas_areas(doc_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_canvas_areas_owner ON canvas_areas(doc_id, owner_kind, owner_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS canvas_messages (
      id TEXT PRIMARY KEY NOT NULL,
      doc_id TEXT NOT NULL,
      area_id TEXT,
      author_kind TEXT NOT NULL,
      author_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      image_media_type TEXT,
      image_data TEXT,
      image_width INTEGER,
      image_height INTEGER,
      target TEXT NOT NULL,
      target_id TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_canvas_messages_inbox
    ON canvas_messages(doc_id, target, delivered_at, created_at)
  `;
});
