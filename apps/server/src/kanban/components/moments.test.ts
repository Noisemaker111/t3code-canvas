import * as NodeServices from "@effect/platform-node/NodeServices";
import { KanbanCardId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { KanbanStore } from "../KanbanStore.ts";
import * as KanbanStoreLayer from "../KanbanStore.ts";
import { bindBoardMoments } from "./moments.ts";

const layer = it.layer(
  KanbanStoreLayer.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-moments-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("board moments", (it) => {
  it.effect("tells the listener a card left one component and entered another", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      bindBoardMoments({
        entered: async ({ cardId, at, from }) => void seen.push(`enter ${cardId} ${from}→${at}`),
        left: async ({ cardId, from, to }) => void seen.push(`exit ${cardId} ${from}→${to}`),
      });

      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Ship it", body: "details" });
      yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        prepStatus: "ready",
        threadId: "thread-1",
      });

      // Leaving is told before entering, so an exit rule still sees the card
      // where its rules apply.
      assert.deepEqual(seen, [`exit ${card.id} prompts→active`, `enter ${card.id} prompts→active`]);
      bindBoardMoments(null);
    }),
  );

  it.effect("says nothing when a write does not move the card", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      bindBoardMoments({
        entered: async () => void seen.push("enter"),
        left: async () => void seen.push("exit"),
      });

      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Edit me", body: "details" });
      yield* store.update({ id: card.id as KanbanCardId, body: "edited" });
      // Writing the component a card is already at is not a move.
      yield* store.update({ id: card.id as KanbanCardId, at: "prompts" });

      assert.deepEqual(seen, []);
      bindBoardMoments(null);
    }),
  );

  // The card has already moved by the time a rule runs. A rule that throws is a
  // rule that did not run, not a move that did not happen.
  it.effect("keeps the move when a rule throws", () =>
    Effect.gen(function* () {
      bindBoardMoments({
        entered: () => Promise.reject(new Error("rule exploded")),
        left: () => Promise.resolve(),
      });

      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Boom", body: "details" });
      const moved = yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        prepStatus: "ready",
      });

      assert.equal(moved.at, "active");
      bindBoardMoments(null);
    }),
  );

  it.effect("runs nothing when no listener is bound", () =>
    Effect.gen(function* () {
      bindBoardMoments(null);
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Quiet", body: "details" });
      const moved = yield* store.update({
        id: card.id as KanbanCardId,
        at: "active",
        prepStatus: "ready",
      });
      assert.equal(moved.at, "active");
    }),
  );
});
