/**
 * Whether a card is the card next to it.
 *
 * Nothing used to compare an incoming card with the board, so the same prompt
 * typed twice became two cards, two threads and two pull requests of the same
 * change. This is the comparator the intake and the launch rules both ask.
 *
 * @module kanban/hermes/dedup
 */
import type { KanbanCard } from "@t3tools/contracts";

/** Token overlap at or above this is the same piece of work. */
export const DUPLICATE_SCORE = 0.62;

/** Enough shared ground to be worth holding a launch over. */
export const OVERLAP_SCORE = 0.34;

/** A Done card older than this is history, not a duplicate. */
export const RECENT_DONE_MS = 3 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "into",
  "from",
  "that",
  "this",
  "when",
  "then",
  "than",
  "should",
  "would",
  "make",
  "made",
  "add",
  "adds",
  "added",
  "card",
  "cards",
  "board",
  "mission",
  "done",
  "work",
  "constraints",
  "todo",
]);

export function cardTokens(input: { title: string; body: string }): ReadonlySet<string> {
  const text = `${input.title} ${input.body}`.toLowerCase();
  const tokens = text.match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [];
  return new Set(tokens.filter((token) => !STOPWORDS.has(token)));
}

/** Dice coefficient over content tokens; 1 for an identical title. */
export function cardSimilarity(
  left: { title: string; body: string },
  right: { title: string; body: string },
): number {
  if (left.title.trim().length > 0 && left.title.trim() === right.title.trim()) return 1;
  const a = cardTokens(left);
  const b = cardTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export type CardMatch = {
  readonly cardId: string;
  readonly title: string;
  readonly at: string;
  readonly score: number;
};

const isLive = (card: KanbanCard): boolean => card.archivedAt === null;

const recentlyDone = (card: KanbanCard, nowMs: number): boolean => {
  const updatedAt = (card as { updatedAt?: unknown }).updatedAt;
  const parsed = Date.parse(typeof updatedAt === "string" ? updatedAt : "");
  return Number.isFinite(parsed) && nowMs - parsed <= RECENT_DONE_MS;
};

/**
 * Cards that already say what this one says: anything open, plus Done cards
 * from the last few days. Highest score first.
 */
export function findDuplicateCards(input: {
  readonly card: KanbanCard;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly nowMs?: number;
  readonly threshold?: number;
}): ReadonlyArray<CardMatch> {
  const nowMs = input.nowMs ?? Date.now();
  const threshold = input.threshold ?? DUPLICATE_SCORE;
  return input.cards
    .filter(
      (other) =>
        other.id !== input.card.id &&
        isLive(other) &&
        (other.at !== "done" || recentlyDone(other, nowMs)),
    )
    .map((other) => ({
      cardId: other.id as string,
      title: other.title,
      at: other.at as string,
      score: cardSimilarity(input.card, other),
    }))
    .filter((match) => match.score >= threshold)
    .toSorted((left, right) => right.score - left.score);
}

/**
 * Work already running in the same project that plausibly touches the same
 * area. Two cards editing one file concurrently is how one lands and the other
 * arrives orphaned and conflicted.
 */
export function findOverlappingCards(input: {
  readonly card: KanbanCard;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly threshold?: number;
}): ReadonlyArray<CardMatch> {
  const projectId = input.card.projectId;
  const threshold = input.threshold ?? OVERLAP_SCORE;
  // An unrouted card is compared against every running card: the collision that
  // matters is two cards editing one area, and routing happens after intake.
  return input.cards
    .filter(
      (other) =>
        other.id !== input.card.id &&
        isLive(other) &&
        (!projectId || other.projectId === projectId) &&
        (other.at === "active" || other.at === "pr"),
    )
    .map((other) => ({
      cardId: other.id as string,
      title: other.title,
      at: other.at as string,
      score: cardSimilarity(input.card, other),
    }))
    .filter((match) => match.score >= threshold)
    .toSorted((left, right) => right.score - left.score);
}

/** One clause for a prompt line: `card-3 "Add a Draft view" [active] 0.71`. */
export function formatMatches(matches: ReadonlyArray<CardMatch>): string {
  return matches
    .slice(0, 3)
    .map(
      (match) =>
        `${match.cardId} ${JSON.stringify(match.title.slice(0, 80))} [${match.at}] ${match.score.toFixed(2)}`,
    )
    .join("; ");
}
