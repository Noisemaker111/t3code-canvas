import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeHermesOperationStore } from "./operationStore.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

layer("Hermes operation store", (it) => {
  it.effect("allows only one concurrent claimant for a semantic action", () =>
    Effect.gen(function* () {
      const store = yield* makeHermesOperationStore;
      const claim = (leaseOwner: string) =>
        store.claim({
          idempotencyKey: "concurrent-action",
          cardId: "card-concurrent",
          method: "openPr",
          detail: "Open pull request",
          args: { id: "card-concurrent" },
          leaseOwner,
          leaseMs: 60_000,
        });

      const claims = yield* Effect.promise(() =>
        Promise.all([claim("worker-a"), claim("worker-b")]),
      );

      assert.equal(claims.filter(({ kind }) => kind === "claimed").length, 1);
      assert.equal(claims.filter(({ kind }) => kind === "existing").length, 1);
      assert.equal(claims[0]?.operation.id, claims[1]?.operation.id);
    }),
  );

  it.effect("deduplicates an applied operation and keeps its result", () =>
    Effect.gen(function* () {
      const store = yield* makeHermesOperationStore;
      const first = yield* Effect.promise(() =>
        store.claim({
          idempotencyKey: "same-action",
          cardId: "card-1",
          method: "launchActive",
          detail: "Launch coding agent",
          args: { id: "card-1" },
          leaseOwner: "worker-1",
          leaseMs: 60_000,
        }),
      );
      assert.equal(first.kind, "claimed");
      if (first.kind !== "claimed") return;

      yield* Effect.promise(() =>
        store.complete({
          id: first.operation.id,
          leaseOwner: "worker-1",
          result: { threadId: "thread-1" },
        }),
      );
      const duplicate = yield* Effect.promise(() =>
        store.claim({
          idempotencyKey: "same-action",
          cardId: "card-1",
          method: "launchActive",
          detail: "Launch coding agent",
          args: { id: "card-1" },
          leaseOwner: "worker-2",
          leaseMs: 60_000,
        }),
      );

      assert.equal(duplicate.kind, "existing");
      assert.equal(duplicate.operation.status, "applied");
      assert.deepEqual(duplicate.operation.result, { threadId: "thread-1" });
    }),
  );

  it.effect("retries an interrupted operation after an expired lease", () =>
    Effect.gen(function* () {
      const store = yield* makeHermesOperationStore;
      const started = new Date("2026-01-01T00:00:00.000Z");
      const claim = (leaseOwner: string, now: Date) =>
        store.claim({
          idempotencyKey: "crashed-action",
          cardId: "card-2",
          method: "nudgeThread",
          detail: "Nudge coding agent",
          args: { threadId: "thread-2", text: "status?" },
          leaseOwner,
          leaseMs: 1_000,
          now,
        });
      const first = yield* Effect.promise(() => claim("dead-worker", started));
      assert.equal(first.kind, "claimed");

      const recovered = yield* Effect.promise(() =>
        store.recoverExpired(new Date("2026-01-01T00:00:02.000Z")),
      );
      assert.equal(recovered, 1);
      const second = yield* Effect.promise(() =>
        claim("new-worker", new Date("2026-01-01T00:00:03.000Z")),
      );

      assert.equal(second.kind, "claimed");
      assert.equal(second.operation.status, "running");
      assert.equal(second.operation.attempt, 2);
      assert.equal(second.operation.error, null);
    }),
  );

  it.effect("retries a failed operation up to the limit, then holds it", () =>
    Effect.gen(function* () {
      const store = yield* makeHermesOperationStore;
      const claim = () =>
        store.claim({
          idempotencyKey: "failing-action",
          cardId: "card-3",
          method: "openPr",
          detail: "Open pull request",
          args: { id: "card-3" },
          leaseOwner: "worker",
          leaseMs: 60_000,
          retryLimit: 3,
        });
      const attempts: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        const claimed = yield* Effect.promise(() => claim());
        if (claimed.kind !== "claimed") break;
        attempts.push(claimed.operation.attempt);
        yield* Effect.promise(() =>
          store.fail({ id: claimed.operation.id, leaseOwner: "worker", error: "gh push refused" }),
        );
      }
      assert.deepEqual(attempts, [1, 2, 3]);

      const held = yield* Effect.promise(() => claim());
      assert.equal(held.kind, "existing");
      assert.equal(held.operation.status, "failed");
      assert.equal(held.operation.attempt, 3);

      // A restart is the operator asking for these again.
      assert.equal(yield* Effect.promise(() => store.rearmForRetry()), 1);
      const afterRestart = yield* Effect.promise(() => claim());
      assert.equal(afterRestart.kind, "claimed");
      assert.equal(afterRestart.operation.attempt, 1);
    }),
  );
});
