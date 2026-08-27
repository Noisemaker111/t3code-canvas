import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AppendBtwMessageInput,
  BtwMessageRepository,
  type BtwMessageRepositoryShape,
  BtwMessageRow,
  DeleteBtwMessagesInput,
  ListBtwMessagesInput,
} from "../Services/BtwMessages.ts";

const makeBtwMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendBtwMessageRow = SqlSchema.void({
    Request: AppendBtwMessageInput,
    execute: (row) =>
      sql`
        INSERT INTO btw_messages (
          btw_session_id,
          thread_id,
          role,
          content,
          created_at
        )
        VALUES (
          ${row.btwSessionId},
          ${row.threadId},
          ${row.role},
          ${row.content},
          ${row.createdAt}
        )
      `,
  });

  const listBtwMessageRows = SqlSchema.findAll({
    Request: ListBtwMessagesInput,
    Result: BtwMessageRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          btw_session_id AS "btwSessionId",
          thread_id AS "threadId",
          role,
          content,
          created_at AS "createdAt"
        FROM btw_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, row_id ASC
      `,
  });

  const deleteBtwMessageRows = SqlSchema.void({
    Request: DeleteBtwMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM btw_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const append: BtwMessageRepositoryShape["append"] = (input) =>
    appendBtwMessageRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BtwMessageRepository.append:query")),
    );

  const listByThreadId: BtwMessageRepositoryShape["listByThreadId"] = (input) =>
    listBtwMessageRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BtwMessageRepository.listByThreadId:query")),
      Effect.map((rows) => rows.slice()),
    );

  const deleteByThreadId: BtwMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteBtwMessageRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BtwMessageRepository.deleteByThreadId:query")),
    );

  return {
    append,
    listByThreadId,
    deleteByThreadId,
  } satisfies BtwMessageRepositoryShape;
});

export const BtwMessageRepositoryLive = Layer.effect(
  BtwMessageRepository,
  makeBtwMessageRepository,
);
