import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { HermesCardOperation } from "@t3tools/contracts";

export type HermesOperationRecord = HermesCardOperation & {
  readonly idempotencyKey: string;
  readonly cardId: string | null;
  readonly args: unknown;
  readonly result: unknown;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
};

export type HermesOperationClaim =
  | { readonly kind: "claimed"; readonly operation: HermesOperationRecord }
  | { readonly kind: "existing"; readonly operation: HermesOperationRecord };

export interface HermesOperationStore {
  readonly claim: (input: {
    readonly idempotencyKey: string;
    readonly cardId: string | null;
    readonly method: string;
    readonly detail: string;
    readonly args: unknown;
    readonly leaseOwner: string;
    readonly leaseMs: number;
    readonly retryLimit?: number;
    readonly now?: Date;
  }) => Promise<HermesOperationClaim>;
  readonly complete: (input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly result: unknown;
    readonly now?: Date;
  }) => Promise<HermesOperationRecord>;
  readonly fail: (input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly error: string;
    readonly now?: Date;
  }) => Promise<HermesOperationRecord>;
  readonly recoverExpired: (now?: Date) => Promise<number>;
  readonly rearmForRetry: (now?: Date) => Promise<number>;
}

/**
 * Attempts a single terminal-unsuccessful operation gets before the card has to
 * wait for the board to change or for Hermes to restart. Failed and interrupted
 * operations never applied, so repeating one is the recovery — the limit only
 * stops a deterministically broken call from burning every tick.
 */
const DEFAULT_RETRY_LIMIT = 3;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toRecord(row: Record<string, unknown>): HermesOperationRecord {
  return {
    id: String(row["id"]),
    idempotencyKey: String(row["idempotencyKey"]),
    cardId: stringOrNull(row["cardId"]),
    method: String(row["method"]),
    status: String(row["status"]) as HermesOperationRecord["status"],
    attempt: Number(row["attempt"]),
    detail: String(row["detail"]),
    args: parseJson(row["argsJson"]),
    result: parseJson(row["resultJson"]),
    error: stringOrNull(row["errorText"]),
    leaseOwner: stringOrNull(row["leaseOwner"]),
    leaseExpiresAt: stringOrNull(row["leaseExpiresAt"]),
    startedAt: String(row["startedAt"]) as unknown as HermesOperationRecord["startedAt"],
    finishedAt: stringOrNull(row["finishedAt"]) as HermesOperationRecord["finishedAt"],
  };
}

const SELECT_OPERATION = `
  id AS "id",
  idempotency_key AS "idempotencyKey",
  card_id AS "cardId",
  method AS "method",
  status AS "status",
  attempt AS "attempt",
  detail AS "detail",
  args_json AS "argsJson",
  result_json AS "resultJson",
  error_text AS "errorText",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  started_at AS "startedAt",
  finished_at AS "finishedAt"
`;

function operationError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

export const makeHermesOperationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const findByKey = (idempotencyKey: string) =>
    sql`SELECT ${sql.unsafe(SELECT_OPERATION)} FROM hermes_card_operations WHERE idempotency_key = ${idempotencyKey} LIMIT 1`;

  const findById = (id: string) =>
    sql`SELECT ${sql.unsafe(SELECT_OPERATION)} FROM hermes_card_operations WHERE id = ${id} LIMIT 1`;

  const requireRow = async (
    effect: Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>,
  ) => {
    const rows = await Effect.runPromise(
      effect.pipe(
        Effect.mapError((cause) => operationError("Hermes operation read failed", cause)),
      ),
    );
    const row = rows[0];
    if (!row) throw operationError("Hermes operation disappeared while it was running");
    return toRecord(row);
  };

  const claim: HermesOperationStore["claim"] = async (input) => {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    const existingRows = await Effect.runPromise(
      findByKey(input.idempotencyKey).pipe(
        Effect.mapError((cause) => operationError("Hermes operation claim read failed", cause)),
      ),
    );
    const existing = existingRows[0] ? toRecord(existingRows[0]) : null;
    if (existing) {
      if (existing.status === "applied") return { kind: "existing", operation: existing };
      if (existing.status === "running") {
        const leaseLive =
          existing.leaseExpiresAt === null || Date.parse(existing.leaseExpiresAt) > now.getTime();
        if (leaseLive) return { kind: "existing", operation: existing };
        await Effect.runPromise(
          sql`
            UPDATE hermes_card_operations
            SET status = ${"interrupted"}, error_text = ${"Hermes stopped before confirming this operation."},
                lease_owner = NULL, lease_expires_at = NULL, finished_at = ${nowIso}, updated_at = ${nowIso}
            WHERE id = ${existing.id} AND status = ${"running"}
          `.pipe(
            Effect.mapError((cause) => operationError("Hermes operation recovery failed", cause)),
          ),
        );
      }

      const attempt = existing.attempt + 1;
      if (attempt > (input.retryLimit ?? DEFAULT_RETRY_LIMIT)) {
        return { kind: "existing", operation: await requireRow(findById(existing.id)) };
      }
      const rearmed = await Effect.runPromise(
        sql`
          UPDATE hermes_card_operations
          SET status = ${"running"}, attempt = ${attempt}, error_text = NULL, result_json = NULL,
              lease_owner = ${input.leaseOwner}, lease_expires_at = ${leaseExpiresAt},
              started_at = ${nowIso}, finished_at = NULL, updated_at = ${nowIso}
          WHERE id = ${existing.id} AND status IN (${"failed"}, ${"interrupted"})
          RETURNING ${sql.unsafe(SELECT_OPERATION)}
        `.pipe(Effect.mapError((cause) => operationError("Hermes operation retry failed", cause))),
      );
      const row = rearmed[0];
      // Lost the race to another claimant, which now owns the retry.
      if (!row) return { kind: "existing", operation: await requireRow(findById(existing.id)) };
      return { kind: "claimed", operation: toRecord(row) };
    }

    const id = await Effect.runPromise(
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => operationError("Hermes operation id failed", cause)),
      ),
    );
    await Effect.runPromise(
      sql`
        INSERT OR IGNORE INTO hermes_card_operations (
          id, idempotency_key, card_id, method, status, attempt, detail, args_json,
          result_json, error_text, lease_owner, lease_expires_at, started_at,
          finished_at, created_at, updated_at
        ) VALUES (
          ${id}, ${input.idempotencyKey}, ${input.cardId}, ${input.method}, ${"running"}, ${1},
          ${input.detail}, ${JSON.stringify(input.args ?? null)}, NULL, NULL, ${input.leaseOwner},
          ${leaseExpiresAt}, ${nowIso}, NULL, ${nowIso}, ${nowIso}
        )
      `.pipe(Effect.mapError((cause) => operationError("Hermes operation claim failed", cause))),
    );
    const operation = await requireRow(findByKey(input.idempotencyKey));
    return operation.id === id ? { kind: "claimed", operation } : { kind: "existing", operation };
  };

  const complete: HermesOperationStore["complete"] = async (input) => {
    const nowIso = (input.now ?? new Date()).toISOString();
    const rows = await Effect.runPromise(
      sql`
        UPDATE hermes_card_operations
        SET status = ${"applied"}, result_json = ${JSON.stringify(input.result ?? null)},
            error_text = NULL, lease_owner = NULL, lease_expires_at = NULL,
            finished_at = ${nowIso}, updated_at = ${nowIso}
        WHERE id = ${input.id} AND status = ${"running"} AND lease_owner = ${input.leaseOwner}
        RETURNING ${sql.unsafe(SELECT_OPERATION)}
      `.pipe(
        Effect.mapError((cause) => operationError("Hermes operation completion failed", cause)),
      ),
    );
    const row = rows[0];
    if (!row) throw operationError("Hermes operation lease was lost before completion");
    return toRecord(row);
  };

  const fail: HermesOperationStore["fail"] = async (input) => {
    const nowIso = (input.now ?? new Date()).toISOString();
    const rows = await Effect.runPromise(
      sql`
        UPDATE hermes_card_operations
        SET status = ${"failed"}, error_text = ${input.error}, lease_owner = NULL,
            lease_expires_at = NULL, finished_at = ${nowIso}, updated_at = ${nowIso}
        WHERE id = ${input.id} AND status = ${"running"} AND lease_owner = ${input.leaseOwner}
        RETURNING ${sql.unsafe(SELECT_OPERATION)}
      `.pipe(
        Effect.mapError((cause) => operationError("Hermes operation failure write failed", cause)),
      ),
    );
    const row = rows[0];
    if (!row) throw operationError("Hermes operation lease was lost before failure was recorded");
    return toRecord(row);
  };

  const recoverExpired: HermesOperationStore["recoverExpired"] = async (now = new Date()) => {
    const nowIso = now.toISOString();
    const rows = await Effect.runPromise(
      sql`
        UPDATE hermes_card_operations
        SET status = ${"interrupted"}, error_text = ${"Hermes stopped before confirming this operation."},
            lease_owner = NULL, lease_expires_at = NULL, finished_at = ${nowIso}, updated_at = ${nowIso}
        WHERE status = ${"running"} AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${nowIso}
        RETURNING id
      `.pipe(Effect.mapError((cause) => operationError("Hermes operation recovery failed", cause))),
    );
    return rows.length;
  };

  /**
   * A restart is the operator saying "try again": clear the retry budget of
   * every operation that never applied, so cards parked on a spent budget are
   * live work again instead of tombstones nothing on the board can move.
   */
  const rearmForRetry: HermesOperationStore["rearmForRetry"] = async () => {
    // updated_at is untouched on purpose: it orders which operation a card
    // shows, and a boot must not drag an old failure back over a newer receipt.
    const rows = await Effect.runPromise(
      sql`
        UPDATE hermes_card_operations
        SET attempt = ${0}
        WHERE status IN (${"failed"}, ${"interrupted"}) AND attempt > ${0}
        RETURNING id
      `.pipe(Effect.mapError((cause) => operationError("Hermes operation rearm failed", cause))),
    );
    return rows.length;
  };

  return { claim, complete, fail, recoverExpired, rearmForRetry } satisfies HermesOperationStore;
});
