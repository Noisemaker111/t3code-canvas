/**
 * The board's triggers and checks — the words rules are written in.
 *
 * Values, not a union in an engine. Adding a trigger is exporting one, and a
 * component written outside this file can use it or write its own.
 *
 * @module kanban/components/vocabulary
 */
import type { BoardSettings } from "@t3tools/contracts";
import { check, trigger } from "@t3tools/shared/board";
import { hasPr, hasThread, isRouted } from "@t3tools/shared/cardFacts";

import {
  COMPLETION_TRANSCRIPT_LIMIT,
  completionChecksAsked,
  completionStage,
} from "../hermes/completionPass.ts";
import type { BoardCard, PrChecksSnapshot } from "./card.ts";

// ── checks ────────────────────────────────────────────────────────────────

/** Reads as the tail of a refusal: "Active needs a routed prompt." */
export const routed = check<BoardCard, BoardCard>(
  "needs a routed prompt",
  (card): card is BoardCard => isRouted(card),
);

export const threaded = check<BoardCard, BoardCard>(
  "needs a thread behind it",
  (card): card is BoardCard => hasThread(card),
);

export const unthreaded = check<BoardCard, BoardCard>(
  "has no thread behind it",
  (card): card is BoardCard => !hasThread(card),
);

export const pullRequested = check<BoardCard, BoardCard>(
  "needs an open pull request",
  (card): card is BoardCard => hasPr(card),
);

/** Active takes a card with work it can do: a thread already, or a routed prompt. */
export const workable = check<BoardCard, BoardCard>(
  "needs a routed prompt",
  (card): card is BoardCard => hasThread(card) || isRouted(card),
);

// ── lifecycle triggers ────────────────────────────────────────────────────

export const arrives = trigger<void, BoardCard>({ name: "a card arrives", on: "enter" });
export const leaves = trigger<void, BoardCard>({ name: "a card leaves", on: "exit" });

/** Every tick, unconditionally. The `if`/`unless` on the rule say the rest. */
export const eachTick = trigger<void, BoardCard>({ name: "each tick", on: "tick" });

// ── sensing triggers ──────────────────────────────────────────────────────

/**
 * The forge says a required check failed.
 *
 * An unreadable forge is never a failure and never a pass — it returns null
 * here, and the merge rule refuses separately, so a forge outage cannot merge
 * anything by accident nor bounce a card that is fine.
 */
export const checksRed = trigger<PrChecksSnapshot, BoardCard>({
  name: "PR checks go red",
  on: "tick",
  detect: async (card) => {
    if (!hasPr(card)) return null;
    const checks = await card.prChecks().catch(() => null);
    return checks !== null && checks.state === "failing" ? checks : null;
  },
});

/**
 * Everything the forge has to say passed.
 *
 * `pending` is "ask again next tick". `unknown` is never a pass — except that
 * a repo with no CI reads exactly like one whose runs have not registered yet,
 * so that one case waits out a grace window the caller supplies.
 */
export function checksGreen(graceMs: () => number) {
  return trigger<PrChecksSnapshot, BoardCard>({
    name: "PR checks pass",
    on: "tick",
    detect: async (card) => {
      if (!hasPr(card)) return null;
      const checks = await card.prChecks();
      if (checks.state === "passing") return checks;

      // A merge attempt against checks that have not finished is a call that
      // can only fail; the next tick asks again.
      if (checks.state === "pending") {
        card.note(`rule mergeable-pr: ${card.id} — checks still running, not merging yet`);
        return null;
      }
      if (checks.state !== "unknown") return null;

      // Anything short of green stays unmerged. A forge we could not read is
      // never a pass, and a PR whose runs have not registered yet reads exactly
      // like a repo with no CI — so the second only counts once the grace
      // window is spent.
      if (checks.unknownReason !== "no_checks") {
        card.note(`rule mergeable-pr: ${card.id} — could not read the PR's checks, not merging`);
        return null;
      }
      const openMs =
        checks.openedAtMs === null || checks.openedAtMs === undefined
          ? card.ageMs
          : card.nowMs - checks.openedAtMs;
      if (openMs < graceMs()) {
        card.note(
          `rule mergeable-pr: ${card.id} — no check has registered yet ` +
            `(${Math.round(openMs / 1000)}s of ${Math.round(graceMs() / 1000)}s grace), not merging`,
        );
        return null;
      }
      return checks;
    },
  });
}

export type CompletionStage = ReturnType<typeof completionStage>;

/**
 * The thread has answered, and the answer is this one.
 *
 * A stopped thread is never finished from its closing message — it is finished
 * from an answer to a question. `completionStage` reads the transcript and says
 * which answer this is, so each of ask / continue / review / finish is its own
 * rule rather than four branches of one, and each keeps its own fire counter.
 *
 * The transcript read is memoized per card per pass, so four triggers asking
 * the same question cost one forge-side read.
 */
export function atStage<K extends CompletionStage["kind"]>(
  kind: K,
  settings: BoardSettings,
  maxChecks: number,
) {
  return trigger<CompletionStage & { kind: K }, BoardCard>({
    name: `the thread's answer is "${kind}"`,
    on: "tick",
    detect: async (card) => {
      if (!hasThread(card)) return null;
      const transcript = await card.transcript(COMPLETION_TRANSCRIPT_LIMIT);
      if (!transcript || !transcript.exists) return null;
      // A thread mid-turn is working. Nothing to ask and nothing to conclude.
      if (transcript.turnState === "running") return null;
      const stage = completionStage({
        transcript,
        reviewPassEnabled: settings.hermesReviewPassEnabled,
        maxChecks,
        checksAsked: completionChecksAsked(card.threadId as string),
      });
      return stage.kind === kind ? (stage as CompletionStage & { kind: K }) : null;
    },
  });
}

/** The card has sat here, untouched and with nothing running, for too long. */
export function sitsStill(afterMs: () => number) {
  return trigger<{ minutes: number }, BoardCard>({
    name: "the card sits here untouched",
    on: "tick",
    detect: async (card) => {
      if (card.stillForMs < afterMs()) return null;
      // A thread mid-turn is working, however long the card has been here.
      const transcript = await card.transcript(1);
      if (transcript?.turnState === "running") return null;
      return { minutes: Math.round(card.stillForMs / 60_000) };
    },
  });
}
