import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Split draft vs prompts:
 * - draft = raw / skill-in-progress (was prompts + untouched/processing)
 * - prompts = ready queue (was prompts + ready)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Untouched/processing cards that lived in prompts become draft.
  yield* sql`
    UPDATE kanban_cards
    SET column_id = 'draft'
    WHERE column_id = 'prompts'
      AND COALESCE(prep_status, 'untouched') IN ('untouched', 'processing')
  `;

  // Anything still in prompts is ready work.
  yield* sql`
    UPDATE kanban_cards
    SET prep_status = 'ready'
    WHERE column_id = 'prompts'
  `;

  // Draft rows keep/default untouched (or processing if already set).
  yield* sql`
    UPDATE kanban_cards
    SET prep_status = COALESCE(prep_status, 'untouched')
    WHERE column_id = 'draft'
  `;

  // Active/PR already past the queue — mark ready for consistency.
  yield* sql`
    UPDATE kanban_cards
    SET prep_status = 'ready'
    WHERE column_id IN ('active', 'pr')
  `;
});
