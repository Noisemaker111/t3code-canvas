import type { EnvironmentId, KanbanCard } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { reconcileKanbanBoard, type KanbanBoardSnapshot } from "./kanban";

const ENV = "env-1" as EnvironmentId;
const CARD = { id: "card-1", title: "One", column: "prompts" } as unknown as KanbanCard;

const LOADED: KanbanBoardSnapshot = {
  environmentId: ENV,
  cards: [CARD],
  prChecks: [],
  hermes: null,
};

describe("reconcileKanbanBoard", () => {
  it("holds the last board while the same environment refetches", () => {
    expect(reconcileKanbanBoard(LOADED, ENV, null)).toBe(LOADED);
  });

  it("takes a successful empty board over the stale one", () => {
    expect(reconcileKanbanBoard(LOADED, ENV, { cards: [] }).cards).toEqual([]);
  });

  it("drops the board when the environment changes", () => {
    const next = reconcileKanbanBoard(LOADED, "env-2" as EnvironmentId, null);
    expect(next.cards).toEqual([]);
    expect(next.environmentId).toBe("env-2");
  });

  it("carries pr checks and Hermes through with the cards", () => {
    const next = reconcileKanbanBoard(LOADED, ENV, {
      cards: [CARD],
      prChecks: [{ cardId: "card-1" } as never],
      hermes: { enabled: true } as never,
    });
    expect(next.prChecks).toHaveLength(1);
    expect(next.hermes).toEqual({ enabled: true });
  });
});
