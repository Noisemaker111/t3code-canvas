import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_BOARD_CONVENTIONS, explainMoveBlock } from "./moveGate.ts";
import type { KanbanCard } from "@t3tools/contracts";

function card(partial: Partial<KanbanCard> & Pick<KanbanCard, "id" | "at">): KanbanCard {
  // createdAt/updatedAt are DateTimeUtc; tests only exercise move rules.
  const now = "2026-01-01T00:00:00.000Z" as unknown as KanbanCard["createdAt"];
  return {
    id: partial.id as KanbanCard["id"],
    title: partial.title ?? "Title",
    body: partial.body ?? "Body",
    at: partial.at,
    position: partial.position ?? 1,
    threadId: partial.threadId ?? null,
    prUrl: partial.prUrl ?? null,
    prTitle: partial.prTitle ?? null,
    prNumber: partial.prNumber ?? null,
    prepStatus: partial.prepStatus ?? "untouched",
    hermesOperation: partial.hermesOperation ?? null,
    lastRuleMove: partial.lastRuleMove ?? null,
    projectId: partial.projectId ?? null,
    projectRouteProvenance: partial.projectRouteProvenance ?? null,
    modelSelection: partial.modelSelection ?? null,
    modelRouteReason: partial.modelRouteReason ?? null,
    modelRouteProvenance: partial.modelRouteProvenance ?? null,
    modelRouteUsage: partial.modelRouteUsage ?? null,
    baseBranch: partial.baseBranch ?? null,
    attachments: partial.attachments ?? [],
    archivedAt: partial.archivedAt ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    columnEnteredAt: partial.columnEnteredAt ?? now,
    timeline: partial.timeline ?? { launchedAt: null, prOpenedAt: null, shippedAt: null },
    tokenUsage: partial.tokenUsage ?? null,
  };
}

const id = "1" as KanbanCard["id"];

describe("explainMoveBlock", () => {
  it("refuses a move onto the column the card is already in", () => {
    const c = card({ id, at: "active", threadId: "t1" });
    expect(explainMoveBlock(c, "active", DEFAULT_BOARD_CONVENTIONS)).toMatch(/already/i);
  });

  describe("Active", () => {
    it("blocks a prompt with no project", () => {
      const c = card({ id, at: "prompts", prepStatus: "untouched" });
      expect(explainMoveBlock(c, "active")).toMatch(/project/i);
    });

    // The pickers on the card are the human half of routing: a card carrying a
    // project is one somebody already told where to run.
    it("allows a prompt routed by hand", () => {
      const c = card({
        id,
        at: "prompts",
        prepStatus: "untouched",
        projectId: "p1" as KanbanCard["projectId"],
      });
      expect(explainMoveBlock(c, "active")).toBeNull();
    });

    it("allows a routed prompt", () => {
      const c = card({ id, at: "prompts", prepStatus: "ready" });
      expect(explainMoveBlock(c, "active")).toBeNull();
    });

    it("allows a prompt Hermes is mid-structure on", () => {
      const c = card({ id, at: "prompts", prepStatus: "processing" });
      expect(explainMoveBlock(c, "active")).toBeNull();
    });

    // pr-checks-red and pr-conflicts send a card back to the thread that wrote
    // the code. The lane-order gate this replaced refused both.
    it("allows a card coming back from PR with its thread", () => {
      const c = card({
        id,
        at: "pr",
        prepStatus: "untouched",
        threadId: "t1",
        prUrl: "https://example.test/pr/1",
      });
      expect(explainMoveBlock(c, "active")).toBeNull();
    });
  });

  describe("PR", () => {
    it("blocks a card with nothing to push and nothing to adopt", () => {
      const c = card({ id, at: "active", prepStatus: "ready", threadId: null });
      expect(explainMoveBlock(c, "pr")).toMatch(/thread|pull request/i);
    });

    it("allows a card with a thread to push", () => {
      const c = card({ id, at: "active", prepStatus: "ready", threadId: "t1" });
      expect(explainMoveBlock(c, "pr")).toBeNull();
    });

    // Dragged off a review panel: there is nothing to push, the column adopts it.
    it("allows a card carrying a pull request and no thread", () => {
      const c = card({
        id,
        at: "prompts",
        threadId: null,
        prUrl: "https://example.test/pr/1",
      });
      expect(explainMoveBlock(c, "pr")).toBeNull();
    });

    it("blocks every card when a review is required", () => {
      const c = card({ id, at: "active", threadId: "t1" });
      expect(
        explainMoveBlock(c, "pr", { ...DEFAULT_BOARD_CONVENTIONS, requireReviewBeforePr: true }),
      ).toMatch(/review/i);
    });
  });

  describe("columns with no conventions of their own", () => {
    it("takes any card", () => {
      const c = card({ id, at: "active", threadId: "t1" });
      expect(explainMoveBlock(c, "prompts")).toBeNull();
      expect(explainMoveBlock(c, "research")).toBeNull();
    });
  });
});
