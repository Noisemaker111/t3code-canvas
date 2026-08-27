/**
 * What is left for the model after the rules ran.
 *
 * A tick with an empty queue asks no tier at all — the board is already where
 * the rules can take it, and paying a model to re-derive that is the bloat this
 * module exists to stop.
 *
 * @module kanban/hermes/judgment
 */
import type { BoardSettings, KanbanCard } from "@t3tools/contracts";
import { boardRulePolicy } from "@t3tools/shared/boardRules";

import { closingQuestion } from "./agentReport.ts";
import { findDuplicateCards, findOverlappingCards, formatMatches } from "./dedup.ts";
import type { HermesHelper } from "./helperStore.ts";
import { referencedCardId } from "./messageContext.ts";
import type { HermesSnapshot } from "./prompt.ts";

export type JudgmentKind =
  | "structure"
  | "route"
  | "review"
  | "blocked"
  | "answer"
  | "helper"
  | "message";

export type JudgmentItem = {
  readonly kind: JudgmentKind;
  readonly cardId: string | null;
  readonly threadId: string | null;
  /** One line the prompt shows verbatim, so the model reads its own queue. */
  readonly why: string;
};

const MIN_IDLE_MS = 60_000;

/**
 * Everything on the board that only a model can settle. Ordered the way a tick
 * should work through it: capture first, then unblock, then review.
 *
 * Every Active thread that is not mid-turn gets a [review] item — the model
 * judges from the transcript, not from whether the agent's closing message
 * happened to follow a format. Parsed reports are attached as hints only.
 * There is no nudge cap: `maxNudgesPerCard` is when the count starts reading
 * as "another identical nudge will not help", not a stop.
 */
export function judgmentQueue(input: {
  readonly snapshot: HermesSnapshot;
  readonly settings: BoardSettings;
  /** Fruitless model looks per card, so a re-judged card escalates in-prompt. */
  readonly reviewsByCardId?: ReadonlyMap<string, number>;
}): ReadonlyArray<JudgmentItem> {
  const { snapshot, settings } = input;
  const items: JudgmentItem[] = [];

  // A message addressed to Hermes is work only a model can do, so it queues
  // like anything else. Without this an idle board short-circuits before the
  // prompt is built and the mail is never read.
  for (const message of snapshot.canvasMessages ?? []) {
    const from = message.authorId
      ? `${message.authorKind} ${message.authorId}`
      : message.authorKind;
    const about = referencedCardId({ text: message.text, cards: snapshot.cards });
    items.push({
      kind: "message",
      cardId: about,
      threadId: null,
      why:
        `${from} said "${clipQuestion(message.text || "(picture only)")}"` +
        (about === null ? "" : ` — about ${about}`),
    });
  }

  const idleMs = Math.max(MIN_IDLE_MS, settings.hermesStuckPrepMs);
  const reportByCard = new Map(snapshot.reports.map((report) => [report.cardId, report]));
  const helpers = snapshot.helpers ?? [];

  // A settled helper is the queue item: its answer is the decision that was
  // missing, and it is shown once.
  for (const helper of helpers) {
    if (helper.status === "running" || helper.delivered) continue;
    items.push({
      kind: "helper",
      cardId: helper.cardId,
      threadId: null,
      why:
        helper.status === "answered"
          ? `helper ${helper.id} answered "${clipQuestion(helper.question)}" — its answer is in HELPERS`
          : `helper ${helper.id} failed (${helper.answer ?? "no reason"}) — decide without it`,
    });
  }

  // A card whose question is out to a helper is not undecided, it is waiting.
  // Re-queueing it buys a duplicate decision and a duplicate helper.
  const waiting = waitingOnHelper(helpers);
  const policy = boardRulePolicy(settings);

  for (const card of snapshot.cards) {
    const id = card.id as string;
    if (card.archivedAt || waiting.has(id)) continue;

    // untouched + failed are structure fodder. processing is already mid-tick
    // (or stuck until stuck-prep); do not re-queue it as a new structure ask.
    if (
      card.at === "prompts" &&
      policy.structureDrafts &&
      policy.launchPrompts &&
      (card.prepStatus === "untouched" ||
        card.prepStatus === "failed" ||
        card.prepStatus === null ||
        card.prepStatus === undefined) &&
      card.body.trim().length > 0
    ) {
      items.push({
        kind: "structure",
        cardId: id,
        threadId: null,
        why:
          (card.prepStatus === "failed" ? "structure failed — retry: " : "raw Prompt") +
          intakeNote(card, snapshot.cards),
      });
      continue;
    }

    if (
      card.at === "prompts" &&
      policy.launchPrompts &&
      card.prepStatus === "ready" &&
      card.body.trim().length > 0
    ) {
      items.push({
        kind: "route",
        cardId: id,
        threadId: null,
        why: `ready Prompt${intakeNote(card, snapshot.cards)}`,
      });
    }
  }

  for (const report of snapshot.reports) {
    if (report.blocked === null || waiting.has(report.cardId)) continue;
    items.push({
      kind: "blocked",
      cardId: report.cardId,
      threadId: report.threadId,
      why: `agent reported BLOCKED: ${report.blocked}`,
    });
  }

  for (const thread of snapshot.threads) {
    const card = snapshot.cards.find((entry) => entry.id === thread.cardId);
    if (!card || card.at !== "active" || waiting.has(thread.cardId)) continue;
    const report = reportByCard.get(thread.cardId);
    if (report?.blocked) continue;
    if (thread.exists && thread.turnState === "running") continue;
    // "none" can be a thread still warming up; a settled turn is reviewable now.
    if (thread.exists && thread.turnState === "none" && (thread.idleForMs ?? 0) < idleMs) continue;
    const hint = report
      ? `report hints: ${report.remaining.length} remaining, ${report.done.length} done`
      : "no readable report";
    const escalate =
      report && report.nudges >= settings.hermesBrainMaxNudges
        ? ` — ${report.nudges} nudges already, prefer a decision over another identical nudge`
        : "";
    const asked = threadQuestion(thread);
    const stopped =
      asked === null
        ? `stopped (turn=${thread.turnState}); ${hint}${escalate}`
        : `stopped to ask "${asked}"; ${hint}${escalate}`;
    items.push({
      kind: "review",
      cardId: thread.cardId,
      threadId: thread.threadId,
      why:
        (thread.exists ? stopped : "thread is gone — requeue or archive") +
        stallNote(input.reviewsByCardId?.get(thread.cardId) ?? 0),
    });
  }

  for (const pending of snapshot.pendingInputs) {
    items.push({
      kind: "answer",
      cardId: null,
      threadId: pending.threadId,
      why: `permission question: ${pending.question}`,
    });
  }

  // PR cards left after the rule pass have no Active-thread review item, so
  // the model used to be skipped forever ("Rules settled it · model must
  // decide" with an empty queue). Queue them so Hermes can merge, nudge the
  // card thread, or escalate with a model instead of green watching.
  for (const card of snapshot.cards) {
    if (card.archivedAt || card.at !== "pr" || waiting.has(card.id as string)) continue;
    const id = card.id as string;
    if (items.some((item) => item.cardId === id)) continue;
    items.push({
      kind: "blocked",
      cardId: id,
      threadId: card.threadId ? String(card.threadId) : null,
      why:
        `PR card still in column after rules` +
        (card.prUrl ? ` (${card.prUrl})` : "") +
        ` — merge, sync branch, or nudge the card thread with a model`,
    });
  }

  return items;
}

/**
 * What the board already has that this card is about to repeat: an identical
 * ask that is already carded, or running work in the same project that touches
 * the same area. Both used to be invisible at intake, which is how one prompt
 * shipped two pull requests and two cards fought over one file.
 */
function intakeNote(card: KanbanCard, cards: ReadonlyArray<KanbanCard>): string {
  const duplicates = findDuplicateCards({ card, cards });
  const overlaps = findOverlappingCards({ card, cards });
  return [
    duplicates.length > 0 ? ` — duplicate of ${formatMatches(duplicates)}` : "",
    overlaps.length > 0 ? ` — overlaps ${formatMatches(overlaps)}` : "",
  ].join("");
}

/**
 * The question a stopped thread's closing asked, as a label for the queue line.
 *
 * Read from the tail's newest entry, which the snapshot carries in full — not
 * from `lastLine`, which is clipped for liveness and cuts a real closing off
 * mid-sentence. Both are stored as `<role>: <text>`, and only the agent's own
 * words are an ask: a Hermes turn ending in a question mark is Hermes asking.
 */
function threadQuestion(thread: {
  readonly lastLine: string | null;
  readonly tail?: ReadonlyArray<string>;
}): string | null {
  const closing = thread.tail?.at(-1) ?? thread.lastLine;
  const said = /^assistant:\s*/.exec(closing ?? "");
  return said === null ? null : closingQuestion((closing as string).slice(said[0].length));
}

/** Looks at one card that changed nothing before the card counts as parked. */
export const STALLED_REVIEWS = 3;

export function modelJudgmentQueue(
  items: ReadonlyArray<JudgmentItem>,
  reviewsByCardId: ReadonlyMap<string, number>,
): ReadonlyArray<JudgmentItem> {
  return items.filter(
    (item) => item.cardId === null || (reviewsByCardId.get(item.cardId) ?? 0) < STALLED_REVIEWS,
  );
}

/**
 * A card the model has already looked at and left alone. Looking again is the
 * failure mode this line exists to break: the queue keeps re-offering the card,
 * the board never moves, and nothing on it says why.
 */
function stallNote(reviews: number): string {
  if (reviews < 1) return "";
  const close =
    reviews >= STALLED_REVIEWS
      ? "another look will not help: finishCard, requeue, or askHelper aboutThreadId=this thread " +
        "'why can it not continue, and what is the one next action?' — askUser only with that answer"
      : "act, or write what is missing into the card body";
  return ` — looked at ${reviews}× with no move; ${close}`;
}

/** Cards with a helper still running. Their decision is already in flight. */
export function waitingOnHelper(helpers: ReadonlyArray<HermesHelper>): ReadonlySet<string> {
  return new Set(
    helpers
      .filter((helper) => helper.status === "running" && helper.cardId !== null)
      .map((helper) => helper.cardId as string),
  );
}

const clipQuestion = (question: string): string => {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

export function formatJudgmentQueue(items: ReadonlyArray<JudgmentItem>): string {
  return items
    .map((item) => {
      const target = item.cardId ?? `thread ${item.threadId ?? "?"}`;
      return `- [${item.kind}] ${target} — ${item.why}`;
    })
    .join("\n");
}
