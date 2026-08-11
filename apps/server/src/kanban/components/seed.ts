/**
 * The four components a fresh board is seeded with, as rules.
 *
 * There is no such thing as a column here. Prompts, Active, PR and Archived are
 * four components that happen to be tall, hold cards, and have rules; a
 * terminal is the same primitive with none of that filled in. Their ids are
 * seed data, not a schema — see `components/canvas/panels/boardColumns.ts`.
 *
 * This is what `rulePass.ts` used to say as thirteen `if` statements spread
 * across five mechanisms. Read the lists and you have read what the board does,
 * which is the invariant the whole design exists for.
 *
 * Built per component from settings rather than declared as constants. Two
 * reasons and both matter: the caps, the grace window and the review prompt
 * reach rule bodies, and a rule a board has switched off is **left out of the
 * list** rather than filtered at dispatch. A person turns a behavior off by
 * deleting its stored row; the honest expression of that is a component that
 * does not have the rule.
 *
 * @module kanban/components/seed
 */
import type { BoardSettings, ComponentId } from "@t3tools/contracts";
import { component, rule, type AnyRule, type Component } from "@t3tools/shared/board";
import { ruleEnabled, ruleTarget, unsupportedRuleRows } from "@t3tools/shared/boardRules";

import {
  COMPLETION_TRANSCRIPT_LIMIT,
  checksRedRounds,
  checksRedText,
  completionCheckText,
  conflictRounds,
  conflictText,
  continueText,
  prRefusedText,
  recordCompletionCheckAsked,
  reviewText,
} from "../hermes/completionPass.ts";
import type { BoardPrSyncConflict } from "../hermes/boardApi.ts";
import type { BoardCard, MergeOutcome, PrChecksSnapshot } from "./card.ts";
import {
  arrives,
  leaves,
  checksGreen,
  checksRed,
  eachTick,
  pullRequested,
  sitsStill,
  threaded,
  unthreaded,
  workable,
} from "./vocabulary.ts";
import type { CompletionStage } from "./vocabulary.ts";
import { atStage } from "./vocabulary.ts";

/** What a `prConflict` row may do. Anything else is named in the tick log. */
const CONFLICT_ACTIONS = ["moveTo"];

/** Below this a card is "stalled" while an agent is merely thinking. */
const MIN_STALLED_CARD_MS = 300_000;
const DEFAULT_STALLED_CARD_MS = 1_800_000;
const MIN_STUCK_PREP_MS = 30_000;
/** GitHub registers runs slower than this often enough. */
const DEFAULT_PR_CHECK_GRACE_MS = 600_000;

export type BoardComponent = Component<never, BoardCard>;

/** What the pass hands a component so its rules can act and be counted. */
export interface ComponentDeps {
  readonly settings: BoardSettings;
  /** Resolved policy: whether the pipeline rows this build knows are on. */
  readonly policy: {
    readonly finishActive: boolean;
    readonly mergeWhenGreen: boolean;
    readonly conflictReturn: boolean;
  };
}

export type PrConflict = BoardPrSyncConflict;

function numberOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The component holding cards at `id`.
 *
 * Every one gets the stalled rule when its own stored rows carry it, including
 * a component somebody added — which is otherwise a place to put cards until
 * they give it rules.
 */
export function componentFor(id: ComponentId, deps: ComponentDeps): BoardComponent {
  const { settings } = deps;
  const stalledMs = () =>
    Math.max(MIN_STALLED_CARD_MS, numberOr(settings.hermesStalledCardMs, DEFAULT_STALLED_CARD_MS));

  /**
   * An explicit `cardStalled` row wins over recovery: the owner wrote what a
   * card sitting here should do, and there is nothing to recover once a card
   * has been still for half an hour. No seed component ships one, so this is
   * absent until somebody writes it.
   */
  const stalledTarget = ruleTarget(settings, id, "cardStalled");
  const stalledOn =
    stalledTarget !== null &&
    stalledTarget !== id &&
    ruleEnabled({
      settings,
      at: id,
      when: "cardStalled",
      then: "moveTo",
      legacy: false,
    });

  const stalled = stalledOn
    ? [
        rule<{ minutes: number }, BoardCard>({
          name: "the card sits here untouched",
          id: "card-stalled",
          when: sitsStill(stalledMs),
          row: { trigger: "cardStalled", action: "moveTo" },
          do: (card, { minutes }) =>
            card.step(
              `sat in ${id} for ${minutes}m with nothing running, moved to ${stalledTarget}`,
              () => card.moveTo(stalledTarget),
            ),
        }),
      ]
    : [];

  const own = seedRules(id, deps);
  return component<never, BoardCard>({
    title: seedTitle(id),
    ...(seedAccepts(id) === null ? {} : { accepts: seedAccepts(id)! }),
    rules: [...stalled, ...own],
  });
}

function seedTitle(id: string): string {
  return { prompts: "Prompts", active: "Active", pr: "PR", done: "Archived" }[id] ?? id;
}

function seedAccepts(id: string) {
  if (id === "active") return workable;
  if (id === "pr") return threaded;
  return null;
}

/** The rules this build ships for a seed component, minus anything switched off. */
function seedRules(id: string, deps: ComponentDeps): ReadonlyArray<AnyRule<BoardCard>> {
  const { settings, policy } = deps;
  const maxSyncs = Math.max(1, settings.hermesBrainMaxNudges);
  const maxChecks = Math.max(1, Math.floor(settings.hermesCompletionMaxChecks));
  const stuckPrepMs = Math.max(MIN_STUCK_PREP_MS, settings.hermesStuckPrepMs);
  const graceMs = () =>
    Math.max(0, numberOr(settings.hermesPrCheckGraceMs, DEFAULT_PR_CHECK_GRACE_MS));

  if (id === "prompts") {
    return [
      rule<void, BoardCard>({
        name: "structuring stuck too long → prep reset so it can retry",
        id: "stuck-prep",
        when: eachTick,
        do: async (card) => {
          if (card.prepStatus !== "processing" || card.ageMs < stuckPrepMs) return;
          // Fail loud: UI shows Failed · Structuring, judgment re-queues failed.
          await card.step("prep stalled, mark structure failed", () => card.setPrep("failed"));
        },
      }),
    ];
  }

  if (id === "active") {
    const requeueOrphans = rule<void, BoardCard>({
      name: "card with no coding thread behind it → requeued to Prompts",
      id: "orphaned-active",
      when: eachTick,
      if: unthreaded,
      do: (card) =>
        card.step("Active with no thread, requeued to Prompts", () => card.moveTo("prompts")),
    });

    // A stopped thread is never finished from its closing message. It is
    // finished from an answer to a question, which is a different thing — so
    // these four are four rules, one per answer the thread can give.
    const completion = !policy.finishActive
      ? []
      : [
          rule<CompletionStage & { kind: "ask" }, BoardCard>({
            name: "a quiet thread is asked whether the goal is done",
            id: "completion-check",
            when: atStage("ask", settings, maxChecks),
            do: async (card, stage) => {
              await card.step("thread quiet, asking whether the goal is done", () =>
                card.nudge(completionCheckText(card.raw, stage.check, maxChecks)),
              );
              // Recorded outside the transcript: once this ask scrolls out of
              // the window a later tick must still see it, or the cap resets to
              // zero and the same question comes back forever.
              recordCompletionCheckAsked(card.threadId as string, stage.check);
            },
          }),
          rule<CompletionStage & { kind: "continue" }, BoardCard>({
            name: "the answer lists remaining work → sent back to finish it",
            id: "continue-active",
            when: atStage("continue", settings, maxChecks),
            do: async (card, stage) => {
              await card.step(
                `agent listed ${stage.remaining.length} remaining, sent back (check ${stage.check})`,
                () => card.nudge(continueText(stage.remaining, stage.check, maxChecks)),
              );
              recordCompletionCheckAsked(card.threadId as string, stage.check);
            },
          }),
          rule<CompletionStage & { kind: "waiting" }, BoardCard>({
            name: "the thread was asked and has not spoken yet",
            id: "completion-check",
            when: atStage("waiting", settings, maxChecks),
            // Saying nothing here is the point: the next heartbeat looks again,
            // and a thread that never answers reaches the judgment queue on its
            // own. But a silence nobody can read is not the same as a silence.
            do: (card) =>
              card.note(`rule completion-check: ${card.id} — asked, waiting on the thread`),
          }),
          // Three answers a rule cannot act on. They are the model's, and the
          // judgment queue already carries them — but a silence nobody can read
          // is not the same as a silence, so each says why it declined.
          rule<CompletionStage & { kind: "asking" }, BoardCard>({
            name: "the thread stopped to ask, so a decision is owed",
            id: "completion-check",
            when: atStage("asking", settings, maxChecks),
            do: (card, stage) =>
              card.note(
                `rule completion-check: ${card.id} needs a decision — the thread stopped to ask: ${stage.question}`,
              ),
          }),
          rule<CompletionStage & { kind: "blocked" }, BoardCard>({
            name: "the agent reported it is blocked",
            id: "completion-check",
            when: atStage("blocked", settings, maxChecks),
            do: (card, stage) =>
              card.note(
                `rule completion-check: ${card.id} needs a decision — agent is blocked: ${stage.reason}`,
              ),
          }),
          rule<CompletionStage & { kind: "exhausted" }, BoardCard>({
            name: "the check budget is spent and it is still not done",
            id: "completion-check",
            when: atStage("exhausted", settings, maxChecks),
            do: (card, stage) =>
              card.note(
                `rule completion-check: ${card.id} needs a decision — asked ${stage.checks} times and it is still not done`,
              ),
          }),
          rule<CompletionStage & { kind: "review" }, BoardCard>({
            name: "confirmed done → the review pass runs before the PR opens",
            id: "review-active",
            when: atStage("review", settings, maxChecks),
            do: (card) =>
              card.step("goal confirmed done, running the review pass", () =>
                card.nudge(reviewText(settings.hermesReviewPrompt)),
              ),
          }),
          rule<CompletionStage & { kind: "finish" }, BoardCard>({
            name: "the goal is done → the pull request opens",
            id: "finish-active",
            when: atStage("finish", settings, maxChecks),
            row: { trigger: "cardDone", action: "openPr" },
            do: async (card, stage) => {
              // An Active card that already has a pull request was sent back
              // here to fix something. `openPr` pushes onto the PR it already
              // has, so the same call that opens one closes that loop.
              const failure = await card.step(
                card.prUrl
                  ? "fix confirmed done, pushing it to the open pull request"
                  : "goal confirmed done, opening the pull request",
                async () => {
                  await card.openPr();
                },
              );
              if (failure === null) return;
              // A refused PR — nothing to commit, a guard hit — must not be
              // retried every heartbeat forever. It goes back to the thread as
              // another ask, and the check cap ends the loop at a card that
              // says "needs you".
              await card
                .nudge(prRefusedText(failure, stage.check, maxChecks))
                .catch(() =>
                  card.note(`rule finish-active: ${card.id} — could not tell the thread why`),
                );
              recordCompletionCheckAsked(card.threadId as string, stage.check);
            },
          }),
        ];

    const startThread = rule<void, BoardCard>({
      name: "a card arrives → a coding thread starts",
      id: "start-thread",
      when: arrives,
      unless: threaded,
      row: { trigger: "cardArrives", action: "startThread" },
      do: (card) => card.step("started a coding thread", () => card.startThread()),
    });

    // A card coming back from PR to fix red CI already has its thread; what it
    // lost is the worktree, which the reaper took when it left.
    const restoreWorktree = rule<void, BoardCard>({
      name: "a card coming back gets its workspace again",
      when: arrives,
      if: threaded,
      do: (card) => card.restoreWorktree(),
    });

    // Leaving ends the coding session, so the workspace has no owner. This was
    // a line inside KanbanStore.update, which meant the one behavior nobody
    // could see was the one that deleted things from disk.
    const releaseWorktree = rule<void, BoardCard>({
      name: "a card leaves → its workspace is released",
      when: leaves,
      if: threaded,
      do: (card) => card.releaseWorktree(),
    });

    return [requeueOrphans, startThread, restoreWorktree, releaseWorktree, ...completion];
  }

  if (id === "pr") {
    const fixRedChecks = rule<PrChecksSnapshot, BoardCard>({
      name: "CI goes red → back to Active carrying what broke",
      id: "pr-checks-red",
      when: checksRed,
      do: async (card, checks) => {
        const transcript = await card.transcript(COMPLETION_TRANSCRIPT_LIMIT);
        const fix = (transcript ? checksRedRounds(transcript) : 0) + 1;
        const names = checks.failing.map((entry) => entry.name).join(", ") || "a required check";

        // A check that fails the same way every round is not a loop to keep
        // running: the card stays in PR and is filed as a human's.
        if (fix > maxSyncs) {
          await card.needsHuman(
            `CI has gone red ${maxSyncs} times on this card's pull request and the ` +
              `thread could not get it green — still failing: ${names}`,
          );
          return;
        }

        await card.step(`PR checks failing (${names}), back to Active (fix ${fix})`, async () => {
          // The reaper took the worktree when the card left Active; the
          // thread is about to be told to fix something in it.
          await card.restoreWorktree();
          await card.sendBack(
            "active",
            checksRedText({ failing: checks.failing, prUrl: card.prUrl ?? null }, fix, maxSyncs),
          );
        });
      },
    });

    // Off is still in the list, and still says so. A behavior that vanishes
    // from the rules when it is disabled is a board that cannot tell you why
    // nothing happened.
    const mergeWhenGreen = [
      rule<PrChecksSnapshot, BoardCard>({
        name: "checks green → merge, then Archived",
        id: "mergeable-pr",
        when: checksGreen(graceMs),
        row: { trigger: "checksGreen", action: "mergePr" },
        do: async (card) => {
          if (!policy.mergeWhenGreen) {
            card.note(`rule mergeable-pr: ${card.id} — checks green, auto-merge is off`);
            return;
          }
          const outcome: { value: MergeOutcome | null } = { value: null };
          await card.step("PR open, merging", async () => {
            outcome.value = await card.mergeWithSync();
          });
          const result = outcome.value;
          if (result === null || result.merged) return;

          // A conflict the thread can reconcile is not a human's problem
          // yet. Attempting the merge is how the board finds out the base
          // collided, so the bounce happens here, logged as the rule it
          // belongs to.
          if (result.conflict && card.threadId) {
            await reconcile(card.as("pr-conflicts"), result.conflict);
            return;
          }
          if (result.reason !== null) await card.needsHuman(result.reason);
        },
      }),
    ];

    /** Hand a collided base back to the thread that wrote the code. */
    const reconcile = async (card: BoardCard, conflict: PrConflict): Promise<void> => {
      // A row with a known trigger and an action the pass cannot dispatch is a
      // rule the owner wrote and the board would silently ignore. Named here
      // instead — a rule that looks like it fires and never does is worse than
      // no rule at all.
      const unsupported = unsupportedRuleRows(settings, "pr", "prConflict", CONFLICT_ACTIONS);
      if (unsupported.length > 0) {
        await card.step("unsupported rule row", async () => {
          throw new Error(
            `the PR rule "when the base branch conflicts then ${unsupported[0]?.then}" ` +
              "is not something the rule pass can run — only moveTo is",
          );
        });
        return;
      }

      // The row is what says a collided base goes back. Drop it and the card is
      // a human's — filed as one rather than left silent.
      if (!policy.conflictReturn) {
        await card.needsHuman(
          `${conflict.baseBranch} conflicts with ${conflict.headBranch} and PR has no ` +
            "rule sending it back — resolve it yourself or add the rule",
        );
        return;
      }
      const target = ruleTarget(settings, "pr", "prConflict") ?? "active";
      const transcript = await card.transcript(COMPLETION_TRANSCRIPT_LIMIT);
      const sync = (transcript ? conflictRounds(transcript) : 0) + 1;
      if (sync > maxSyncs) {
        await card.needsHuman(
          `${conflict.baseBranch} has collided with this branch ${maxSyncs} times — ` +
            `still conflicting in ${conflict.files.join(", ") || "the merge"}`,
        );
        return;
      }
      await card.step(
        `${conflict.baseBranch} conflicts with ${conflict.headBranch}, back to ${target} (sync ${sync})`,
        () => card.sendBack(target, conflictText(conflict, sync, maxSyncs)),
      );
    };

    // A card dragged off a review panel arrives carrying its pull request;
    // there is nothing to push and the component adopts it.
    const openOnArrival = rule<void, BoardCard>({
      name: "a card arrives → the pull request opens",
      id: "open-pr",
      when: arrives,
      unless: pullRequested,
      row: { trigger: "cardArrives", action: "openPr" },
      do: (card) =>
        card.step("opened the pull request", async () => {
          await card.openPr();
        }),
    });

    return [openOnArrival, fixRedChecks, ...mergeWhenGreen];
  }

  // Archived runs nothing. It held a merge-on-arrival rule as a safety net for
  // a card that skipped PR, and that net became a hazard the moment arrivals
  // started running rules: the PR component merges and *then* moves the card
  // here, so the net fired on every ordinary merge and asked the forge to merge
  // a pull request that was already in. Merging is the PR component's job. A
  // card dragged straight here is being filed, which is what Archived means.
  if (id === "done") return [];

  return [];
}

/**
 * What every component this board has actually does, as lines.
 *
 * Generated from the same lists the tick dispatches, so the description cannot
 * drift from the behavior. The Hermes prompt used to carry this as prose —
 * "open PRs merged, stuck prep and orphaned Active cards were requeued" — which
 * a board that had switched any of it off silently contradicted, and which said
 * nothing at all about a component somebody added.
 */
export function describeComponents(
  ids: ReadonlyArray<ComponentId>,
  deps: ComponentDeps,
): ReadonlyArray<string> {
  const lines: Array<string> = [];
  for (const id of ids) {
    const built = componentFor(id, deps);
    const rules = built.rules ?? [];
    if (rules.length === 0) {
      lines.push(`- ${built.title} (${id}) — holds cards; no rules run here`);
      continue;
    }
    lines.push(`- ${built.title} (${id})`);
    for (const entry of rules) lines.push(`  - ${entry.name}`);
  }
  return lines;
}

/**
 * Every component the board is holding cards at, seeds first.
 *
 * Which ones exist is not a list anywhere — a component is a panel, and a card
 * carries the id it is sitting at. The seeds come first so an untouched board
 * reads in pipeline order, and anything else follows in the order it turns up.
 */
export function boardComponentIds(
  cards: ReadonlyArray<{ readonly at: string }>,
): ReadonlyArray<ComponentId> {
  const seen = new Set<string>(SEED_ORDER);
  const extra: Array<string> = [];
  for (const card of cards) {
    const id = card.at.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    extra.push(id);
  }
  return [...SEED_ORDER, ...extra];
}

/** The order the seed components read in. Not a schema — see `boardColumns.ts`. */
const SEED_ORDER: ReadonlyArray<string> = ["prompts", "active", "pr", "done"];

/** Every component and the rules it runs, for the dialog and anything else asking. */
export function componentRuleListing(
  ids: ReadonlyArray<ComponentId>,
  deps: ComponentDeps,
): ReadonlyArray<{
  readonly at: string;
  readonly title: string;
  readonly rules: ReadonlyArray<{ name: string; id: string | null; fromRow: boolean }>;
}> {
  return ids.map((id) => {
    const built = componentFor(id, deps);
    return {
      at: id,
      title: built.title,
      rules: (built.rules ?? []).map((entry) => ({
        name: entry.name,
        id: entry.id ?? null,
        fromRow: entry.row !== undefined,
      })),
    };
  });
}
