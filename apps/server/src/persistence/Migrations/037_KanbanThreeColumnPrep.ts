import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Collapse to Prompts → Active → PR, and add prep_status for skill-prep
 * readiness (untouched / processing / ready).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE kanban_cards
    ADD COLUMN prep_status TEXT NOT NULL DEFAULT 'untouched'
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE kanban_cards
    SET column_id = 'prompts'
    WHERE column_id IN ('research', 'validate', 'improve')
  `;

  yield* sql`
    UPDATE kanban_cards
    SET column_id = 'pr'
    WHERE column_id = 'main'
  `;

  // Cards that already had a thread were "active work" — park them in active.
  yield* sql`
    UPDATE kanban_cards
    SET column_id = 'active',
        prep_status = 'ready'
    WHERE thread_id IS NOT NULL
      AND column_id = 'prompts'
  `;
});
