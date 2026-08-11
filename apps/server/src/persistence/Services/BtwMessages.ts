/**
 * BtwMessageRepository - persistence for the btw side-chat.
 *
 * The btw chat is a separate conversation, one session per thread. This
 * repository owns its message history: append a message, list a thread's
 * history in creation order, and clear (delete) a thread's session.
 *
 * @module BtwMessageRepository
 */
import { BtwMessageRole, IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const BtwMessageRow = Schema.Struct({
  btwSessionId: Schema.String,
  threadId: ThreadId,
  role: BtwMessageRole,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type BtwMessageRow = typeof BtwMessageRow.Type;

export const AppendBtwMessageInput = BtwMessageRow;
export type AppendBtwMessageInput = typeof AppendBtwMessageInput.Type;

export const ListBtwMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListBtwMessagesInput = typeof ListBtwMessagesInput.Type;

export const DeleteBtwMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteBtwMessagesInput = typeof DeleteBtwMessagesInput.Type;

/**
 * Derive the single btw session id for a thread. One session per thread keeps
 * the model simple while still recording the session id on every row.
 */
export const btwSessionIdForThread = (threadId: ThreadId): string => `btw:${threadId}`;

export interface BtwMessageRepositoryShape {
  /** Append a message to a thread's btw session. */
  readonly append: (input: AppendBtwMessageInput) => Effect.Effect<void, ProjectionRepositoryError>;

  /** List a thread's btw messages in ascending creation order. */
  readonly listByThreadId: (
    input: ListBtwMessagesInput,
  ) => Effect.Effect<ReadonlyArray<BtwMessageRow>, ProjectionRepositoryError>;

  /** Clear (delete) all btw messages for a thread. */
  readonly deleteByThreadId: (
    input: DeleteBtwMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class BtwMessageRepository extends Context.Service<
  BtwMessageRepository,
  BtwMessageRepositoryShape
>()("t3/persistence/Services/BtwMessages/BtwMessageRepository") {}
