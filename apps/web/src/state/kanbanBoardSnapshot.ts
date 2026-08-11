import type { HermesBoardStatus, KanbanCard, KanbanPrChecks } from "@t3tools/contracts";

import type { KanbanBoardSnapshot } from "./kanban";

/**
 * Board-tile identity: fields that change what the column paints.
 * Timestamps (`updatedAt` / `createdAt`) are deliberately omitted — list polls
 * often bump them without any visible change, and new object refs alone were
 * enough to flash the whole board.
 */
export function cardRenderKey(card: KanbanCard): string {
  const model = card.modelSelection;
  const op = card.hermesOperation;
  return [
    card.id,
    card.title,
    card.body,
    card.at,
    String(card.position),
    card.threadId ?? "",
    card.prUrl ?? "",
    card.prTitle ?? "",
    card.prNumber === null ? "" : String(card.prNumber),
    card.projectId ?? "",
    card.baseBranch ?? "",
    card.prepStatus ?? "",
    model ? `${model.instanceId}\0${model.model}` : "",
    op
      ? `${op.id}\0${op.method}\0${op.status}\0${op.attempt}\0${op.detail}\0${op.error ?? ""}`
      : "",
  ].join("\0");
}

function prChecksKey(entry: KanbanPrChecks): string {
  return [
    entry.cardId,
    entry.state,
    String(entry.total),
    String(entry.passing),
    String(entry.failing),
    String(entry.pending),
    entry.failingNames.join(","),
    entry.failingUrl ?? "",
  ].join("\0");
}

/**
 * Hermes fields the board columns / queue badges care about. Heartbeats,
 * skip reasons, and tick summaries change every poll and must not invalidate
 * card trees — the header chip reads the live status separately.
 */
export function hermesBoardKey(hermes: HermesBoardStatus | null): string {
  if (!hermes) return "";
  const activity = hermes.cardActivity
    .map((entry) => `${entry.cardId}\0${entry.action}\0${entry.ok}\0${entry.at}`)
    .join("\n");
  const watch = hermes.cardWatch
    .map(
      (entry) =>
        `${entry.cardId}\0${entry.reviews}\0${entry.stalled}\0${entry.sinceAt}\0${entry.why}`,
    )
    .join("\n");
  return [
    hermes.enabled,
    hermes.running,
    hermes.busy,
    hermes.intervalMs,
    hermes.nextTickAt ?? "",
    hermes.nextModelCheckAt ?? "",
    hermes.pipelineIdle,
    hermes.consecutiveFailures,
    hermes.lastError ?? "",
    activity,
    watch,
  ].join("\0");
}

function stabilizeCards(
  previous: ReadonlyArray<KanbanCard>,
  next: ReadonlyArray<KanbanCard>,
): ReadonlyArray<KanbanCard> {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  let changed = false;
  const out = next.map((card, index) => {
    const prior = previous[index];
    if (prior && cardRenderKey(prior) === cardRenderKey(card)) {
      return prior;
    }
    changed = true;
    return card;
  });
  return changed ? out : previous;
}

function stabilizePrChecks(
  previous: ReadonlyArray<KanbanPrChecks>,
  next: ReadonlyArray<KanbanPrChecks>,
): ReadonlyArray<KanbanPrChecks> {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  let changed = false;
  const out = next.map((entry, index) => {
    const prior = previous[index];
    if (prior && prChecksKey(prior) === prChecksKey(entry)) {
      return prior;
    }
    changed = true;
    return entry;
  });
  return changed ? out : previous;
}

function stabilizeHermes(
  previous: HermesBoardStatus | null,
  next: HermesBoardStatus | null,
): HermesBoardStatus | null {
  if (previous === next) return previous;
  if (hermesBoardKey(previous) === hermesBoardKey(next)) return previous;
  return next;
}

/**
 * Reuse prior board refs when a poll returns equivalent render data.
 * Callers keep a live Hermes status for the header chip separately.
 */
export function stabilizeKanbanBoardSnapshot(
  previous: KanbanBoardSnapshot,
  next: KanbanBoardSnapshot,
): KanbanBoardSnapshot {
  if (previous === next) return previous;
  if (previous.environmentId !== next.environmentId) return next;

  const cards = stabilizeCards(previous.cards, next.cards);
  const prChecks = stabilizePrChecks(previous.prChecks, next.prChecks);
  const hermes = stabilizeHermes(previous.hermes, next.hermes);

  if (cards === previous.cards && prChecks === previous.prChecks && hermes === previous.hermes) {
    return previous;
  }
  if (cards === next.cards && prChecks === next.prChecks && hermes === next.hermes) {
    return next;
  }
  return { environmentId: next.environmentId, cards, prChecks, hermes };
}
