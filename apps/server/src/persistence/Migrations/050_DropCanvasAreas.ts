import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drop canvas areas. The canvas keeps its document and its messages; what goes
 * is the address space — nobody drew into a sanctioned region on purpose, and
 * the blank frames it mirrored onto the board were noise.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_canvas_areas_doc`;
  yield* sql`DROP INDEX IF EXISTS idx_canvas_areas_owner`;
  yield* sql`DROP TABLE IF EXISTS canvas_areas`;

  // SQLite older than 3.35 has no DROP COLUMN; the column is nullable and no
  // longer written, so an old engine keeping it costs nothing.
  yield* sql`
    ALTER TABLE canvas_messages
    DROP COLUMN area_id
  `.pipe(Effect.catch(() => Effect.void));
});
