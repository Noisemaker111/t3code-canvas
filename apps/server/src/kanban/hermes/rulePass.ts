/**
 * The deterministic half of a tick: every board move that has no judgment in
 * it, done before a token is spent.
 *
 * A rule here must be one a reader can check by eye — "a Prompt marked ready
 * with a project launches" — not a heuristic. Anything that needs taste (what a
 * raw Prompt means, which project, what to say in a nudge) stays with the model
 * and shows up in the judgment queue instead.
 *
 * @module kanban/hermes/rulePass
 */
import type { BoardSettings, KanbanCard, ComponentId } from "@t3tools/contracts";
import { boardRulePolicy, unsupportedRuleRows } from "@t3tools/shared/boardRules";

import { dispatch } from "@t3tools/shared/board";

import { boardCard, type PassRecorder } from "../components/card.ts";
import { componentFor } from "../components/seed.ts";
import { getUsageService } from "../../usage/UsageService.ts";
import type { BoardApi, BoardPrSyncConflict } from "./boardApi.ts";
import { capacityPoolForRoute } from "./routeFacts.ts";
import { finishRoutingUsageObservation } from "./routingUsageStore.ts";
import { sweepWatchedIssues } from "./issueWatch.ts";

export type RuleAction = {
  /** Which rule fired. Rendered in the tick log. */
  readonly rule:
    | "stuck-prep"
    | "orphaned-active"
    | "watch-issues"
    | "completion-check"
    | "continue-active"
    | "review-active"
    | "finish-active"
    | "mergeable-pr"
    | "pr-checks-red"
    | "pr-conflicts"
    | "card-stalled";
  readonly cardId: string;
  readonly detail: string;
  readonly ok: boolean;
};

export type RulePassResult = {
  readonly actions: ReadonlyArray<RuleAction>;
  readonly logs: ReadonlyArray<string>;
  /** PRs the sync-and-retry dance could not merge. Only a human resolves these. */
  readonly conflicts: ReadonlyArray<{ readonly cardId: string; readonly reason: string }>;
  /** Ready Prompts held back because work in the same area is already running. */
  readonly holds: ReadonlyArray<{ readonly cardId: string; readonly reason: string }>;
};

export type RulePolicy = {
  readonly launchPrompts: boolean;
  readonly stuckPrepMs: number;
  readonly autoFinishActive: boolean;
  readonly autoMergeWhenGreen: boolean;
  /** A collided base sends the card back to its thread. */
  readonly conflictReturn: boolean;
  /** How long a card may sit untouched in one column before `cardStalled` fires. */
  readonly stalledCardMs: number;
  /** How long a PR with no check runs yet is left alone before it counts as checkless. */
  readonly prCheckGraceMs: number;
  /** How many times one Active thread may be asked whether it is done. */
  readonly maxChecks: number;
  /** Bounces of one card's own merge conflict before it needs a human. */
  readonly maxSyncs: number;
  readonly review: { readonly enabled: boolean; readonly prompt: string };
  readonly helpers: {
    readonly enabled: boolean;
    readonly maxConcurrent: number;
    readonly timeoutMs: number;
  };
};

const MIN_STUCK_PREP_MS = 30_000;

/** Used when the setting is missing or unreadable. GitHub registers runs slower than this often enough. */
const DEFAULT_PR_CHECK_GRACE_MS = 600_000;

/** A helper that has not answered in this long is not going to. */
const MIN_HELPER_TIMEOUT_MS = 60_000;

/** Below this a card is "stalled" while an agent is merely thinking. */
const MIN_STALLED_CARD_MS = 300_000;
const DEFAULT_STALLED_CARD_MS = 1_800_000;

/** What a `cardStalled` row may do. Anything else is named in the tick log. */
const STALLED_ACTIONS = ["moveTo"];

export function rulePolicy(settings: BoardSettings): RulePolicy {
  const rules = boardRulePolicy(settings);
  return {
    launchPrompts: rules.launchPrompts,
    stuckPrepMs: Math.max(MIN_STUCK_PREP_MS, settings.hermesStuckPrepMs),
    autoFinishActive: rules.finishActive,
    autoMergeWhenGreen: rules.mergeWhenGreen,
    conflictReturn: rules.conflictReturn,
    stalledCardMs: Math.max(
      MIN_STALLED_CARD_MS,
      Number.isFinite(settings.hermesStalledCardMs)
        ? settings.hermesStalledCardMs
        : DEFAULT_STALLED_CARD_MS,
    ),
    prCheckGraceMs: Math.max(
      0,
      Number.isFinite(settings.hermesPrCheckGraceMs)
        ? settings.hermesPrCheckGraceMs
        : DEFAULT_PR_CHECK_GRACE_MS,
    ),
    maxChecks: Math.max(1, Math.floor(settings.hermesCompletionMaxChecks)),
    maxSyncs: Math.max(1, settings.hermesBrainMaxNudges),
    review: {
      enabled: settings.hermesReviewPassEnabled,
      prompt: settings.hermesReviewPrompt,
    },
    helpers: {
      enabled: settings.hermesHelpersEnabled,
      maxConcurrent: Math.max(0, settings.hermesHelperMaxConcurrent),
      timeoutMs: Math.max(MIN_HELPER_TIMEOUT_MS, settings.hermesHelperTimeoutMs),
    },
  };
}

const UNMERGEABLE = /not mergeable|un-?mergeable|conflict|behind|out of date|dirty/i;

/**
 * Run every rule that needs no model. Writes go through the same `BoardApi` the
 * programs use, so a dry run records them and writes nothing.
 */
export async function runRulePass(input: {
  readonly api: BoardApi;
  readonly settings: BoardSettings;
  readonly recordOnly?: boolean;
  readonly now?: () => number;
}): Promise<RulePassResult> {
  const { api, settings } = input;
  const policy = rulePolicy(settings);
  const recordOnly = input.recordOnly === true;
  const nowMs = (input.now ?? (() => Date.now()))();
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);

  const actions: RuleAction[] = [];
  const logs: string[] = [];
  const conflicts: Array<{ cardId: string; reason: string }> = [];
  const holds: Array<{ cardId: string; reason: string }> = [];
  /** Columns whose broken `cardStalled` row has already been reported this pass. */
  const reported = new Set<string>();

  /** Names the rule whose `do` is running, so its writes log under it. */
  let running = "";

  /** Null when the write landed; the failure text otherwise. */
  const act = async (
    rule: string,
    cardId: string,
    detail: string,
    write: () => Promise<void>,
  ): Promise<string | null> => {
    logs.push(`rule ${rule}: ${cardId} — ${detail}`);
    if (recordOnly) {
      actions.push({ rule: rule as RuleAction["rule"], cardId, detail, ok: true });
      return null;
    }
    try {
      await write();
      actions.push({ rule: rule as RuleAction["rule"], cardId, detail, ok: true });
      return null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logs.push(`rule ${rule} failed on ${cardId}: ${message}`);
      actions.push({ rule: rule as RuleAction["rule"], cardId, detail: message, ok: false });
      return message;
    }
  };

  for (const card of cards) {
    const id = card.id as string;
    if (card.archivedAt) continue;

    // A row this build cannot dispatch is named rather than skipped: a rule
    // that looks like it fires and never does is worse than no rule.
    if (reportUnsupported({ settings, card, act, reported })) continue;

    const recorder: PassRecorder = {
      logs,
      needsHuman: conflicts,
      step: (ruleId, detail, write) => act(ruleId, id, detail, write),
    };

    const handle = boardCard({
      card,
      api,
      recorder,
      nowMs,
      ruleId: () => running,
      merge: (cardId) => mergeCard(api, cardId, { recordOnly }),
    });

    const component = componentFor(card.at, {
      settings,
      policy: {
        finishActive: policy.autoFinishActive,
        mergeWhenGreen: policy.autoMergeWhenGreen,
        conflictReturn: policy.conflictReturn,
      },
    });

    await dispatch({
      card: handle,
      component,
      moment: "tick",
      // Naming the rule before its `do` runs is what lets a rule's writes be
      // logged under it without every rule having to repeat its own name.
      onRun: (entry) => {
        running = entry.id ?? entry.name;
      },
    });
  }

  for (const conflict of conflicts) {
    logs.push(`rule mergeable-pr: ${conflict.cardId} needs you — ${conflict.reason}`);
  }

  if (settings.hermesWatchIssues) {
    const watched = await sweepWatchedIssues({
      api,
      cards,
      label: settings.hermesWatchIssuesLabel,
      recordOnly,
      nowMs,
    }).catch((cause: unknown) => {
      logs.push(
        `rule watch-issues: sweep failed — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return [];
    });
    for (const entry of watched) {
      logs.push(`rule watch-issues: ${entry.log}`);
      actions.push({ rule: "watch-issues", cardId: entry.title, detail: entry.log, ok: true });
    }
  }

  return { actions, logs, conflicts, holds };
}

/**
 * Report a `cardStalled` row whose action this build cannot run.
 *
 * The row is the column's, not the card's — said once per column per pass.
 */
function reportUnsupported(input: {
  readonly settings: BoardSettings;
  readonly card: KanbanCard;
  readonly act: (
    rule: string,
    cardId: string,
    detail: string,
    write: () => Promise<void>,
  ) => Promise<string | null>;
  readonly reported: Set<string>;
}): boolean {
  const column = input.card.at as ComponentId;
  const unsupported = unsupportedRuleRows(input.settings, column, "cardStalled", STALLED_ACTIONS);
  if (unsupported.length === 0) return false;
  if (input.reported.has(column)) return false;
  input.reported.add(column);
  void input.act("card-stalled", input.card.id as string, "unsupported rule row", async () => {
    throw new Error(
      `the ${column} rule "when the card sits here untouched then ${unsupported[0]?.then}" ` +
        "is not something the rule pass can run — only moveTo is",
    );
  });
  return false;
}

export type FinishCardResult = {
  readonly prUrl: string | null;
  readonly merged: boolean;
  readonly reason: string | null;
  /** Set when the base branch collided with the card's own work. */
  readonly conflict: BoardPrSyncConflict | null;
};

/**
 * Open the card's pull request. It never merges: merging is gated on the
 * forge's checks, and those do not exist yet a second after the PR is opened.
 * A later tick's `mergeable-pr` rule reads them and merges.
 */
export async function finishCard(
  api: BoardApi,
  id: string,
  options: { readonly recordOnly?: boolean } = {},
): Promise<FinishCardResult> {
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  const card = cards.find((entry) => entry.id === id);
  if (!card) return { prUrl: null, merged: false, reason: `card '${id}' is gone`, conflict: null };

  if (card.at === "done") {
    return { prUrl: card.prUrl ?? null, merged: true, reason: null, conflict: null };
  }
  if (card.at === "pr") {
    return { prUrl: card.prUrl ?? null, merged: false, reason: null, conflict: null };
  }

  const opened = await api.openPr({ id });
  if (options.recordOnly === true) {
    return { prUrl: card.prUrl ?? null, merged: false, reason: null, conflict: null };
  }
  const prUrl = opened.prUrl ?? card.prUrl ?? null;
  if (!prUrl) {
    return { prUrl: null, merged: false, reason: "openPr returned no PR", conflict: null };
  }
  if (card.modelSelection) {
    const instanceId = String(card.modelSelection.instanceId);
    const usage = await getUsageService()
      .getUsageSafe()
      .catch(() => null);
    finishRoutingUsageObservation({
      cardId: card.id as string,
      pool: capacityPoolForRoute(instanceId, usage),
    });
  }
  return { prUrl, merged: false, reason: null, conflict: null };
}

/**
 * mergePr → syncPrBranch on an un-mergeable merge → one retry. Only the
 * check-gated `mergeable-pr` rule calls it, so no other path can merge a pull
 * request the forge has not passed.
 */
export async function mergeCard(
  api: BoardApi,
  id: string,
  options: { readonly recordOnly?: boolean } = {},
): Promise<FinishCardResult> {
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  const card = cards.find((entry) => entry.id === id);
  if (!card) return { prUrl: null, merged: false, reason: `card '${id}' is gone`, conflict: null };

  const prUrl = card.prUrl ?? null;
  if (card.at === "done") return { prUrl, merged: true, reason: null, conflict: null };
  if (!prUrl) {
    return {
      prUrl: null,
      merged: false,
      reason: `card '${id}' has no pull request`,
      conflict: null,
    };
  }
  // A dry run's writes resolve to a stub, so there is nothing to merge.
  if (options.recordOnly === true) return { prUrl, merged: false, reason: null, conflict: null };

  const first = await api.mergePr({ id });
  if (first.merged) return { prUrl, merged: true, reason: null, conflict: null };
  if (first.reason === null || !UNMERGEABLE.test(first.reason)) {
    return { prUrl, merged: false, reason: first.reason, conflict: null };
  }

  const synced = await api.syncPrBranch({ id });
  if (!synced.synced) {
    return {
      prUrl,
      merged: false,
      reason: synced.reason ?? first.reason,
      conflict: synced.conflict ?? null,
    };
  }
  const second = await api.mergePr({ id });
  return {
    prUrl,
    merged: second.merged,
    reason: second.merged ? null : second.reason,
    conflict: null,
  };
}
