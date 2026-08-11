import * as NodeServices from "@effect/platform-node/NodeServices";
import { KanbanCardId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorktreeReaper from "../vcs/WorktreeReaper.ts";
import { KanbanStore } from "./KanbanStore.ts";
import * as KanbanStoreLayer from "./KanbanStore.ts";

const reaped: Array<string> = [];

const reaperLayer = Layer.succeed(WorktreeReaper.WorktreeReaper, {
  reapThreadWorktree: (threadId: string) =>
    Effect.sync(() => {
      reaped.push(threadId);
      return { kind: "removed", path: `/root/projects/.worktrees/thread-${threadId}` } as const;
    }),
} as unknown as WorktreeReaper.WorktreeReaper["Service"]);

const layer = it.layer(
  KanbanStoreLayer.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(reaperLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("KanbanStore worktree teardown", (it) => {
  // Leaving a component is a rule now — Active's "a card leaves → its workspace
  // is released" — so the store does not reap on a move. It has no way to run a
  // rule: the verbs live behind BoardApi, which is assembled far above it, and
  // this test binds no moments listener. `components/seed.test.ts` is where
  // that rule is asserted to exist.
  it.effect("leaves the reap on a move to the rule that owns it", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Ship it", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId: "thread-abc",
      });

      yield* store.update({ id: card.id as KanbanCardId, at: "pr" });

      assert.deepEqual(reaped, []);
    }),
  );

  it.effect("leaves the worktree alone while the card stays in Active", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Still working", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId: "thread-def",
      });

      yield* store.update({ id: card.id as KanbanCardId, body: "more details" });
      yield* store.update({ id: card.id as KanbanCardId, at: "active", position: 3 });

      assert.deepEqual(reaped, []);
    }),
  );

  it.effect("reaps when a card is archived in place while Active", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Archive me", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId: "thread-ghi",
      });

      // Archiving clears the card from the board without a column move — the
      // session is just as gone as if it had moved to Done.
      yield* store.update({ id: card.id as KanbanCardId, archived: true });

      assert.deepEqual(reaped, ["thread-ghi"]);
    }),
  );

  it.effect("does not reap again when an archived card is touched", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Already archived", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId: "thread-jkl",
      });
      yield* store.update({ id: card.id as KanbanCardId, archived: true });
      reaped.length = 0;

      yield* store.update({ id: card.id as KanbanCardId, archived: true, position: 2 });

      assert.deepEqual(reaped, []);
    }),
  );

  it.effect("reaps when a card is deleted while it still owns a thread", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Delete me", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId: "thread-mno",
      });

      const result = yield* store.remove({ id: card.id as KanbanCardId });

      assert.equal(result.deleted, true);
      assert.deepEqual(reaped, ["thread-mno"]);
    }),
  );

  it.effect("does not reap a card that never had a thread", () =>
    Effect.gen(function* () {
      reaped.length = 0;
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "No thread", body: "details" });
      yield* store.update({ id: card.id as KanbanCardId, at: "active", prepStatus: "ready" });
      yield* store.update({ id: card.id as KanbanCardId, at: "done" });

      assert.deepEqual(reaped, []);
    }),
  );
});
