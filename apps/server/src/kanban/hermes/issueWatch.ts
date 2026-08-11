/**
 * Open issues with no card behind them, filed onto the board.
 *
 * Opt-in: with `hermesWatchIssues` on, each
 * open issue nobody owns becomes one Prompts card — from there the column
 * rules do what they always do (structure, route, launch). A label filter
 * scopes the watch, so `hermes`-labelled issues flow in and the rest stay on
 * the forge.
 *
 * @module kanban/hermes/issueWatch
 */
import type { KanbanCard } from "@t3tools/contracts";

import { recordDegradation } from "../../health/incidentLog.ts";
import type { BoardApi, BoardOpenIssue, BoardProject } from "./boardApi.ts";

/** How often the forge is asked. Every heartbeat would be one `gh` call a tick. */
export const ISSUE_WATCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Cards one sweep may file. A backlog of a hundred open issues must not become
 * a board the owner has to empty by hand.
 */
export const MAX_ISSUES_FILED_PER_SWEEP = 3;

const ISSUE_LIMIT = 20;

let lastSweepMs = 0;

export function resetIssueWatch(): void {
  lastSweepMs = 0;
}

const ISSUE_TITLE_PREFIX = "Issue #";

export function issueCardTitle(issue: BoardOpenIssue): string {
  return `${ISSUE_TITLE_PREFIX}${issue.number}: ${issue.title}`;
}

/** The issue an Issue card was filed for, or null when it is not one. */
export function issueCardNumber(card: Pick<KanbanCard, "title">): number | null {
  const match = /^Issue #(\d+):/.exec(card.title);
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A card belongs to this project when it says so, or says nothing at all. */
function cardInProject(card: KanbanCard, projectId: string): boolean {
  return card.projectId === null || String(card.projectId) === projectId;
}

/**
 * Archived cards count. A filed issue the board already worked or dismissed is
 * handled — refiling it every fifteen minutes is the failure this prevents.
 * Cards dragged off the issue panel count too: their body carries the URL.
 */
function alreadyFiled(
  cards: ReadonlyArray<KanbanCard>,
  issue: BoardOpenIssue,
  projectId: string,
): boolean {
  return cards.some(
    (card) =>
      (issueCardNumber(card) === issue.number && cardInProject(card, projectId)) ||
      card.body.includes(issue.url),
  );
}

function body(issue: BoardOpenIssue, project: string): string {
  const labels = issue.labels.length === 0 ? "" : ` [${issue.labels.join(", ")}]`;
  return [
    "Mission",
    `Issue #${issue.number} is open on ${project}${labels}: ${issue.url}`,
    "",
    "Work to do",
    "- Read the issue and the code it names.",
    "- Fix it, or report why it cannot be fixed from here.",
    "",
    "Done when",
    `- The fix is on a branch with a PR whose body says \`Closes #${issue.number}\`, or the card reports the blocker.`,
  ].join("\n");
}

type SweepEntry = { readonly title: string; readonly log: string };

/**
 * File one Prompts card per unowned open issue. Deduped by issue number and
 * URL across live *and* archived cards, capped at `MAX_ISSUES_FILED_PER_SWEEP`,
 * throttled to `ISSUE_WATCH_INTERVAL_MS`, and scoped to `label` when set.
 */
export async function sweepWatchedIssues(input: {
  readonly api: BoardApi;
  readonly cards: ReadonlyArray<KanbanCard>;
  /** Only issues wearing this forge label. Empty is every open issue. */
  readonly label: string;
  readonly recordOnly?: boolean;
  /** Time comes from the caller — the rule pass already owns the tick's clock. */
  readonly nowMs: number;
  readonly intervalMs?: number;
}): Promise<ReadonlyArray<SweepEntry>> {
  const nowMs = input.nowMs;
  const intervalMs = input.intervalMs ?? ISSUE_WATCH_INTERVAL_MS;
  if (lastSweepMs !== 0 && nowMs - lastSweepMs < intervalMs) return [];

  const label = input.label.trim().toLowerCase();
  const projects: ReadonlyArray<BoardProject> = await input.api
    .listProjects()
    .catch((cause: unknown) => {
      recordDegradation({
        id: "hermes.issue-watch",
        title: "Issue watch could not list the board's projects",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    });
  const entries: Array<SweepEntry> = [];
  const filed = new Set<string>();
  const heldBack: Array<string> = [];
  let complete = true;

  for (const project of projects) {
    if (!project.repo) continue;
    // A forge we could not read is not "this repo has no issues": staying quiet
    // on that answer would hide a broken watch behind an empty board.
    const issues = await input.api
      .listOpenIssues({ projectId: project.id, limit: ISSUE_LIMIT })
      .catch((cause: unknown) => {
        complete = false;
        recordDegradation({
          id: "hermes.issue-watch",
          title: "Issue watch could not read the forge",
          detail:
            `${project.repo}: ${cause instanceof Error ? cause.message : String(cause)} — ` +
            "open issues are going unfiled",
        });
        return null;
      });
    if (issues === null) continue;

    for (const issue of issues) {
      if (label.length > 0 && !issue.labels.some((name) => name.toLowerCase() === label)) continue;
      const key = `${project.id}#${issue.number}`;
      if (filed.has(key)) continue;
      if (alreadyFiled(input.cards, issue, project.id)) continue;
      if (filed.size >= MAX_ISSUES_FILED_PER_SWEEP) {
        heldBack.push(`#${issue.number} on ${project.repo}`);
        continue;
      }
      filed.add(key);
      const title = issueCardTitle(issue);
      entries.push({
        title,
        log: `watched issue #${issue.number} on ${project.repo} — filed "${title}"`,
      });
      if (input.recordOnly === true) continue;
      await input.api
        .createCard({
          title,
          body: body(issue, project.repo),
          at: "prompts",
          projectId: project.id,
        })
        .catch(() => undefined);
    }
  }
  if (heldBack.length > 0) {
    entries.push({
      title: `watched issues held back (${heldBack.length})`,
      log: `${heldBack.length} more open issues wait for the next sweep (${MAX_ISSUES_FILED_PER_SWEEP} per sweep): ${heldBack.join(", ")}`,
    });
  }
  // Only a sweep that read every forge earns the window; otherwise a broken
  // forge buys itself silence until the next beat.
  if (complete) lastSweepMs = nowMs;
  return entries;
}
