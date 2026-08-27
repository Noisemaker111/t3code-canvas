/**
 * Which card a message to Hermes is about, and the record that answers for it.
 *
 * "Why did you route X there?" is only answerable from what actually ran, and
 * what ran is in the tick log. This module turns a sentence into a card id and
 * that card id into the lines of its own history.
 *
 * @module kanban/hermes/messageContext
 */
import type { HermesTickTranscript, KanbanCard } from "@t3tools/contracts";

import { BOARD_WRITE_METHODS, boardCallFailure } from "./boardApi.ts";

/** Words that match every card and therefore identify none. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "for",
  "with",
  "why",
  "did",
  "you",
  "card",
  "board",
  "hermes",
  "that",
  "this",
  "into",
  "from",
  "what",
  "when",
  "how",
  "was",
  "are",
  "put",
  "move",
  "moved",
  "route",
  "routed",
  "project",
]);

const MIN_TITLE_TOKENS = 2;

function tokens(text: string): ReadonlyArray<string> {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function prNumbers(text: string): ReadonlyArray<number> {
  return [...text.matchAll(/#(\d{1,6})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
}

function prNumberOf(card: KanbanCard): number | null {
  const match = /\/pull\/(\d+)/.exec(card.prUrl ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * The card a message names — by id, by PR number, or by enough of its title to
 * be unambiguous. Null when nothing matches or two cards match equally well:
 * attaching the wrong card's history is worse than attaching none.
 */
export function referencedCardId(input: {
  readonly text: string;
  readonly cards: ReadonlyArray<KanbanCard>;
}): string | null {
  const text = input.text.trim();
  if (text.length === 0) return null;
  const live = input.cards.filter((card) => !card.archivedAt);

  const byId = live.find((card) => text.includes(card.id as string));
  if (byId) return byId.id as string;

  const numbers = new Set(prNumbers(text));
  if (numbers.size > 0) {
    const byPr = live.find((card) => {
      const number = prNumberOf(card);
      return number !== null && numbers.has(number);
    });
    if (byPr) return byPr.id as string;
  }

  const asked = new Set(tokens(text));
  if (asked.size === 0) return null;
  const scored = live
    .map((card) => ({
      id: card.id as string,
      score: tokens(card.title).filter((word) => asked.has(word)).length,
    }))
    .filter((entry) => entry.score >= MIN_TITLE_TOKENS)
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) return null;
  return scored[1]?.score === best.score ? null : best.id;
}

/** Ticks rendered per card. Deep enough to explain a decision, not a log dump. */
const TICKS_PER_CARD = 6;
const CALLS_PER_TICK = 6;

function callsForCard(
  tick: HermesTickTranscript,
  cardId: string,
  threadId: string | null,
): ReadonlyArray<string> {
  return tick.calls
    .filter((call) => {
      if (!BOARD_WRITE_METHODS.has(call.method)) return false;
      const args = (call.args ?? {}) as Record<string, unknown>;
      return args["id"] === cardId || (threadId !== null && args["threadId"] === threadId);
    })
    .slice(0, CALLS_PER_TICK)
    .map((call) => {
      const failure = boardCallFailure(call);
      return `${call.method} → ${failure === null ? "ok" : `failed: ${failure.slice(0, 120)}`}`;
    });
}

export type HermesCardHistory = {
  readonly cardId: string;
  readonly lines: ReadonlyArray<string>;
};

/**
 * What the recorded ticks say about these cards: when Hermes touched one, what
 * it called, and the line it wrote that tick. Cards with no recorded tick are
 * left out — an empty heading is prompt Hermes pays for and cannot use.
 */
export function collectCardHistory(input: {
  readonly ticks: ReadonlyArray<HermesTickTranscript>;
  readonly cardIds: ReadonlySet<string>;
  readonly cards: ReadonlyArray<KanbanCard>;
}): ReadonlyArray<HermesCardHistory> {
  const out: HermesCardHistory[] = [];
  for (const cardId of input.cardIds) {
    const card = input.cards.find((entry) => entry.id === cardId);
    const threadId = card?.threadId === undefined ? null : (card.threadId as string | null);
    const lines: string[] = [];
    for (const tick of input.ticks) {
      if (tick.recordOnly) continue;
      const calls = callsForCard(tick, cardId, threadId);
      if (calls.length === 0) continue;
      lines.push(`  · ${tick.ranAt} ${calls.join(", ")} — ${tick.summary}`);
    }
    if (lines.length === 0) continue;
    out.push({ cardId, lines: lines.slice(-TICKS_PER_CARD) });
  }
  return out;
}

export function formatCardHistoryBlock(history: ReadonlyArray<HermesCardHistory>): string | null {
  if (history.length === 0) return null;
  return history.map((entry) => [`- ${entry.cardId}`, ...entry.lines].join("\n")).join("\n");
}
