import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ConversationLogEntry,
  ConversationLogRepository,
  type ConversationLogRepositoryShape,
  ListConversationLogInput,
} from "../Services/ConversationLog.ts";

const makeConversationLogRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listConversationLogRows = SqlSchema.findAll({
    Request: ListConversationLogInput,
    Result: ConversationLogEntry,
    execute: ({ threadId }) =>
      sql`
        SELECT
          created_at AS "createdAt",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          entry_type AS "entryType",
          role,
          tool_kind AS "toolKind",
          text,
          tokens,
          duration_ms AS "durationMs"
        FROM conversation_log
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
      `,
  });

  const listByThreadId: ConversationLogRepositoryShape["listByThreadId"] = (input) =>
    listConversationLogRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ConversationLogRepository.listByThreadId:query")),
      Effect.map((rows) => rows.slice()),
    );

  return { listByThreadId } satisfies ConversationLogRepositoryShape;
});

export const ConversationLogRepositoryLive = Layer.effect(
  ConversationLogRepository,
  makeConversationLogRepository,
);
