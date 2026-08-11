/**
 * The review list's pure half: what a row is, and which rows a filter keeps.
 *
 * The panel's address still names the repos it reads — `prs:owner/name` is a
 * query the forge answers — and everything here narrows what came back without
 * asking again. So the filter is a view over one fetch, never a second one.
 *
 * @module components/canvas/panels/PrReviewPanel.logic
 */
import type { KanbanCiChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PrRef } from "../refDrops";

/** One row: the drag payload, the forge verdict, and the card that owns it. */
export type PrReviewRow = PrRef & {
  readonly checks: KanbanCiChecks;
  readonly updatedAt: DateTime.Utc | null;
  /** The board card filed for this pull request, or null when nothing owns it. */
  readonly cardId: string | null;
};

export type PrCiFilter = "any" | "passing" | "failing" | "pending" | "unknown";
/** Whether the board has a card for the pull request. */
export type PrCardFilter = "any" | "carded" | "orphan";
export type PrSortKey = "recent" | "oldest" | "repo" | "ci";

export interface PrListFilter {
  /** Matched against title, repo, both branch names and the number. */
  readonly text: string;
  /** Repos to keep. Empty is every repo the fetch came back with. */
  readonly repos: ReadonlyArray<string>;
  readonly ci: PrCiFilter;
  readonly card: PrCardFilter;
  readonly sort: PrSortKey;
}

export const DEFAULT_PR_FILTER: PrListFilter = {
  text: "",
  repos: [],
  ci: "any",
  card: "any",
  sort: "recent",
};

export const PR_SORT_LABEL: Record<PrSortKey, string> = {
  recent: "Recently updated",
  oldest: "Least recently updated",
  repo: "Repo",
  ci: "CI first",
};

export const PR_CI_LABEL: Record<PrCiFilter, string> = {
  any: "Any CI",
  passing: "Passing",
  failing: "Failing",
  pending: "Running",
  unknown: "Unknown",
};

export const PR_CARD_LABEL: Record<PrCardFilter, string> = {
  any: "Any card",
  carded: "On the board",
  orphan: "Not on the board",
};

/** How many narrowing choices are on — the count on the filter button. */
export function activePrFilterCount(filter: PrListFilter): number {
  return (
    (filter.text.trim().length > 0 ? 1 : 0) +
    (filter.repos.length > 0 ? 1 : 0) +
    (filter.ci === "any" ? 0 : 1) +
    (filter.card === "any" ? 0 : 1)
  );
}

/** `owner/name,other/name` → the repos, in the order they were written. */
export function parseRepoBinding(entityId: string): ReadonlyArray<string> {
  return entityId
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo.length > 0);
}

export function repoBindingLabel(repos: ReadonlyArray<string>): string {
  if (repos.length === 0) return "Every repo on the board";
  return repos.join(" · ");
}

/** The repos the fetch came back with, sorted — what the repo filter offers. */
export function prRowRepos(rows: ReadonlyArray<PrReviewRow>): ReadonlyArray<string> {
  return [...new Set(rows.map((row) => row.repo))].sort((a, b) => a.localeCompare(b));
}

/**
 * The board's cards, keyed by every way a pull request names itself: its URL and
 * its `#number`. One ownership rule — the rows and the panel's summary dots both
 * read this, so they never disagree about what the board already has a card for.
 */
export function prCardIndex(
  cards: ReadonlyArray<{
    readonly id: string;
    readonly prUrl: string | null;
    readonly prNumber: number | null;
  }>,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const card of cards) {
    if (card.prUrl) index.set(card.prUrl, card.id);
    if (card.prNumber !== null) index.set(`#${card.prNumber}`, card.id);
  }
  return index;
}

export function cardIdForPr(
  index: ReadonlyMap<string, string>,
  pr: { readonly url: string; readonly number: number },
): string | null {
  return index.get(pr.url) ?? index.get(`#${pr.number}`) ?? null;
}

export function prMatchesText(row: PrReviewRow, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return true;
  const digits = needle.startsWith("#") ? needle.slice(1) : needle;
  if (/^\d+$/.test(digits) && String(row.number).includes(digits)) return true;
  return [row.title, row.repo, row.headRefName, row.baseRefName].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

function matchesCi(row: PrReviewRow, ci: PrCiFilter): boolean {
  return ci === "any" || row.checks.state === ci;
}

function matchesCard(row: PrReviewRow, card: PrCardFilter): boolean {
  if (card === "any") return true;
  return card === "carded" ? row.cardId !== null : row.cardId === null;
}

const CI_ORDER: Record<KanbanCiChecks["state"], number> = {
  failing: 0,
  pending: 1,
  unknown: 2,
  passing: 3,
};

function updatedMs(row: PrReviewRow): number | null {
  return row.updatedAt === null ? null : DateTime.toEpochMillis(row.updatedAt);
}

/** Newest first, and a row the forge gave no timestamp for sits at the bottom. */
function byRecent(a: PrReviewRow, b: PrReviewRow): number {
  const left = updatedMs(a);
  const right = updatedMs(b);
  if (left === right) return b.number - a.number;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function comparePrRows(sort: PrSortKey): (a: PrReviewRow, b: PrReviewRow) => number {
  if (sort === "oldest") {
    return (a, b) => {
      const left = updatedMs(a);
      const right = updatedMs(b);
      if (left === right) return a.number - b.number;
      // An undated row is still last: it is the one nothing is known about.
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    };
  }
  if (sort === "repo") {
    return (a, b) => a.repo.localeCompare(b.repo) || byRecent(a, b);
  }
  if (sort === "ci") {
    return (a, b) => CI_ORDER[a.checks.state] - CI_ORDER[b.checks.state] || byRecent(a, b);
  }
  return byRecent;
}

/** The rows a filter keeps, in the order it asks for. */
export function filterPrRows(
  rows: ReadonlyArray<PrReviewRow>,
  filter: PrListFilter,
): ReadonlyArray<PrReviewRow> {
  const repos = new Set(filter.repos);
  return rows
    .filter(
      (row) =>
        (repos.size === 0 || repos.has(row.repo)) &&
        matchesCi(row, filter.ci) &&
        matchesCard(row, filter.card) &&
        prMatchesText(row, filter.text),
    )
    .toSorted(comparePrRows(filter.sort));
}
