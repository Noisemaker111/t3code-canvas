import { beforeEach, describe, expect, it } from "@effect/vitest";

import type { BoardOpenIssue } from "./boardApi.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { MAX_ISSUES_FILED_PER_SWEEP, resetIssueWatch, sweepWatchedIssues } from "./issueWatch.ts";

const openIssue = (
  number: number,
  title: string,
  labels: ReadonlyArray<string> = [],
): BoardOpenIssue => ({
  number,
  title,
  url: `https://github.com/own/vps-code/issues/${number}`,
  labels,
});

const board = (
  cards: ReturnType<typeof makeFakeCard>[] = [],
  issues: ReadonlyArray<BoardOpenIssue> = [
    openIssue(21, "Composer eats the first keystroke", ["bug"]),
    openIssue(34, "Board settings: stall timers", ["hermes"]),
  ],
) =>
  makeFakeBoardApi({
    cards,
    projects: [
      { id: "proj-1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: "own/vps-code" },
    ],
    openIssues: { "proj-1": issues },
  });

describe("sweepWatchedIssues", () => {
  beforeEach(() => resetIssueWatch());

  it("files one Prompts card per open issue no card owns", async () => {
    const { api, state } = board();

    const filed = await sweepWatchedIssues({ api, cards: state.cards, label: "", nowMs: 1_000 });

    expect(filed.map((entry) => entry.title)).toEqual([
      "Issue #21: Composer eats the first keystroke",
      "Issue #34: Board settings: stall timers",
    ]);
    expect(state.cards.at(-1)?.projectId).toBe("proj-1");
    expect(state.cards.at(-1)?.at).toBe("prompts");
  });

  it("only files issues wearing the configured label", async () => {
    const { api, state } = board();

    const filed = await sweepWatchedIssues({
      api,
      cards: state.cards,
      label: "Hermes",
      nowMs: 1_000,
    });

    expect(filed.map((entry) => entry.title)).toEqual(["Issue #34: Board settings: stall timers"]);
  });

  it("does not file the same issue twice, by title or by URL in a card body", async () => {
    const { api, state } = board([
      makeFakeCard({ id: "card-1", title: "Issue #21: Composer eats the first keystroke" }),
      makeFakeCard({
        id: "card-2",
        title: "#34 dragged off the panel",
        body: "https://github.com/own/vps-code/issues/34",
      }),
    ]);

    const filed = await sweepWatchedIssues({ api, cards: state.cards, label: "", nowMs: 1_000 });

    expect(filed).toHaveLength(0);
    expect(state.cards).toHaveLength(2);
  });

  it("caps a sweep and names what it held back", async () => {
    const { api, state } = board(
      [],
      Array.from({ length: 5 }, (_, index) => openIssue(index + 1, `issue ${index + 1}`)),
    );

    const filed = await sweepWatchedIssues({ api, cards: state.cards, label: "", nowMs: 1_000 });

    expect(filed).toHaveLength(MAX_ISSUES_FILED_PER_SWEEP + 1);
    expect(filed.at(-1)?.log).toContain("wait for the next sweep");
    expect(state.cards).toHaveLength(MAX_ISSUES_FILED_PER_SWEEP);
  });

  it("throttles: a second sweep inside the window asks nothing", async () => {
    const { api, state } = board();
    await sweepWatchedIssues({ api, cards: state.cards, label: "", nowMs: 1_000 });
    const again = await sweepWatchedIssues({ api, cards: state.cards, label: "", nowMs: 2_000 });
    expect(again).toHaveLength(0);
  });

  it("records nothing on recordOnly", async () => {
    const { api, state } = board();
    const filed = await sweepWatchedIssues({
      api,
      cards: state.cards,
      label: "",
      recordOnly: true,
      nowMs: 1_000,
    });
    expect(filed).toHaveLength(2);
    expect(state.cards).toHaveLength(0);
  });
});
