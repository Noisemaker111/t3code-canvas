/**
 * One reading order out of two sources: what people said to Hermes (canvas
 * messages) and what Hermes was sent and did (the durable chat feed). Neither
 * side knows about the other, so the merge happens here rather than in a store.
 */
import type { CanvasMessage, HermesChatEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type HermesFeedSpeaker = "you" | "thread" | "hermes" | "board";

export type HermesFeedRow = {
  readonly id: string;
  readonly atMs: number;
  readonly speaker: HermesFeedSpeaker;
  readonly label: string;
  /** The line that is always shown. */
  readonly summary: string;
  /** The turn verbatim, shown on expand. Empty when there is nothing more. */
  readonly text: string;
  readonly program?: string;
  readonly tier?: string;
  readonly error?: string;
};

function speakerOf(message: CanvasMessage): HermesFeedSpeaker {
  if (message.authorKind === "human") return "you";
  if (message.authorKind === "hermes") return "hermes";
  return "thread";
}

function labelOf(message: CanvasMessage): string {
  if (message.authorKind === "human") return "You";
  if (message.authorKind === "hermes") return "Hermes";
  return message.authorId ? `Thread ${message.authorId.slice(0, 8)}` : "Thread";
}

function messageRow(message: CanvasMessage): HermesFeedRow {
  const extras = message.hasImage ? ["picture"] : [];
  return {
    id: `msg-${message.id}`,
    atMs: DateTime.toEpochMillis(message.createdAt),
    speaker: speakerOf(message),
    label: [labelOf(message), ...extras].join(" · "),
    summary: message.text.length > 0 ? message.text : "(no comment)",
    text: "",
  };
}

function entryRow(entry: HermesChatEntry): HermesFeedRow {
  const at = Date.parse(entry.at);
  return {
    id: entry.id,
    atMs: Number.isFinite(at) ? at : 0,
    speaker: entry.kind === "board" ? "board" : "hermes",
    label: entry.kind === "board" ? "Board → Hermes" : entry.kind === "note" ? "Rules" : "Hermes",
    summary: entry.summary,
    text: entry.text,
    ...(entry.program === undefined ? {} : { program: entry.program }),
    ...(entry.tier === undefined ? {} : { tier: entry.tier }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

/**
 * Oldest first, newest last — a chat, not a log. Ties keep the chat feed ahead
 * of a message posted in the same millisecond: the turn is what the message
 * landed in.
 */
export function mergeHermesFeed(input: {
  readonly messages: ReadonlyArray<CanvasMessage>;
  readonly entries: ReadonlyArray<HermesChatEntry>;
  readonly limit?: number;
}): ReadonlyArray<HermesFeedRow> {
  const rows = [...input.entries.map(entryRow), ...input.messages.map(messageRow)];
  rows.sort((left, right) => left.atMs - right.atMs);
  const limit = input.limit ?? 120;
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}
