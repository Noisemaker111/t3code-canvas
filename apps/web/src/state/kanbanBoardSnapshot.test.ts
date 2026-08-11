import type { HermesBoardStatus, KanbanCard, KanbanPrChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { cardRenderKey, hermesBoardKey, stabilizeKanbanBoardSnapshot } from "./kanbanBoardSnapshot";
import type { KanbanBoardSnapshot } from "./kanban";

function card(overrides: Partial<KanbanCard> & Pick<KanbanCard, "id">): KanbanCard {
  return {
    title: "Title",
    body: "Body",
    column: "prompts",
    position: 1,
    threadId: null,
    prUrl: null,
    projectId: null,
    modelSelection: null,
    baseBranch: null,
    prepStatus: "untouched",
    attachments: [],
    hermesOperation: null,
    createdAt: DateTime.makeUnsafe("2026-07-30T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-07-30T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  } as KanbanCard;
}

function hermes(overrides: Partial<HermesBoardStatus> = {}): HermesBoardStatus {
  return {
    enabled: false,
    running: false,
    busy: false,
    intervalMs: 5_000,
    model: "composer",
    lastHeartbeatAt: null,
    lastModelAt: null,
    lastSkipReason: null,
    lastSkipIsBoxBlock: false,
    lastBeatAt: null,
    lastSummary: null,
    lastTier: null,
    nextTickAt: null,
    lastError: null,
    providerError: null,
    consecutiveFailures: 0,
    pipelineIdle: false,
    cardActivity: [],
    cardWatch: [],
    nextModelCheckAt: null,
    ...overrides,
  };
}

const ENV = "env-1" as KanbanBoardSnapshot["environmentId"];

function snapshot(overrides: Partial<KanbanBoardSnapshot> = {}): KanbanBoardSnapshot {
  return {
    environmentId: ENV,
    cards: [card({ id: "c1" as KanbanCard["id"] })],
    prChecks: [],
    hermes: hermes(),
    ...overrides,
  };
}

describe("cardRenderKey", () => {
  it("ignores updatedAt so identical list polls share identity", () => {
    const a = card({
      id: "c1" as KanbanCard["id"],
      updatedAt: DateTime.makeUnsafe("2026-07-30T00:00:00.000Z"),
    });
    const b = card({
      id: "c1" as KanbanCard["id"],
      updatedAt: DateTime.makeUnsafe("2026-07-30T00:00:05.000Z"),
    });
    expect(cardRenderKey(a)).toBe(cardRenderKey(b));
  });

  it("changes when visible tile fields change", () => {
    const a = card({ id: "c1" as KanbanCard["id"], title: "A" });
    const b = card({ id: "c1" as KanbanCard["id"], title: "B" });
    expect(cardRenderKey(a)).not.toBe(cardRenderKey(b));
  });
});

describe("hermesBoardKey", () => {
  it("ignores heartbeat / summary churn", () => {
    const a = hermes({ lastHeartbeatAt: "t1", lastSummary: "old" });
    const b = hermes({ lastHeartbeatAt: "t2", lastSummary: "new" });
    expect(hermesBoardKey(a)).toBe(hermesBoardKey(b));
  });

  it("changes when queue-relevant fields change", () => {
    const a = hermes({ enabled: false });
    const b = hermes({ enabled: true });
    expect(hermesBoardKey(a)).not.toBe(hermesBoardKey(b));
  });
});

describe("stabilizeKanbanBoardSnapshot", () => {
  it("returns the previous snapshot when render data is unchanged", () => {
    const previous = snapshot();
    const next = snapshot({
      cards: [
        card({
          id: "c1" as KanbanCard["id"],
          updatedAt: DateTime.makeUnsafe("2026-07-30T00:00:09.000Z"),
        }),
      ],
      hermes: hermes({ lastHeartbeatAt: "later", lastSummary: "tick" }),
    });
    expect(stabilizeKanbanBoardSnapshot(previous, next)).toBe(previous);
  });

  it("adopts new card refs when a visible field changes", () => {
    const previous = snapshot();
    const nextCard = card({ id: "c1" as KanbanCard["id"], title: "Moved" });
    const next = snapshot({ cards: [nextCard] });
    const stabilized = stabilizeKanbanBoardSnapshot(previous, next);
    expect(stabilized).not.toBe(previous);
    expect(stabilized.cards[0]).toBe(nextCard);
  });

  it("preserves prior card refs that did not change inside a mixed poll", () => {
    const c1 = card({ id: "c1" as KanbanCard["id"] });
    const c2 = card({ id: "c2" as KanbanCard["id"], title: "Two" });
    const previous = snapshot({ cards: [c1, c2] });
    const nextC2 = card({ id: "c2" as KanbanCard["id"], title: "Two*" });
    const next = snapshot({
      cards: [
        card({
          id: "c1" as KanbanCard["id"],
          updatedAt: DateTime.makeUnsafe("2026-07-30T01:00:00.000Z"),
        }),
        nextC2,
      ],
    });
    const stabilized = stabilizeKanbanBoardSnapshot(previous, next);
    expect(stabilized.cards[0]).toBe(c1);
    expect(stabilized.cards[1]).toBe(nextC2);
  });

  it("passes pr check identity through when verdicts are unchanged", () => {
    const checks = [
      {
        cardId: "c1",
        state: "passing",
        total: 1,
        passing: 1,
        failing: 0,
        pending: 0,
        failingNames: [],
        failingUrl: null,
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ] as unknown as ReadonlyArray<KanbanPrChecks>;
    const previous = snapshot({ prChecks: checks });
    const next = snapshot({
      prChecks: checks.map((entry) => ({ ...entry })) as ReadonlyArray<KanbanPrChecks>,
    });
    expect(stabilizeKanbanBoardSnapshot(previous, next)).toBe(previous);
  });
});
