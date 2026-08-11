import type { KanbanCard } from "@t3tools/contracts";

import { recordDegradation } from "../../health/incidentLog.ts";
import type { BoardApi, BoardOpenPr } from "./boardApi.ts";

export const PR_WATCH_INTERVAL_MS = 15 * 60 * 1000;
const PR_LIMIT = 50;

let lastSweepMs = 0;

export function resetPrWatch(): void {
  lastSweepMs = 0;
}

function canonicalPrUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function filedCard(cards: ReadonlyArray<KanbanCard>, pr: BoardOpenPr): KanbanCard | undefined {
  const url = canonicalPrUrl(pr.url);
  return cards.find(
    (card) =>
      !card.archivedAt &&
      ((card.prUrl !== null && canonicalPrUrl(card.prUrl) === url) || card.body.includes(pr.url)),
  );
}

function hasPrIdentity(card: KanbanCard, pr: BoardOpenPr): boolean {
  return (
    card.prUrl !== null &&
    canonicalPrUrl(card.prUrl) === canonicalPrUrl(pr.url) &&
    card.prNumber === pr.number &&
    card.prTitle === pr.title
  );
}

function body(pr: BoardOpenPr, repo: string): string {
  return [
    "Open pull request",
    `${repo}#${pr.number}: ${pr.url}`,
    "",
    `Head: ${pr.headRefName}`,
    `Base: ${pr.baseRefName}`,
  ].join("\n");
}

export type PrSweepEntry = {
  readonly cardId: string;
  readonly log: string;
  readonly ok: boolean;
};

export async function reconcileOpenPrs(
  api: BoardApi,
  nowMs: number,
): Promise<ReadonlyArray<PrSweepEntry>> {
  return sweepOrphanPrs({ api, cards: await api.list(), nowMs });
}

export async function sweepOrphanPrs(input: {
  readonly api: BoardApi;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly recordOnly?: boolean;
  readonly nowMs: number;
  readonly intervalMs?: number;
}): Promise<ReadonlyArray<PrSweepEntry>> {
  const intervalMs = input.intervalMs ?? PR_WATCH_INTERVAL_MS;
  if (lastSweepMs !== 0 && input.nowMs - lastSweepMs < intervalMs) return [];

  const projects = await input.api.listProjects();
  const entries: Array<PrSweepEntry> = [];
  const claimedUrls = new Set<string>();
  let complete = true;

  for (const project of projects) {
    if (!project.repo) continue;
    const prs = await input.api
      .listOpenPrs({ projectId: project.id, limit: PR_LIMIT })
      .catch((cause: unknown) => {
        complete = false;
        recordDegradation({
          id: "kanban.orphan-pr-watch",
          title: "Orphan PR watch could not read the forge",
          detail: `${project.repo}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return null;
      });
    if (prs === null) continue;

    for (const pr of prs) {
      if (pr.state !== undefined && pr.state !== "open") continue;
      const url = canonicalPrUrl(pr.url);
      if (claimedUrls.has(url)) continue;
      claimedUrls.add(url);
      const existing = filedCard(input.cards, pr);
      if (existing && hasPrIdentity(existing, pr)) continue;
      if (input.recordOnly === true) {
        entries.push({
          cardId: existing?.id ?? pr.url,
          log: `would ${existing ? "repair" : "adopt"} ${project.repo}#${pr.number}`,
          ok: true,
        });
        continue;
      }
      try {
        if (existing) {
          await input.api.updateCard({
            id: existing.id,
            prUrl: pr.url,
            prTitle: pr.title,
            prNumber: pr.number,
            movedBy: "orphan-pr",
          });
          entries.push({
            cardId: existing.id,
            log: `repaired ${project.repo}#${pr.number}`,
            ok: true,
          });
          continue;
        }
        const card = await input.api.createCard({
          title: pr.title,
          body: body(pr, project.repo),
          at: "pr",
          projectId: project.id,
          baseBranch: pr.baseRefName,
        });
        await input.api.updateCard({
          id: card.id as string,
          prUrl: pr.url,
          prTitle: pr.title,
          prNumber: pr.number,
          movedBy: "orphan-pr",
        });
        entries.push({
          cardId: card.id as string,
          log: `adopted ${project.repo}#${pr.number}`,
          ok: true,
        });
      } catch (cause) {
        complete = false;
        entries.push({
          cardId: pr.url,
          log: `could not adopt ${project.repo}#${pr.number}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ok: false,
        });
      }
    }
  }

  if (complete) lastSweepMs = input.nowMs;
  return entries;
}
