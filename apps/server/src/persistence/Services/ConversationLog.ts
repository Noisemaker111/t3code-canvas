/**
 * ConversationLogRepository - read-only access to the `conversation_log` view.
 *
 * The view (migration 033) flattens the projected coding transcript into one
 * row per prompt / response / tool_call / system entry. It is the transcript
 * source for the btw side-chat; consumers read it rather than re-deriving from
 * orchestration events.
 *
 * @module ConversationLogRepository
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ConversationLogEntryType = Schema.Literals([
  "prompt",
  "response",
  "tool_call",
  "system",
]);
export type ConversationLogEntryType = typeof ConversationLogEntryType.Type;

export const ConversationLogEntry = Schema.Struct({
  createdAt: IsoDateTime,
  projectId: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  turnId: Schema.NullOr(Schema.String),
  entryType: ConversationLogEntryType,
  role: Schema.NullOr(Schema.String),
  toolKind: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
});
export type ConversationLogEntry = typeof ConversationLogEntry.Type;

export const ListConversationLogInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListConversationLogInput = typeof ListConversationLogInput.Type;

export interface ConversationLogRepositoryShape {
  /** List a thread's transcript entries in ascending time order. */
  readonly listByThreadId: (
    input: ListConversationLogInput,
  ) => Effect.Effect<ReadonlyArray<ConversationLogEntry>, ProjectionRepositoryError>;
}

export class ConversationLogRepository extends Context.Service<
  ConversationLogRepository,
  ConversationLogRepositoryShape
>()("t3/persistence/Services/ConversationLog/ConversationLogRepository") {}
