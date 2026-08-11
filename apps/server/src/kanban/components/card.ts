/**
 * A card, as a rule holds it.
 *
 * The primitives in `@t3tools/shared/board` describe a card and the verbs on
 * it; this is that shape over the `BoardApi` the tick already writes through.
 * Every write goes through the same api, so a dry run records a rule's moves
 * and writes nothing, exactly as it did when the rules were `if` statements.
 *
 * The reads are on the card too — its checks, its transcript — because a rule
 * that has to be handed an api alongside its card is two arguments describing
 * one thing.
 *
 * **Verbs do not log. `step` logs.** A rule that opens a pull request and then
 * moves the card did one thing, and self-logging verbs would file it as two.
 * The rule says what it is doing once; the verbs inside are plumbing.
 *
 * @module kanban/components/card
 */
import type { KanbanCard } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { CardHandle } from "@t3tools/shared/board";

import { recordDegradation } from "../../health/incidentLog.ts";
import type { BoardApi, BoardPrSyncConflict } from "../hermes/boardApi.ts";

export type PrChecksSnapshot = Awaited<ReturnType<BoardApi["prChecks"]>>;
export type TranscriptSnapshot = Awaited<ReturnType<BoardApi["threadTranscript"]>>;

export interface MergeOutcome {
  readonly merged: boolean;
  readonly reason: string | null;
  readonly conflict: BoardPrSyncConflict | null;
}

/**
 * The card a server-side rule receives: the shared verbs, plus the reads only
 * this side can do.
 */
export interface BoardCard extends CardHandle {
  /** The stored card, for anything a rule needs that the handle does not name. */
  readonly raw: KanbanCard;

  /**
   * Do one thing, under one log line, recorded as this rule's action.
   *
   * Resolves to null when the writes landed and to the failure text otherwise —
   * a refused pull request is an answer a rule acts on, not an exception.
   */
  readonly step: (detail: string, write: () => Promise<void>) => Promise<string | null>;
  /**
   * Say something the tick log should carry that is not an action.
   *
   * "Checks still running, not merging yet" is a rule declining to fire, and a
   * decline nobody can read is half of why the old pass was hard to trust.
   */
  readonly note: (line: string) => void;
  /** Attribute the writes inside to another rule id. */
  readonly as: (ruleId: string) => BoardCard;

  readonly prChecks: () => Promise<PrChecksSnapshot>;
  readonly transcript: (limit?: number) => Promise<TranscriptSnapshot | null>;
  /**
   * mergePr, and on an un-mergeable answer syncPrBranch then one retry. The
   * only path that merges, so nothing can merge behind the forge's checks.
   */
  readonly mergeWithSync: () => Promise<MergeOutcome>;

  /** How long the card has sat in the column it is in now, in ms. */
  readonly stillForMs: number;
  /** How long since anything touched the card at all, in ms. */
  readonly ageMs: number;
  /** The pass's clock. A rule never reads one of its own. */
  readonly nowMs: number;
  /** Prompts' own state. Only a component that owns a prep queue writes it. */
  readonly setPrep: (status: "untouched" | "processing" | "ready" | "failed") => Promise<void>;
}

/** What a pass collects while its rules run. */
export interface PassRecorder {
  readonly logs: Array<string>;
  readonly needsHuman: Array<{ cardId: string; reason: string }>;
  /** Records one rule action under `ruleId`. Null on success, else the failure. */
  readonly step: (
    ruleId: string,
    detail: string,
    write: () => Promise<void>,
  ) => Promise<string | null>;
}

/** Instants reach here as Effect DateTimes, and as wire strings in fixtures. */
function epochMs(value: unknown): number {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "string") return Date.parse(value);
  try {
    return DateTime.toEpochMillis(value as DateTime.DateTime);
  } catch {
    return Number.NaN;
  }
}

export function boardCard(input: {
  readonly card: KanbanCard;
  readonly api: BoardApi;
  readonly recorder: PassRecorder;
  readonly nowMs: number;
  /** Names the rule whose `do` is running, so its step logs under it. */
  readonly ruleId: () => string;
  readonly merge: (cardId: string) => Promise<MergeOutcome>;
}): BoardCard {
  const { card, api, recorder, nowMs } = input;
  const id = card.id as string;

  const updatedMs = epochMs(card.updatedAt);
  // A card that has never moved has no column clock, so its own clock is the
  // honest answer for how long it has been sitting where it is.
  const columnEnteredMs = card.columnEnteredAt === null ? updatedMs : epochMs(card.columnEnteredAt);

  const nudge = async (message: string): Promise<void> => {
    if (!card.threadId) return;
    await api.nudgeThread({ threadId: card.threadId, text: message });
  };

  // One read per card per pass. Four rules ask the completion stage the same
  // question, and a transcript fetched four times is four reads for one answer
  // that cannot change mid-tick.
  const transcripts = new Map<number, Promise<TranscriptSnapshot | null>>();
  /** Same reason: two triggers ask the forge one question. */
  let checks: Promise<PrChecksSnapshot> | null = null;

  // `as` shares these caches rather than rebuilding the handle: a second read of
  // the same forge answer under a different rule id is still a second read.
  const build = (ruleId: () => string): BoardCard => ({
    raw: card,
    id,
    at: card.at,
    title: card.title,
    body: card.body,
    threadId: card.threadId,
    prUrl: card.prUrl,
    prepStatus: card.prepStatus,
    stillForMs: Math.max(0, nowMs - (Number.isFinite(columnEnteredMs) ? columnEnteredMs : nowMs)),
    ageMs: Math.max(0, nowMs - (Number.isFinite(updatedMs) ? updatedMs : nowMs)),
    nowMs,

    step: (detail, write) => recorder.step(ruleId(), detail, write),
    note: (line) => recorder.logs.push(line),
    as: (other) => build(() => other),

    moveTo: async (to) => {
      await api.updateCard({ id, at: to, movedBy: ruleId() });
    },

    // Move, then tell the thread why. The move is what the board sees and the
    // message is what the agent acts on; a bounce that does one without the
    // other is the card silently changing lanes, or a thread told to fix
    // something it is no longer holding.
    sendBack: async (to, message) => {
      await api.updateCard({ id, at: to, movedBy: ruleId() });
      await nudge(message);
    },

    needsHuman: async (reason) => {
      recorder.needsHuman.push({ cardId: id, reason });
    },

    startThread: async () => {
      await api.launchActive({ id });
    },

    nudge,

    openPr: async () => {
      await api.openPr({ id });
      return null;
    },
    mergePr: async () => {
      const result = await api.mergePr({ id });
      return result.merged ? null : result.reason;
    },
    mergeWithSync: () => input.merge(id),

    releaseWorktree: async () => {
      // The store reaps on the move itself; nothing for a rule to do until the
      // reap is an exit rule of its own.
    },
    restoreWorktree: async () => {
      await api.restorePrWorktree({ id }).catch(() => ({ worktreePath: null }));
    },

    setPrep: async (status) => {
      await api.updateCard({ id, prepStatus: status });
    },

    // A forge that will not answer is never a pass, so this cannot merge
    // anything by accident — but it never resolves on its own either, so it is
    // filed as a degradation rather than one tick-log line nobody reads.
    prChecks: () => {
      if (checks !== null) return checks;
      checks = api.prChecks({ id }).catch((cause: unknown) => {
        recordDegradation({
          id: "hermes.pr-checks",
          title: "PR checks could not be read",
          detail:
            `card ${id}: ${cause instanceof Error ? cause.message : String(cause)} — ` +
            "the card stays in PR until the forge answers",
        });
        return {
          state: "unknown" as const,
          failing: [],
          unknownReason: "unavailable" as const,
        };
      });
      return checks;
    },

    transcript: (limit) => {
      if (!card.threadId) return Promise.resolve(null);
      const key = limit ?? 0;
      const cached = transcripts.get(key);
      if (cached) return cached;
      const threadId = card.threadId;
      const read = api
        .threadTranscript({ threadId, ...(limit === undefined ? {} : { limit }) })
        .catch(() => null);
      transcripts.set(key, read);
      return read;
    },
  });

  return build(input.ruleId);
}
