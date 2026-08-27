/**
 * btw — "by the way" side-chat contracts.
 *
 * The btw chat is a SEPARATE conversation the user has with a model ABOUT the
 * current coding thread. It has its own persisted message history (one btw
 * session per thread) and never mixes into the main coding transcript.
 *
 * @module btw
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Role of a persisted btw message. Unlike the orchestration transcript there is
 * no `system`/`tool` role here — the btw system prompt is rebuilt per turn from
 * the coding transcript and is never stored as a message.
 */
export const BtwMessageRole = Schema.Literals(["user", "assistant"]);
export type BtwMessageRole = typeof BtwMessageRole.Type;

/** A single persisted btw message returned to the client. */
export const BtwMessage = Schema.Struct({
  role: BtwMessageRole,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type BtwMessage = typeof BtwMessage.Type;

export const BtwListMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type BtwListMessagesInput = typeof BtwListMessagesInput.Type;

export const BtwListMessagesResult = Schema.Struct({
  messages: Schema.Array(BtwMessage),
});
export type BtwListMessagesResult = typeof BtwListMessagesResult.Type;

export const BtwClearInput = Schema.Struct({
  threadId: ThreadId,
});
export type BtwClearInput = typeof BtwClearInput.Type;

export const BtwClearResult = Schema.Struct({});
export type BtwClearResult = typeof BtwClearResult.Type;

export const BtwSendMessageInput = Schema.Struct({
  threadId: ThreadId,
  /** The new user message to append to the btw conversation. */
  message: Schema.String,
  /**
   * Optional model slug (e.g. `claude-haiku-4-5`). Defaults server-side to a
   * small/cheap model when omitted.
   */
  model: Schema.optional(Schema.String),
});
export type BtwSendMessageInput = typeof BtwSendMessageInput.Type;

/**
 * One streamed chunk of a btw reply.
 * - `delta` carries an incremental slice of assistant text.
 * - `done` is emitted once at the end with the fully persisted assistant message.
 */
export const BtwStreamChunk = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("delta"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("done"), message: BtwMessage }),
]);
export type BtwStreamChunk = typeof BtwStreamChunk.Type;

export class BtwChatError extends Schema.TaggedErrorClass<BtwChatError>()("BtwChatError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
