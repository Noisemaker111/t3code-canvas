import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BtwMessageRepository, btwSessionIdForThread } from "../Services/BtwMessages.ts";
import { BtwMessageRepositoryLive } from "./BtwMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(BtwMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("BtwMessageRepository", (it) => {
  it.effect("appends and lists a thread's btw messages in creation order", () =>
    Effect.gen(function* () {
      const repository = yield* BtwMessageRepository;
      const threadId = ThreadId.make("thread-btw-order");
      const btwSessionId = btwSessionIdForThread(threadId);

      yield* repository.append({
        btwSessionId,
        threadId,
        role: "user",
        content: "what did we change in the auth flow?",
        createdAt: "2026-02-28T19:00:00.000Z",
      });
      yield* repository.append({
        btwSessionId,
        threadId,
        role: "assistant",
        content: "You swapped the session store for a DPoP-backed one.",
        createdAt: "2026-02-28T19:00:01.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.role, "user");
      assert.equal(rows[1]?.role, "assistant");
      assert.equal(rows[0]?.btwSessionId, btwSessionId);
    }),
  );

  it.effect("clears a thread's btw session without touching other threads", () =>
    Effect.gen(function* () {
      const repository = yield* BtwMessageRepository;
      const threadId = ThreadId.make("thread-btw-clear");
      const otherThreadId = ThreadId.make("thread-btw-keep");

      yield* repository.append({
        btwSessionId: btwSessionIdForThread(threadId),
        threadId,
        role: "user",
        content: "hello",
        createdAt: "2026-02-28T19:10:00.000Z",
      });
      yield* repository.append({
        btwSessionId: btwSessionIdForThread(otherThreadId),
        threadId: otherThreadId,
        role: "user",
        content: "keep me",
        createdAt: "2026-02-28T19:10:00.000Z",
      });

      yield* repository.deleteByThreadId({ threadId });

      const cleared = yield* repository.listByThreadId({ threadId });
      const kept = yield* repository.listByThreadId({ threadId: otherThreadId });
      assert.equal(cleared.length, 0);
      assert.equal(kept.length, 1);
      assert.equal(kept[0]?.content, "keep me");
    }),
  );
});
