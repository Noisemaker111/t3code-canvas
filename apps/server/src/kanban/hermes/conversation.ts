/**
 * The persisted Hermes conversation — one message history so a tick is a turn,
 * not a rebuilt world. First turn carries the full snapshot; every later tick
 * appends a small delta and, after execution, a compact result turn, so the
 * next prompt contains what actually happened.
 *
 * History is dropped at a *decision boundary*, not at a counter. A turn belongs
 * to the cards it was asked about; once none of them are in the judgment queue
 * any more, that decision is closed and its turns are dead weight. When the
 * queue empties entirely nothing is mid-derivation, so the whole history can go
 * — that is the free, correct place to cut, and on a real board it comes around
 * constantly. A token ceiling still exists, but only as a backstop for a board
 * that never settles, and hitting it is itself worth logging: it means one card
 * has been undecided for the entire conversation.
 *
 * Nothing is summarized. What is dropped described board state that SQLite
 * still holds exactly, so the next tick re-reads it; the one thing a re-read
 * cannot recover — what Hermes already tried — is carried by the journal, which
 * the runtime writes from calls that ran. No model is asked to remember
 * anything, so nothing degrades.
 *
 * @module kanban/hermes/conversation
 */
import * as NodeCrypto from "node:crypto";

import { boardCallFailure, type BoardCallRecord } from "./boardApi.ts";
import type { HermesMessage } from "./backend.ts";
import type { HermesJournalEntry } from "./journal.ts";
import { buildHermesSystemPrompt } from "./prompt.ts";

export type HermesTurnKind = "snapshot" | "delta" | "program" | "result";

export type HermesConversationTurn = {
  readonly role: "user" | "assistant";
  readonly kind: HermesTurnKind;
  readonly content: string;
  readonly at: string;
  /**
   * The cards this turn was asked about. A turn is closed once none of them are
   * still in the judgment queue — which is what makes a cut point a boundary
   * rather than a guess.
   */
  readonly cards: ReadonlyArray<string>;
};

/** Why the history was cut. `ceiling` is the one that means something is wrong. */
export type HermesEvictionReason = "settled" | "resolved" | "ceiling";

/**
 * The CLI session holding this history, so a server restart reattaches to the
 * running agent instead of re-sending everything it already knows. Tier and
 * model are part of the record because a session under either one changed is a
 * different brain, and resuming into it would answer out of the wrong history.
 */
export type HermesCliSessionRecord = {
  readonly tier: string;
  readonly model: string;
  readonly id: string;
};

export type HermesConversationState = {
  readonly systemPromptVersion: string;
  readonly turns: ReadonlyArray<HermesConversationTurn>;
  /** Exact per-card decision history, written by the runtime. Survives eviction. */
  readonly journal: ReadonlyArray<HermesJournalEntry>;
  readonly lastEvictionAt: string | null;
  readonly lastEvictionReason: HermesEvictionReason | null;
  readonly startedAt: string | null;
  /** Per-card state as of the last appended turn — the base for the next delta. */
  readonly boardDigest: Record<string, string>;
  /**
   * Set by an eviction: the next tick sends a full snapshot instead of a delta,
   * because no retained turn still carries the state a delta would diff against.
   */
  readonly resnapshot: boolean;
  /** Prompt tokens the serving tier actually charged last tick, when it said. */
  readonly lastInputTokens: number | null;
  /** The CLI session this history lives in, when a CLI transport is serving. */
  readonly cliSession: HermesCliSessionRecord | null;
};

/**
 * Below this a settled history is not worth dropping: the snapshot that would
 * replace it costs more than keeping it, and the cache stays warm. The boundary
 * decides *when* to cut; this decides *whether* the cut pays for itself.
 */
export const HERMES_SETTLE_MIN_TOKENS = 4_000;

/** Last resort only — what the ceiling keeps when no decision has closed. */
export const HERMES_CONVERSATION_KEEP_TURNS = 6;

let systemVersion: string | null = null;

/** Identifies the system prompt the history was built against. A change reseeds. */
export function hermesSystemPromptVersion(): string {
  systemVersion ??= NodeCrypto.createHash("sha256")
    .update(buildHermesSystemPrompt())
    .digest("hex")
    .slice(0, 12);
  return systemVersion;
}

export function emptyHermesConversation(
  input: {
    readonly journal?: ReadonlyArray<HermesJournalEntry>;
    readonly startedAt?: string | null;
  } = {},
): HermesConversationState {
  return {
    systemPromptVersion: hermesSystemPromptVersion(),
    turns: [],
    journal: input.journal ?? [],
    lastEvictionAt: null,
    lastEvictionReason: null,
    startedAt: input.startedAt ?? null,
    boardDigest: {},
    resnapshot: false,
    lastInputTokens: null,
    cliSession: null,
  };
}

/** chars/4 — good enough for a budget, and honest about being an estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function conversationTokens(state: HermesConversationState): number {
  return state.turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
}

/**
 * The history a conversational tick re-sends: the retained turns, unchanged.
 *
 * Nothing is prepended here, and that is load-bearing. Prefix caching is
 * exact-prefix: a block that is rewritten in place at the head of the history
 * misses the cache on every tick after it changes. Everything that varies —
 * the journal, the snapshot, the delta — rides in the newest turn instead.
 */
export function assembleHistory(state: HermesConversationState): ReadonlyArray<HermesMessage> {
  return state.turns.map((turn) => ({ role: turn.role, content: turn.content }));
}

const RESULT_MAX_CHARS = 2_400;

/**
 * The compact feedback turn appended after execution, so the next tick's
 * context contains what happened — failures included.
 */
export function buildResultTurn(input: {
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly error: string | null;
  readonly stateless?: boolean;
}): string {
  const lines = input.calls
    .filter((call) => call.skipped !== true)
    .map((call) => {
      const args = call.args === undefined ? "" : ` ${JSON.stringify(call.args).slice(0, 160)}`;
      const failure = boardCallFailure(call);
      return `- ${call.method}${args} → ${failure === null ? "ok" : `failed: ${failure.slice(0, 200)}`}`;
    });
  const header = input.stateless
    ? "## RESULT (a stateless fallback tick ran while your transport was down; its calls:)"
    : "## RESULT (what your program's calls did)";
  const body = [
    header,
    lines.length === 0 ? "(no board calls)" : lines.join("\n"),
    ...(input.error ? [`tick error: ${input.error.slice(0, 300)}`] : []),
  ].join("\n");
  return body.length > RESULT_MAX_CHARS ? `${body.slice(0, RESULT_MAX_CHARS)}…` : body;
}

export function appendTurns(
  state: HermesConversationState,
  turns: ReadonlyArray<HermesConversationTurn>,
  boardDigest?: Record<string, string>,
): HermesConversationState {
  return {
    ...state,
    turns: [...state.turns, ...turns],
    startedAt: state.startedAt ?? turns[0]?.at ?? null,
    resnapshot: false,
    ...(boardDigest ? { boardDigest } : {}),
  };
}

/** What the provider charged for the last ask, when it reported it. */
export function recordInputTokens(
  state: HermesConversationState,
  inputTokens: number | null | undefined,
): HermesConversationState {
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return state;
  }
  return { ...state, lastInputTokens: inputTokens };
}

export type HermesEvictionPlan = {
  readonly reason: HermesEvictionReason;
  /** Index of the first turn to keep. */
  readonly keepFrom: number;
};

/** A turn is closed once none of the cards it was asked about are still queued. */
function closed(turn: HermesConversationTurn, queued: ReadonlySet<string>): boolean {
  return turn.cards.every((cardId) => !queued.has(cardId));
}

/**
 * Where to cut, or null for "not here". Ordered by how good the cut point is,
 * which is the whole point: a boundary first, a counter only when the board
 * refuses to give us one.
 */
export function planEviction(input: {
  readonly state: HermesConversationState;
  /** Cards the model is being asked about right now — what is mid-decision. */
  readonly queuedCardIds: ReadonlySet<string>;
  /**
   * Opt-in, per model. Null means this model has no backstop: history is only
   * ever cut at a boundary, and an overflow is the provider's own compaction to
   * handle. Cutting mid-decision at a number nobody chose is worse than not
   * cutting at all.
   */
  readonly ceilingTokens?: number | null;
  readonly settleMinTokens?: number;
}): HermesEvictionPlan | null {
  const { state, queuedCardIds } = input;
  const ceiling = input.ceilingTokens ?? null;
  const settleMin = input.settleMinTokens ?? HERMES_SETTLE_MIN_TOKENS;
  if (state.turns.length === 0) return null;

  // Nothing is mid-derivation. The whole history is closed decisions, and a
  // settled board is not about to send a delta anyway — cut for free.
  if (queuedCardIds.size === 0) {
    return conversationTokens(state) >= settleMin
      ? { reason: "settled", keepFrom: state.turns.length }
      : null;
  }

  if (ceiling === null) return null;
  const tokens = state.lastInputTokens ?? conversationTokens(state);
  if (tokens <= ceiling) return null;

  // Over the ceiling mid-work: drop the leading turns whose decisions closed,
  // and keep every turn that is still about something the model is deciding.
  let keepFrom = 0;
  while (keepFrom < state.turns.length) {
    const turn = state.turns[keepFrom];
    if (!turn || !closed(turn, queuedCardIds)) break;
    keepFrom += 1;
  }
  if (keepFrom > 0) return { reason: "resolved", keepFrom };

  // Every turn still touches a queued card, so this cut goes through a live
  // decision. That is a symptom, not a routine event: one card has been
  // undecided for the entire conversation.
  return {
    reason: "ceiling",
    keepFrom: Math.max(0, state.turns.length - HERMES_CONVERSATION_KEEP_TURNS),
  };
}

/** The configured backstop for the serving model, or null when it has none. */
export function ceilingForModel(
  ceilings: Readonly<Record<string, number>>,
  model: string,
): number | null {
  const configured = ceilings[model.trim()];
  return typeof configured === "number" && configured > 0 ? configured : null;
}

/**
 * Drop the leading turns. A history may not open on an assistant turn — a
 * stateless tick appends a single turn, so a cut does not land on a
 * delta/program/result boundary on its own.
 */
function alignToUserTurn(
  turns: ReadonlyArray<HermesConversationTurn>,
): ReadonlyArray<HermesConversationTurn> {
  const start = turns.findIndex((turn) => turn.role === "user");
  return start <= 0 ? (start === 0 ? turns : []) : turns.slice(start);
}

/**
 * Apply a plan, without asking a model anything. The dropped turns described
 * board state that SQLite still holds exactly, so `resnapshot` re-derives it on
 * the next tick; the journal keeps the part that was never in SQLite. There is
 * no failure path here to hedge against — that is the point.
 */
export function applyEviction(
  state: HermesConversationState,
  plan: HermesEvictionPlan,
  at: string,
): HermesConversationState {
  return {
    ...state,
    turns: alignToUserTurn(state.turns.slice(plan.keepFrom)),
    boardDigest: {},
    resnapshot: true,
    lastEvictionAt: at,
    lastEvictionReason: plan.reason,
    lastInputTokens: null,
    // The session goes with the turns it was holding; the next tick opens a
    // fresh one and re-snapshots.
    cliSession: null,
  };
}
