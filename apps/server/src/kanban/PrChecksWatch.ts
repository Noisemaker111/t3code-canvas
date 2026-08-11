/**
 * CI status for the cards that have a PR, cached so the board can render it.
 *
 * `gh pr view` is a process spawn per card, so the board never fetches inline
 * with a list call: it serves the last verdict it has and refreshes stale
 * entries in the background. A card with no entry yet is represented as
 * unknown by the board UI rather than rendered as a silent blank.
 *
 * @module kanban/PrChecksWatch
 */
import type {
  KanbanCard,
  KanbanCiChecks,
  KanbanErrorType,
  KanbanPrChecks,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ChangeRequestChecks } from "../sourceControl/SourceControlProvider.ts";

/** Where a PR can still gain or lose checks. Archived is settled. */
const WATCHED = new Set<KanbanCard["at"]>(["active", "pr"]);

/** Running checks change minute to minute; a settled verdict rarely does. */
const PENDING_TTL_MS = 15_000;
const SETTLED_TTL_MS = 60_000;

export interface PrChecksWatchOptions<E = never> {
  /** Reads the forge. Must not fail — an unreadable PR is `unknown`. */
  readonly fetch: (card: KanbanCard) => Effect.Effect<ChangeRequestChecks>;
  /** Restores the last durable verdict after a server restart. */
  readonly load?: Effect.Effect<ReadonlyArray<KanbanPrChecks>, E>;
  /** Persists a fresh verdict before it becomes visible. */
  readonly save?: (input: {
    readonly cardId: KanbanCard["id"];
    readonly prUrl: string;
    readonly checks: KanbanPrChecks;
  }) => Effect.Effect<void, E>;
  /** Settles a PR card when the forge reports that its pull request merged. */
  readonly onMerged?: (card: KanbanCard) => Effect.Effect<void, E>;
  readonly pendingTtlMs?: number;
  readonly settledTtlMs?: number;
  /** Forge calls in flight at once across the whole board. */
  readonly concurrency?: number;
}

export interface PrChecksWatch<E = never> {
  /** What the board knows right now. Never blocks on the forge. */
  readonly snapshot: (cards: ReadonlyArray<KanbanCard>) => ReadonlyArray<KanbanPrChecks>;
  /** Fetches every stale watched card, then updates the cache. */
  readonly refresh: (cards: ReadonlyArray<KanbanCard>) => Effect.Effect<void, E>;
}

/** A card the watch may fetch, paired with the PR URL that made it watchable. */
export interface WatchedCard {
  readonly card: KanbanCard;
  readonly prUrl: string;
}

export function watchedCards(cards: ReadonlyArray<KanbanCard>): ReadonlyArray<WatchedCard> {
  const watched: Array<WatchedCard> = [];
  for (const card of cards) {
    if (card.archivedAt !== null || !WATCHED.has(card.at)) continue;
    const prUrl = card.prUrl?.trim();
    if (prUrl === undefined || prUrl.length === 0) continue;
    watched.push({ card, prUrl });
  }
  return watched;
}

export function isStale(input: {
  readonly entry: KanbanPrChecks | undefined;
  readonly nowMs: number;
  readonly pendingTtlMs: number;
  readonly settledTtlMs: number;
}): boolean {
  if (!input.entry) return true;
  const ttl = input.entry.state === "pending" ? input.pendingTtlMs : input.settledTtlMs;
  return input.nowMs - DateTime.toEpochMillis(input.entry.checkedAt) >= ttl;
}

export function toKanbanCiChecks(input: {
  readonly checks: ChangeRequestChecks;
  readonly checkedAt: DateTime.Utc;
}): KanbanCiChecks {
  const unknown = input.checks.state === "unknown";
  const unknownReason = unknown ? (input.checks.unknownReason ?? "unavailable") : null;
  const unknownDetail = unknown
    ? (input.checks.unknownDetail ??
      (unknownReason === "no_checks"
        ? "The forge reported no CI checks for this pull request."
        : "The forge did not return a CI verdict."))
    : null;
  return {
    state: input.checks.state,
    total: input.checks.counts.total,
    passing: input.checks.counts.passing,
    failing: input.checks.counts.failing,
    pending: input.checks.counts.pending,
    failingNames: input.checks.failing.map((check) => check.name),
    failingUrl: input.checks.failing.find((check) => check.url !== null)?.url ?? null,
    unknownReason,
    unknownDetail,
    checkedAt: input.checkedAt,
  };
}

export function toPrChecks(input: {
  readonly cardId: KanbanCard["id"];
  readonly checks: ChangeRequestChecks;
  readonly checkedAt: DateTime.Utc;
}): KanbanPrChecks {
  return { cardId: input.cardId, ...toKanbanCiChecks(input) };
}

export function makePrChecksWatch<E = never>(options: PrChecksWatchOptions<E>): PrChecksWatch<E> {
  const pendingTtlMs = options.pendingTtlMs ?? PENDING_TTL_MS;
  const settledTtlMs = options.settledTtlMs ?? SETTLED_TTL_MS;
  const concurrency = options.concurrency ?? 3;
  const entries = new Map<KanbanCard["id"], KanbanPrChecks>();
  const inFlight = new Set<KanbanCard["id"]>();
  let load = options.load;

  const snapshot: PrChecksWatch<E>["snapshot"] = (cards) => {
    const live = new Set(watchedCards(cards).map((watched) => watched.card.id));
    for (const id of entries.keys()) {
      if (!live.has(id)) entries.delete(id);
    }
    return [...entries.values()];
  };

  const refresh: PrChecksWatch<E>["refresh"] = (cards) =>
    Effect.gen(function* () {
      if (load !== undefined) {
        const persisted = yield* load;
        for (const entry of persisted) entries.set(entry.cardId, entry);
        load = undefined;
      }
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const stale = watchedCards(cards).filter(
        (watched) =>
          !inFlight.has(watched.card.id) &&
          isStale({ entry: entries.get(watched.card.id), nowMs, pendingTtlMs, settledTtlMs }),
      );
      if (stale.length === 0) return;

      for (const watched of stale) inFlight.add(watched.card.id);
      yield* Effect.forEach(
        stale,
        (watched) =>
          options.fetch(watched.card).pipe(
            Effect.flatMap((checks) =>
              Effect.gen(function* () {
                const checkedAt = yield* DateTime.now;
                const entry = toPrChecks({ cardId: watched.card.id, checks, checkedAt });
                if (options.save !== undefined)
                  yield* options.save({
                    cardId: watched.card.id,
                    prUrl: watched.prUrl,
                    checks: entry,
                  });
                entries.set(watched.card.id, entry);
                if (
                  watched.card.at === "pr" &&
                  checks.changeRequestState === "merged" &&
                  options.onMerged !== undefined
                ) {
                  yield* options.onMerged(watched.card);
                }
              }),
            ),
            Effect.ensuring(Effect.sync(() => inFlight.delete(watched.card.id))),
          ),
        { concurrency, discard: true },
      );
    });

  return { snapshot, refresh };
}

let shared: PrChecksWatch<KanbanErrorType> | null = null;

/**
 * One cache for the whole process. The rpc layer is built per connection, so a
 * per-layer cache would spawn `gh` once per open board tab.
 */
export function sharedPrChecksWatch(
  options: PrChecksWatchOptions<KanbanErrorType>,
): PrChecksWatch<KanbanErrorType> {
  shared ??= makePrChecksWatch(options);
  return shared;
}
