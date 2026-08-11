import * as NodeServices from "@effect/platform-node/NodeServices";
import { KanbanCardId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { KanbanStore } from "./KanbanStore.ts";
import * as KanbanStoreLayer from "./KanbanStore.ts";
import { makeHermesOperationStore } from "./hermes/operationStore.ts";
import { readKanbanAttachmentBytes } from "./kanbanAttachments.ts";

const layer = it.layer(
  KanbanStoreLayer.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-store-att-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("KanbanStore", (it) => {
  it.effect("projects the latest durable Hermes operation onto its card", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const operations = yield* makeHermesOperationStore;
      const card = yield* store.create({ title: "Durable receipt" });
      const claim = yield* Effect.promise(() =>
        operations.claim({
          idempotencyKey: `update:${card.id}`,
          cardId: card.id,
          method: "updateCard",
          detail: "Update card",
          args: { id: card.id, body: "structured" },
          leaseOwner: "test-worker",
          leaseMs: 60_000,
        }),
      );
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") return;

      yield* Effect.promise(() =>
        operations.complete({
          id: claim.operation.id,
          leaseOwner: "test-worker",
          result: { ok: true },
        }),
      );

      const listed = yield* store.list();
      const projected = listed.cards.find((entry) => entry.id === card.id);
      assert.equal(projected?.hermesOperation?.status, "applied");
      assert.equal(projected?.hermesOperation?.detail, "Update card");
      assert.equal(projected?.hermesOperation?.attempt, 1);
    }),
  );

  it.effect("restarts the column clock on a move and leaves it alone on an edit", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Time in column" });
      assert.ok(card.columnEnteredAt !== null);

      const edited = yield* store.update({ id: card.id, body: "same column" });
      assert.deepEqual(edited.columnEnteredAt, card.columnEnteredAt);

      // Active takes a routed prompt; the clock is what this test is about.
      const moved = yield* store.update({ id: card.id, at: "active", prepStatus: "ready" });
      assert.ok(
        DateTime.toEpochMillis(moved.columnEnteredAt!) >=
          DateTime.toEpochMillis(card.columnEnteredAt!),
      );
    }),
  );

  it.effect("keeps every stage stamp on the card once it ships", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Prompt to ship" });
      yield* store.update({ id: card.id, at: "active", prepStatus: "ready" });
      yield* store.update({ id: card.id, at: "pr", threadId: "thread-ship" });
      const shipped = yield* store.update({ id: card.id, at: "done" });

      assert.ok(shipped.timeline.launchedAt !== null);
      assert.ok(shipped.timeline.prOpenedAt !== null);
      assert.ok(shipped.timeline.shippedAt !== null);
      assert.ok(
        DateTime.toEpochMillis(shipped.timeline.shippedAt!) >=
          DateTime.toEpochMillis(shipped.timeline.launchedAt!),
      );

      // A card pulled back keeps the stamps it earned.
      const reopened = yield* store.update({ id: card.id, at: "active" });
      assert.deepEqual(reopened.timeline, shipped.timeline);
    }),
  );

  it.effect("stamps a card created straight into PR from where it stands", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      // An adopted orphan PR: Hermes creates it in `pr`, so it never moved.
      const card = yield* store.create({ title: "Adopted PR", at: "pr" });
      assert.ok(card.timeline.prOpenedAt !== null);
      assert.equal(card.timeline.launchedAt, null);
      assert.equal(card.timeline.shippedAt, null);
    }),
  );

  it.effect("stores the pull request identity the card face shows", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "PR identity" });
      const updated = yield* store.update({
        id: card.id,
        at: "pr",
        prUrl: "https://github.com/Noisemaker111/vps-code/pull/1450",
        prTitle: "fix(kanban): one status line per card",
        prNumber: 1450,
      });

      assert.equal(updated.prTitle, "fix(kanban): one status line per card");
      assert.equal(updated.prNumber, 1450);

      const listed = yield* store.list();
      const projected = listed.cards.find((entry) => entry.id === card.id);
      assert.equal(projected?.prNumber, 1450);
    }),
  );

  it.effect("persists CI checks only for the PR URL they describe", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Durable CI" });
      const prUrl = "https://github.com/Noisemaker111/vps-code/pull/1450";
      yield* store.update({ id: card.id, at: "pr", prUrl });
      const checkedAt = yield* DateTime.now;
      yield* store.savePrChecks({
        cardId: card.id,
        prUrl,
        checks: {
          cardId: card.id,
          state: "passing",
          total: 2,
          passing: 2,
          failing: 0,
          pending: 0,
          failingNames: [],
          failingUrl: null,
          unknownReason: null,
          unknownDetail: null,
          checkedAt,
        },
      });

      const [persisted] = yield* store.listPrChecks();
      assert.equal(persisted?.state, "passing");
      assert.equal(persisted?.total, 2);

      yield* store.update({
        id: card.id,
        prUrl: "https://github.com/Noisemaker111/vps-code/pull/1451",
      });
      assert.deepEqual(yield* store.listPrChecks(), []);
    }),
  );

  it.effect("creates a card in the prompts column by default", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "Investigate flaky test", body: "details" });

      assert.equal(card.title, "Investigate flaky test");
      assert.equal(card.body, "details");
      assert.equal(card.at, "prompts");
      assert.equal(card.threadId, null);
      assert.equal(card.prUrl, null);
      assert.equal(card.projectId, null);

      const { cards } = yield* store.list();
      assert.equal(
        cards.some((entry) => entry.id === card.id && entry.at === "prompts"),
        true,
      );
    }),
  );

  it("remaps the lanes the board removed and keeps every other column id", () => {
    assert.equal(KanbanStoreLayer.normalizeComponentId("draft"), "prompts");
    assert.equal(KanbanStoreLayer.normalizeComponentId("main"), "pr");
    assert.equal(KanbanStoreLayer.normalizeComponentId("prompts"), "prompts");
    assert.equal(KanbanStoreLayer.normalizeComponentId("active"), "active");
    // Which columns a board has is board settings, so an id this file does not
    // know is a column somebody made, not a typo to collapse into Prompts.
    assert.equal(KanbanStoreLayer.normalizeComponentId("research"), "research");
    assert.equal(KanbanStoreLayer.normalizeComponentId("  review  "), "review");
    assert.equal(KanbanStoreLayer.normalizeComponentId(""), "prompts");
  });

  it.effect("archives a card off the board and restores it", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "stale work" });

      const archived = yield* store.update({ id: card.id, archived: true });
      assert.notEqual(archived.archivedAt, null);

      const board = yield* store.list();
      assert.equal(
        board.cards.some((entry) => entry.id === card.id),
        false,
      );

      const withArchived = yield* store.list({ includeArchived: true });
      assert.equal(
        withArchived.cards.some((entry) => entry.id === card.id),
        true,
      );

      const restored = yield* store.update({ id: card.id, archived: false });
      assert.equal(restored.archivedAt, null);
      const after = yield* store.list();
      assert.equal(
        after.cards.some((entry) => entry.id === card.id),
        true,
      );
    }),
  );

  it.effect("keeps a card archived through an unrelated update", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "archived then edited" });
      yield* store.update({ id: card.id, archived: true });

      const edited = yield* store.update({ id: card.id, title: "new title" });

      assert.equal(edited.title, "new title");
      assert.notEqual(edited.archivedAt, null);
    }),
  );

  it.effect("assigns increasing positions within a column", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const first = yield* store.create({ title: "first" });
      const second = yield* store.create({ title: "second" });

      assert.equal(second.position > first.position, true);
    }),
  );

  it.effect("moves a card to another column and preserves edits", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "ship it" });

      const moved = yield* store.update({
        id: card.id,
        at: "pr",
        position: 5,
        prUrl: "https://example.com/pr/1",
      });

      assert.equal(moved.at, "pr");
      assert.equal(moved.position, 5);
      assert.equal(moved.prUrl, "https://example.com/pr/1");
      assert.equal(moved.title, "ship it");

      const { cards } = yield* store.list();
      const found = cards.find((entry) => entry.id === card.id);
      assert.equal(found?.at, "pr");
      assert.equal(found?.prUrl, "https://example.com/pr/1");
    }),
  );

  it.effect("clears a nullable field when explicitly set to null", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "with pr" });
      yield* store.update({ id: card.id, prUrl: "https://example.com/pr/2" });

      const cleared = yield* store.update({ id: card.id, prUrl: null });
      assert.equal(cleared.prUrl, null);
    }),
  );

  it.effect("stores the base branch a card's worktree is cut from", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const inherited = yield* store.create({ title: "inherits", body: "task" });
      assert.equal(inherited.baseBranch, null);

      const pinned = yield* store.create({
        title: "pinned",
        body: "task",
        baseBranch: "integration/next",
      });
      assert.equal(pinned.baseBranch, "integration/next");

      const moved = yield* store.update({ id: pinned.id, baseBranch: "release/2026-08" });
      assert.equal(moved.baseBranch, "release/2026-08");

      // Untouched by an unrelated edit, cleared only when asked.
      const retitled = yield* store.update({ id: pinned.id, title: "still pinned" });
      assert.equal(retitled.baseBranch, "release/2026-08");

      const cleared = yield* store.update({ id: pinned.id, baseBranch: null });
      assert.equal(cleared.baseBranch, null);
    }),
  );

  it.effect("stores projectId for Hermes launch assignment", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({
        title: "for repo",
        body: "task",
        at: "prompts",
        prepStatus: "ready",
        projectId: "proj-abc" as never,
      });
      assert.equal(card.projectId, "proj-abc");

      const moved = yield* store.update({ id: card.id, projectId: "proj-xyz" as never });
      assert.equal(moved.projectId, "proj-xyz");

      const cleared = yield* store.update({ id: card.id, projectId: null });
      assert.equal(cleared.projectId, null);
    }),
  );

  it.effect("fails with KanbanCardNotFoundError for an unknown card", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const error = yield* Effect.flip(
        store.update({ id: KanbanCardId.make("does-not-exist"), title: "x" }),
      );

      assert.equal(error._tag, "KanbanCardNotFoundError");
    }),
  );

  it.effect("deletes a card", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "temporary" });

      const deleted = yield* store.remove({ id: card.id });
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.id, card.id);

      const missing = yield* store.remove({ id: card.id });
      assert.equal(missing.deleted, false);
    }),
  );

  it.effect("keeps append-only skill history after card delete", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const card = yield* store.create({ title: "history card", body: "uhhh make div smaller" });

      const createdTrail = yield* store.listHistory({ cardId: card.id });
      assert.equal(
        createdTrail.entries.some((entry) => entry.kind === "created"),
        true,
      );

      yield* store.appendHistory({
        cardId: card.id,
        entries: [
          {
            kind: "skill",
            skillId: "structure",
            inputText: "uhhh make div smaller",
            outputText: "Mission\nMake the div smaller.",
          },
        ],
      });

      yield* store.remove({ id: card.id });
      const afterDelete = yield* store.listHistory({ cardId: card.id });
      assert.equal(afterDelete.entries.length >= 2, true);
      assert.equal(
        afterDelete.entries.some(
          (entry) => entry.kind === "skill" && entry.skillId === "structure",
        ),
        true,
      );
    }),
  );

  it.effect("persists composer attachments and can drop them on update", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      const config = yield* ServerConfig.ServerConfig;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const card = yield* store.create({
        title: "Look at this",
        body: "toast is broken",
        attachments: [
          {
            kind: "image",
            name: "toast.png",
            mimeType: "image/png",
            sizeBytes: png.byteLength,
            dataUrl: `data:image/png;base64,${png.toString("base64")}`,
          },
        ],
      });

      assert.equal(card.attachments.length, 1);
      assert.equal(card.attachments[0]?.kind, "image");
      assert.equal(card.attachments[0]?.include, true);
      const bytes = readKanbanAttachmentBytes({
        attachmentsDir: config.attachmentsDir,
        attachment: card.attachments[0]!,
      });
      assert.equal(bytes?.equals(png), true);

      const updated = yield* store.update({
        id: card.id,
        attachments: card.attachments.map((entry) => ({ ...entry, include: false })),
      });
      assert.equal(updated.attachments[0]?.include, false);

      const plain = yield* store.create({ title: "text only", body: "no media" });
      assert.equal(plain.attachments.length, 0);
    }),
  );
});
