/**
 * The `enter` and `exit` moments, on the write that causes them.
 *
 * The tick owned every rule until now, which meant the invariant — if it runs,
 * it is in the list — was true of a heartbeat and false of a drag. Dropping a
 * card launched a thread from the browser's own copy of the arrival logic, and
 * leaving Active reaped a worktree from a line buried in `KanbanStore.update`.
 * Neither was a rule and neither was in any list.
 *
 * A move happens in the store, and the store cannot build a card handle: the
 * verbs live behind `BoardApi`, which is assembled far above it. So the store
 * calls through here and whoever has a `BoardApi` binds the other end, the same
 * way the tick log and the Hermes chat are bound. A boot that binds nothing —
 * tests, the CLI — keeps working, with moves that write and run no rules,
 * exactly as they did.
 *
 * @module kanban/components/moments
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A rule threw. The card has already moved, so this is reported, not raised. */
export class MomentFailed extends Schema.TaggedErrorClass<MomentFailed>()("MomentFailed", {
  detail: Schema.String,
}) {}

/**
 * A card has landed somewhere, or is leaving somewhere.
 *
 * Both take ids rather than the card because the store calls them either side
 * of its own write, and the card it is holding is stale on one of them.
 */
export interface BoardMoments {
  readonly entered: (input: {
    readonly cardId: string;
    readonly at: string;
    readonly from: string | null;
  }) => Promise<void>;
  readonly left: (input: {
    readonly cardId: string;
    readonly from: string;
    readonly to: string | null;
  }) => Promise<void>;
}

let bound: BoardMoments | null = null;

export function bindBoardMoments(moments: BoardMoments | null): void {
  bound = moments;
}

/**
 * Run a moment, if anything is listening.
 *
 * A rule that throws must not fail the write that triggered it: the card has
 * already moved, and a failed arrival is a rule that did not run, not a move
 * that did not happen. It is logged and the move stands.
 */
export function fireMoment(run: (moments: BoardMoments) => Promise<void>): Effect.Effect<void> {
  const listener = bound;
  if (listener === null) return Effect.void;
  return Effect.tryPromise({
    try: () => run(listener),
    catch: (cause) =>
      new MomentFailed({ detail: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(Effect.ignoreCause({ log: true }));
}
