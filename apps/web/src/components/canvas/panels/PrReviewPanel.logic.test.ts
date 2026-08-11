import type { KanbanCiChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  activePrFilterCount,
  cardIdForPr,
  DEFAULT_PR_FILTER,
  filterPrRows,
  parseRepoBinding,
  prCardIndex,
  prRowRepos,
  repoBindingLabel,
  type PrReviewRow,
} from "./PrReviewPanel.logic";

const checkedAt = DateTime.makeUnsafe("2026-08-03T00:00:00Z");

function checks(state: KanbanCiChecks["state"]): KanbanCiChecks {
  return {
    state,
    total: 1,
    passing: state === "passing" ? 1 : 0,
    failing: state === "failing" ? 1 : 0,
    pending: state === "pending" ? 1 : 0,
    failingNames: [],
    failingUrl: null,
    unknownReason: null,
    unknownDetail: null,
    checkedAt,
  };
}

function row(input: {
  number: number;
  repo?: string;
  title?: string;
  head?: string;
  state?: KanbanCiChecks["state"];
  updatedAt?: string | null;
  cardId?: string | null;
}): PrReviewRow {
  const repo = input.repo ?? "Noisemaker111/vps-code";
  return {
    projectId: "p1",
    repo,
    number: input.number,
    title: input.title ?? `change ${input.number}`,
    url: `https://github.com/${repo}/pull/${input.number}`,
    headRefName: input.head ?? `feature/${input.number}`,
    baseRefName: "main",
    checks: checks(input.state ?? "passing"),
    updatedAt:
      input.updatedAt === undefined || input.updatedAt === null
        ? null
        : DateTime.makeUnsafe(input.updatedAt),
    cardId: input.cardId ?? null,
  };
}

const numbers = (rows: ReadonlyArray<PrReviewRow>) => rows.map((entry) => entry.number);

describe("parseRepoBinding", () => {
  it("reads a comma list and names an unbound panel", () => {
    expect(parseRepoBinding(" a/b , c/d ")).toEqual(["a/b", "c/d"]);
    expect(parseRepoBinding("")).toEqual([]);
    expect(repoBindingLabel([])).toBe("Every repo on the board");
    expect(repoBindingLabel(["a/b", "c/d"])).toBe("a/b · c/d");
  });
});

describe("prRowRepos", () => {
  it("offers each repo the fetch came back with, once, sorted", () => {
    expect(
      prRowRepos([
        row({ number: 1, repo: "b/two" }),
        row({ number: 2, repo: "a/one" }),
        row({ number: 3, repo: "b/two" }),
      ]),
    ).toEqual(["a/one", "b/two"]);
  });
});

describe("prCardIndex", () => {
  it("finds the card by pull request URL or by number", () => {
    const index = prCardIndex([
      { id: "card-url", prUrl: "https://github.com/o/r/pull/7", prNumber: null },
      { id: "card-number", prUrl: "", prNumber: 9 },
    ]);

    expect(cardIdForPr(index, { url: "https://github.com/o/r/pull/7", number: 7 })).toBe(
      "card-url",
    );
    expect(cardIdForPr(index, { url: "https://elsewhere/9", number: 9 })).toBe("card-number");
    expect(cardIdForPr(index, { url: "https://elsewhere/3", number: 3 })).toBeNull();
  });
});

describe("filterPrRows", () => {
  const rows = [
    row({ number: 1, repo: "a/one", state: "failing", updatedAt: "2026-08-01T00:00:00Z" }),
    row({
      number: 2,
      repo: "b/two",
      title: "Kanban filter bar",
      state: "passing",
      updatedAt: "2026-08-03T00:00:00Z",
      cardId: "card-2",
    }),
    row({ number: 3, repo: "b/two", head: "fix/pr-list", state: "pending", updatedAt: null }),
  ];

  it("keeps everything, newest first, with an undated row last", () => {
    expect(numbers(filterPrRows(rows, DEFAULT_PR_FILTER))).toEqual([2, 1, 3]);
  });

  it("keeps only the named repos", () => {
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, repos: ["b/two"] }))).toEqual([2, 3]);
  });

  it("matches title, branch, repo and number", () => {
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, text: "filter bar" }))).toEqual([2]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, text: "fix/pr-list" }))).toEqual([3]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, text: "a/one" }))).toEqual([1]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, text: "#3" }))).toEqual([3]);
  });

  it("splits the list by CI verdict and by what the board has a card for", () => {
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, ci: "failing" }))).toEqual([1]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, card: "carded" }))).toEqual([2]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, card: "orphan" }))).toEqual([1, 3]);
  });

  it("sorts red first, then repo, then age", () => {
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, sort: "ci" }))).toEqual([1, 3, 2]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, sort: "repo" }))).toEqual([1, 2, 3]);
    expect(numbers(filterPrRows(rows, { ...DEFAULT_PR_FILTER, sort: "oldest" }))).toEqual([
      1, 2, 3,
    ]);
  });

  it("counts only the narrowing choices that are on", () => {
    expect(activePrFilterCount(DEFAULT_PR_FILTER)).toBe(0);
    expect(activePrFilterCount({ ...DEFAULT_PR_FILTER, sort: "repo" })).toBe(0);
    expect(activePrFilterCount({ ...DEFAULT_PR_FILTER, text: " x ", ci: "failing" })).toBe(2);
  });
});
