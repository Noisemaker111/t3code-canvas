import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_BOARD_SETTINGS } from "@t3tools/contracts";

import { cardSimilarity, findDuplicateCards, findOverlappingCards } from "./dedup.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { collectSnapshot } from "./HermesBrain.ts";
import { judgmentQueue } from "./judgment.ts";
import type { HermesSnapshot } from "./prompt.ts";
import { runRulePass } from "./rulePass.ts";

const settings = { ...DEFAULT_BOARD_SETTINGS };

const snapshot = (cards: HermesSnapshot["cards"]): HermesSnapshot => ({
  cards,
  projects: [],
  models: [],
  pendingInputs: [],
  policy: {},
  reports: [],
  threads: [],
});

describe("cardSimilarity", () => {
  it("scores the same ask high and unrelated asks low", () => {
    const left = { title: "Add STT transcript export", body: "Export the transcript to markdown" };
    const right = { title: "add stt transcript export", body: "export transcript into markdown" };
    expect(cardSimilarity(left, right)).toBeGreaterThan(0.62);
    expect(
      cardSimilarity(left, { title: "Bump the tldraw version", body: "canvas deps" }),
    ).toBeLessThan(0.2);
  });
});

describe("findDuplicateCards", () => {
  it("finds the open card that already says it", () => {
    const card = makeFakeCard({
      id: "card-2",
      title: "Reduce Hermes tick cost",
      body: "Cut the snapshot the tick sends so a heartbeat costs fewer tokens",
    });
    const matches = findDuplicateCards({
      card,
      cards: [
        makeFakeCard({
          id: "card-1",
          title: "Reduce Hermes tick cost",
          body: "Cut the snapshot the tick sends so a heartbeat costs fewer tokens",
        }),
        makeFakeCard({ id: "card-3", title: "Fix the canvas inbox", body: "pictures never ack" }),
        card,
      ],
    });
    expect(matches.map((match) => match.cardId)).toEqual(["card-1"]);
  });

  it("ignores an archived card and an old Done card", () => {
    const card = makeFakeCard({ id: "card-2", title: "Same work", body: "same body text here" });
    const matches = findDuplicateCards({
      card,
      cards: [
        makeFakeCard({
          id: "card-1",
          title: "Same work",
          body: "same body text here",
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
        makeFakeCard({
          id: "card-3",
          title: "Same work",
          body: "same body text here",
          at: "done",
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
        card,
      ],
      nowMs: Date.parse("2026-06-01T00:00:00.000Z"),
    });
    expect(matches).toHaveLength(0);
  });
});

describe("judgment queue", () => {
  it("tells the structure item what the new card duplicates", () => {
    const cards = [
      makeFakeCard({
        id: "card-1",
        title: "Add a Draft column",
        body: "Add a Draft column to the kanban board and route new cards into it",
        at: "active",
        threadId: "thread-1",
        projectId: "proj-1",
      }),
      makeFakeCard({
        id: "card-2",
        title: "Add a Draft column",
        body: "Add a Draft column to the kanban board and route new cards into it",
      }),
    ];
    const queue = judgmentQueue({ snapshot: snapshot(cards), settings });
    const structure = queue.find((item) => item.cardId === "card-2");
    expect(structure?.why).toContain("duplicate of card-1");
    expect(structure?.why).toContain("overlaps card-1");
  });
});

describe("overlap hold", () => {
  it("keeps a ready Prompt out of Active while the same area is running", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "card-1",
          title: "Remove the Draft column",
          body: "Remove the Draft column from the kanban board and move its cards to Prompts",
          at: "active",
          threadId: "thread-1",
          projectId: "proj-1",
        }),
        makeFakeCard({
          id: "card-2",
          title: "Restore the Draft column",
          body: "Restore the Draft column on the kanban board and move its cards from Prompts",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
        }),
      ],
    });

    const result = await runRulePass({ api, settings });

    expect(state.cards[1]?.at).toBe("prompts");
    expect(result.holds).toEqual([]);
    const queue = judgmentQueue({ snapshot: await collectSnapshot(api, settings), settings });
    expect(queue.find((item) => item.cardId === "card-2")?.why).toContain("overlaps card-1");
  });
});
