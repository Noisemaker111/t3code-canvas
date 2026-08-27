/**
 * The decision journal — what Hermes already did to a card, and how it went.
 *
 * Board state is deliberately not in here. Where a card sits, its thread, prep status
 * and PR url live in SQLite and are re-read on every tick, so writing them down
 * a second time can only produce a stale opinion that argues with the live one.
 * What a re-read cannot recover is what Hermes already tried, so that — and only
 * that — is journalled, by the runtime, from calls that actually ran. No model
 * writes here, so nothing in it can be paraphrased, invented or drifted.
 *
 * @module kanban/hermes/journal
 */
import { BOARD_WRITE_METHODS, boardCallFailure, type BoardCallRecord } from "./boardApi.ts";

export type HermesJournalEntry = {
  readonly cardId: string;
  readonly at: string;
  /** The board call, as the model spells it — `updateCard → active`. */
  readonly action: string;
  readonly ok: boolean;
  /** The failure, when there was one. */
  readonly error: string | null;
};

/** Attempts kept per card. Deep enough to see a loop, shallow enough to be free. */
export const HERMES_JOURNAL_PER_CARD = 8;

/** Entries rendered per card in a prompt — the tail is what answers "again?". */
export const HERMES_JOURNAL_PROMPT_ENTRIES = 5;

const ERROR_MAX_CHARS = 160;
const TEXT_MAX_CHARS = 80;

function actionOf(call: BoardCallRecord): string {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const at = args["at"];
  if (call.method === "updateCard" && typeof at === "string") {
    return `updateCard → ${at}`;
  }
  const text = args["text"];
  if (call.method === "nudgeThread" && typeof text === "string") {
    return `nudgeThread ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, TEXT_MAX_CHARS))}`;
  }
  const answer = args["answer"];
  if (call.method === "answerPermission" && typeof answer === "string") {
    return `answerPermission ${JSON.stringify(answer.slice(0, TEXT_MAX_CHARS))}`;
  }
  const question = args["question"];
  if (call.method === "askUser" && typeof question === "string") {
    return `askUser ${JSON.stringify(question.replace(/\s+/g, " ").slice(0, TEXT_MAX_CHARS))}`;
  }
  return call.method;
}

function cardIdOf(
  call: BoardCallRecord,
  cardIdByThreadId: ReadonlyMap<string, string>,
): string | null {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.method === "createCard") {
    const created = (call.result as { id?: unknown } | null)?.id;
    return typeof created === "string" ? created : null;
  }
  const id = args["id"];
  if (typeof id === "string") return id;
  const cardId = args["cardId"];
  if (typeof cardId === "string") return cardId;
  const threadId = args["threadId"];
  if (typeof threadId === "string") return cardIdByThreadId.get(threadId) ?? null;
  return null;
}

/** One journal entry per durable external effect that ran, in the order it ran. */
export function journalEntriesFromCalls(input: {
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly cardIdByThreadId: ReadonlyMap<string, string>;
  readonly at: string;
}): ReadonlyArray<HermesJournalEntry> {
  const entries: HermesJournalEntry[] = [];
  for (const call of input.calls) {
    if (call.skipped === true) continue;
    if (!BOARD_WRITE_METHODS.has(call.method)) continue;
    const cardId = cardIdOf(call, input.cardIdByThreadId);
    if (cardId === null) continue;
    const failure = boardCallFailure(call);
    entries.push({
      cardId,
      at: input.at,
      action: actionOf(call),
      ok: failure === null,
      error: failure === null ? null : failure.slice(0, ERROR_MAX_CHARS),
    });
  }
  return entries;
}

/** Append, then keep only the newest `HERMES_JOURNAL_PER_CARD` per card. */
export function appendJournal(
  journal: ReadonlyArray<HermesJournalEntry>,
  entries: ReadonlyArray<HermesJournalEntry>,
): ReadonlyArray<HermesJournalEntry> {
  if (entries.length === 0) return journal;
  const merged = [...journal, ...entries];
  const kept = new Map<string, number>();
  const out: HermesJournalEntry[] = [];
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const entry = merged[index];
    if (!entry) continue;
    const seen = kept.get(entry.cardId) ?? 0;
    if (seen >= HERMES_JOURNAL_PER_CARD) continue;
    kept.set(entry.cardId, seen + 1);
    out.push(entry);
  }
  return out.reverse();
}

/**
 * Forget cards that left the board. The journal is a memory of decisions in
 * flight, not an archive — a done card's history is in its PR.
 */
export function pruneJournal(
  journal: ReadonlyArray<HermesJournalEntry>,
  liveCardIds: ReadonlySet<string>,
): ReadonlyArray<HermesJournalEntry> {
  if (journal.every((entry) => liveCardIds.has(entry.cardId))) return journal;
  return journal.filter((entry) => liveCardIds.has(entry.cardId));
}

/**
 * The prompt block, for the asked-about cards only. Everything else stays on
 * disk — a card Hermes is not being asked about costs nothing to remember.
 */
export function formatJournalBlock(
  journal: ReadonlyArray<HermesJournalEntry>,
  cardIds: ReadonlySet<string>,
): string | null {
  const byCard = new Map<string, HermesJournalEntry[]>();
  for (const entry of journal) {
    if (!cardIds.has(entry.cardId)) continue;
    const list = byCard.get(entry.cardId) ?? [];
    list.push(entry);
    byCard.set(entry.cardId, list);
  }
  if (byCard.size === 0) return null;
  const lines: string[] = [];
  for (const [cardId, entries] of byCard) {
    lines.push(`- ${cardId}`);
    for (const entry of entries.slice(-HERMES_JOURNAL_PROMPT_ENTRIES)) {
      const outcome = entry.ok ? "ok" : `failed: ${entry.error ?? "unknown"}`;
      lines.push(`  · ${entry.at} ${entry.action} → ${outcome}`);
    }
  }
  return lines.join("\n");
}
