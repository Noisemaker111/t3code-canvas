/**
 * The budget pass a tick runs before it spends anything: refresh the measured
 * table, close last tick's predicted-vs-actual, and plan every raw Draft.
 *
 * Only runs while `boardSettings.hermesBudgetRoutingEnabled` is on. Off, a tick
 * behaves exactly as it did before.
 *
 * @module kanban/budget/tickPass
 */
import type {
  HermesBudgetPlan,
  HermesPlanEstimate,
  HermesTickBudget,
  KanbanCard,
} from "@t3tools/contracts";

import {
  buildPlanForText,
  recordBudgetDrift,
  refreshBudgetMeasurements,
  type BudgetDeps,
} from "./BudgetService.ts";
import { readBudgetStore } from "./budgetStore.ts";
import { sumEstimates } from "./measurements.ts";

/** Plans are per Draft; a board full of them should not make one tick unbounded. */
const MAX_PLANNED_DRAFTS = 5;

/** What the previous tick predicted, still waiting for turns to bill against it. */
let pending: { at: string; estimate: HermesPlanEstimate } | null = null;

/** Charged input actually observed on turns that started after `sinceIso`. */
export function actualSince(sinceIso: string): HermesPlanEstimate | null {
  const rows = readBudgetStore().samples.filter((sample) => sample.at > sinceIso);
  if (rows.length === 0) return null;
  const charged = rows.reduce(
    (sum, sample) => sum + Math.max(0, (sample.inputTokens ?? 0) - (sample.cachedInputTokens ?? 0)),
    0,
  );
  const cached = rows.reduce((sum, sample) => sum + (sample.cachedInputTokens ?? 0), 0);
  const output = rows.reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0);
  return {
    sessionFloorTokens: null,
    promptTokens: 0,
    chargedInputTokens: charged,
    cachedInputTokens: cached,
    expectedOutputTokens: output,
    usd: null,
    quotaFraction: null,
    basis: [`observed ${rows.length} turn${rows.length === 1 ? "" : "s"} since the last plan`],
  };
}

export type BudgetTickOutcome = {
  readonly plans: ReadonlyArray<{ cardId: string; plan: HermesBudgetPlan }>;
  readonly budget: HermesTickBudget;
};

export async function runBudgetTickPass(input: {
  readonly deps: BudgetDeps;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly now: string;
  readonly recordOnly: boolean;
}): Promise<BudgetTickOutcome> {
  await refreshBudgetMeasurements(input.deps).catch(() => ({ threads: 0, samples: 0 }));

  let driftPercent: number | null = null;
  let actual: HermesPlanEstimate | null = null;
  if (pending) {
    actual = actualSince(pending.at);
    if (!input.recordOnly) {
      driftPercent = recordBudgetDrift({ at: input.now, estimate: pending.estimate, actual });
    }
  }

  const drafts = input.cards
    .filter((card) => card.at === "prompts" && card.archivedAt === null && card.body.trim())
    .slice(0, MAX_PLANNED_DRAFTS);
  const plans = await Promise.all(
    drafts.map(async (card) => ({
      cardId: String(card.id),
      plan: await buildPlanForText(input.deps, card.body),
    })),
  );

  const estimate = sumEstimates(plans.map((entry) => entry.plan.totals));
  if (!input.recordOnly) pending = { at: input.now, estimate };

  return {
    plans,
    budget: {
      plannedTasks: plans.reduce((sum, entry) => sum + entry.plan.tasks.length, 0),
      estimate,
      actual,
      driftPercent,
    },
  };
}
