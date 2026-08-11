import { describe, expect, it } from "@effect/vitest";
import type { KanbanCard, KanbanCardId, KanbanPrChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ChangeRequestChecks } from "../sourceControl/SourceControlProvider.ts";
import { isStale, makePrChecksWatch, watchedCards } from "./PrChecksWatch.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

const cardId = (id: string) => id as KanbanCardId;

function card(input: Partial<KanbanCard> & { id: KanbanCardId }): KanbanCard {
  return {
    id: input.id,
    title: input.title ?? "card",
    body: "",
    at: input.at ?? "pr",
    position: 0,
    threadId: null,
    prUrl: input.prUrl === undefined ? "https://github.test/pr/1" : input.prUrl,
    prTitle: input.prTitle ?? null,
    prNumber: input.prNumber ?? null,
    projectId: null,
    projectRouteProvenance: null,
    modelSelection: null,
    modelRouteReason: null,
    modelRouteProvenance: null,
    modelRouteUsage: null,
    baseBranch: null,
    prepStatus: "ready",
    attachments: [],
    hermesOperation: null,
    lastRuleMove: null,
    createdAt: now,
    updatedAt: now,
    columnEnteredAt: now,
    archivedAt: input.archivedAt ?? null,
    timeline: { launchedAt: null, prOpenedAt: null, shippedAt: null },
    tokenUsage: null,
  };
}

const checks = (state: ChangeRequestChecks["state"]): ChangeRequestChecks => ({
  state,
  failing: state === "failing" ? [{ name: "ci", url: "https://github.test/run/1" }] : [],
  counts: { total: 3, passing: state === "passing" ? 3 : 1, failing: 1, pending: 1 },
});

describe("watchedCards", () => {
  it("keeps only unarchived active/pr cards that have a PR", () => {
    const ids = watchedCards([
      card({ id: cardId("pr") }),
      card({ id: cardId("active"), at: "active" }),
      card({ id: cardId("done"), at: "done" }),
      card({ id: cardId("draft"), at: "prompts" }),
      card({ id: cardId("no-pr"), prUrl: null }),
      card({ id: cardId("archived"), archivedAt: now }),
    ]).map((watched) => watched.card.id);
    expect(ids).toEqual(["pr", "active"]);
  });
});

describe("isStale", () => {
  const ttls = { pendingTtlMs: 15_000, settledTtlMs: 60_000 };
  const entry = (state: "pending" | "passing") => ({
    cardId: "a" as KanbanCardId,
    state,
    total: 1,
    passing: 1,
    failing: 0,
    pending: 0,
    failingNames: [],
    failingUrl: null,
    unknownReason: null,
    unknownDetail: null,
    checkedAt: now,
  });
  const nowMs = DateTime.toEpochMillis(now);

  it("treats a card it has never read as stale", () => {
    expect(isStale({ entry: undefined, nowMs, ...ttls })).toBe(true);
  });

  it("refreshes running checks sooner than settled ones", () => {
    expect(isStale({ entry: entry("pending"), nowMs: nowMs + 20_000, ...ttls })).toBe(true);
    expect(isStale({ entry: entry("passing"), nowMs: nowMs + 20_000, ...ttls })).toBe(false);
    expect(isStale({ entry: entry("passing"), nowMs: nowMs + 61_000, ...ttls })).toBe(true);
  });
});

describe("makePrChecksWatch", () => {
  it.effect("serves nothing until a refresh has landed", () =>
    Effect.gen(function* () {
      const watch = makePrChecksWatch({ fetch: () => Effect.succeed(checks("pending")) });
      const cards = [card({ id: cardId("a") })];
      expect(watch.snapshot(cards)).toEqual([]);

      yield* watch.refresh(cards);
      const [entry] = watch.snapshot(cards);
      expect(entry?.state).toBe("pending");
      expect(entry?.total).toBe(3);
      expect(entry?.pending).toBe(1);
    }),
  );

  it.effect("keeps the failing names and the first run link", () =>
    Effect.gen(function* () {
      const watch = makePrChecksWatch({ fetch: () => Effect.succeed(checks("failing")) });
      const cards = [card({ id: cardId("a") })];
      yield* watch.refresh(cards);
      const [entry] = watch.snapshot(cards);
      expect(entry?.state).toBe("failing");
      expect(entry?.failingNames).toEqual(["ci"]);
      expect(entry?.failingUrl).toBe("https://github.test/run/1");
    }),
  );

  it.effect("keeps a real reason when the forge verdict is unknown", () =>
    Effect.gen(function* () {
      const watch = makePrChecksWatch({
        fetch: () =>
          Effect.succeed({
            state: "unknown",
            failing: [],
            counts: { total: 0, passing: 0, failing: 0, pending: 0 },
            unknownReason: "unavailable",
            unknownDetail: "gh auth status exited 1",
          }),
      });
      const cards = [card({ id: cardId("a") })];
      yield* watch.refresh(cards);
      expect(watch.snapshot(cards)[0]).toMatchObject({
        state: "unknown",
        unknownReason: "unavailable",
        unknownDetail: "gh auth status exited 1",
      });
    }),
  );

  it.effect("restores the last persisted verdict before deciding whether to refetch", () =>
    Effect.gen(function* () {
      const persisted: KanbanPrChecks[] = [];
      const cards = [card({ id: cardId("a") })];
      const first = makePrChecksWatch({
        fetch: () => Effect.succeed(checks("passing")),
        save: (input) => Effect.sync(() => persisted.push(input.checks)),
      });
      yield* first.refresh(cards);

      let fetches = 0;
      const restored = makePrChecksWatch({
        fetch: () =>
          Effect.sync(() => {
            fetches += 1;
            return checks("failing");
          }),
        load: Effect.succeed(persisted),
        settledTtlMs: Number.MAX_SAFE_INTEGER,
      });
      yield* restored.refresh(cards);

      expect(fetches).toBe(0);
      expect(restored.snapshot(cards)[0]?.state).toBe("passing");
    }),
  );

  it.effect("does not re-read the forge while an entry is fresh", () =>
    Effect.gen(function* () {
      let calls = 0;
      const watch = makePrChecksWatch({
        fetch: () =>
          Effect.sync(() => {
            calls += 1;
            return checks("passing");
          }),
      });
      const cards = [card({ id: cardId("a") })];
      yield* watch.refresh(cards);
      yield* watch.refresh(cards);
      expect(calls).toBe(1);
    }),
  );

  it.effect("drops entries for cards that left the board", () =>
    Effect.gen(function* () {
      const watch = makePrChecksWatch({ fetch: () => Effect.succeed(checks("passing")) });
      yield* watch.refresh([card({ id: cardId("a") })]);
      expect(watch.snapshot([card({ id: cardId("a"), at: "done" })])).toEqual([]);
    }),
  );

  it.effect("settles a PR card when the forge reports it merged", () =>
    Effect.gen(function* () {
      const merged: KanbanCardId[] = [];
      const watch = makePrChecksWatch({
        fetch: () =>
          Effect.succeed({ ...checks("passing"), changeRequestState: "merged" as const }),
        onMerged: (current) => Effect.sync(() => merged.push(current.id)),
      });

      yield* watch.refresh([card({ id: cardId("merged") })]);
      expect(merged).toEqual([cardId("merged")]);
    }),
  );

  it.effect("does not settle an open or non-PR card", () =>
    Effect.gen(function* () {
      const merged: KanbanCardId[] = [];
      const watch = makePrChecksWatch({
        fetch: () => Effect.succeed({ ...checks("passing"), changeRequestState: "open" as const }),
        onMerged: (current) => Effect.sync(() => merged.push(current.id)),
      });

      yield* watch.refresh([
        card({ id: cardId("open") }),
        card({ id: cardId("active"), at: "active" }),
      ]);
      expect(merged).toEqual([]);
    }),
  );
});
