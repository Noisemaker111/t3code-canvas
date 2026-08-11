/**
 * Compatibility view for the former deterministic budget planner.
 *
 * Semantic task splitting, size classification, thread placement and model
 * selection now belong exclusively to Hermes's routing skills. This module
 * deliberately returns no executable tasks; budget data remains available as
 * measurements used to build compact RoutingBrief route facts.
 *
 * @module kanban/budget/plan
 */
import type { HermesBudgetKnobs, HermesBudgetPlan, HermesSessionFloor } from "@t3tools/contracts";

import type { PriceRow, TurnSample } from "./measurements.ts";
import type { ShadowPrice } from "./shadowPrice.ts";

export type PlanThread = {
  readonly threadId: string;
  readonly cardId: string | null;
  readonly title: string;
  readonly tail: string;
  readonly usedTokens: number | null;
  readonly usedPercentage: number | null;
  readonly idleForMs: number | null;
  readonly instanceId: string | null;
  readonly model: string | null;
};

export type PlanHarness = {
  readonly instanceId: string;
  readonly model: string;
  readonly name: string;
  readonly usable: boolean;
  readonly subscription: boolean;
  readonly price: PriceRow;
  readonly costTier: number | null;
  readonly floor: HermesSessionFloor;
  readonly medianOutputTokens: number | null;
  readonly quotaUtilization: number | null;
  readonly shadowPrice?: ShadowPrice | null;
  readonly codingScore?: number | null;
  readonly staminaCeilingPercent?: number | null;
};

export type PlanInput = {
  readonly text: string;
  readonly knobs: HermesBudgetKnobs;
  readonly threads: ReadonlyArray<PlanThread>;
  readonly harnesses: ReadonlyArray<PlanHarness>;
  readonly samples: ReadonlyArray<TurnSample>;
  readonly now: string;
};

/**
 * Kept for status/RPC compatibility. It cannot split prose, classify task size,
 * choose a model, or propose thread reuse.
 */
export function buildBudgetPlan(input: PlanInput): HermesBudgetPlan {
  const unknowns = [
    "Semantic budget routing retired: Hermes selects execution from compact measured route facts.",
  ];
  return {
    createdAt: input.now,
    position: input.knobs.position,
    knobs: input.knobs,
    tasks: [],
    totals: {
      sessionFloorTokens: null,
      promptTokens: 0,
      chargedInputTokens: null,
      cachedInputTokens: null,
      expectedOutputTokens: null,
      usd: null,
      quotaFraction: null,
      basis: unknowns,
    },
    unknowns,
    summary: "Routing is decided semantically by Hermes.",
  };
}

/** Human-readable status view. This formats measurements only; it never routes work. */
export function formatBudgetPlan(plan: HermesBudgetPlan): string {
  const lines = [
    `budget plan · position ${plan.position} · ${plan.summary}`,
    ...plan.tasks.map((task) => {
      const where =
        task.placement.kind === "reuse"
          ? `reuse thread ${task.placement.threadId} (${task.placement.reason})`
          : `new thread (${task.placement.reason})`;
      const who = task.harness
        ? `${task.harness.instanceId}/${task.harness.model} [${task.harness.costBasis}] ${task.harness.reason}`
        : "no harness";
      const cost =
        task.estimate.usd === null
          ? task.estimate.chargedInputTokens === null
            ? "cost unknown"
            : `${task.estimate.chargedInputTokens} charged tok`
          : `$${task.estimate.usd.toFixed(4)}`;
      return [
        `  ${task.index + 1}. [${task.size}] ${task.title}`,
        `     ${where}`,
        `     ${who}`,
        `     ${cost} · ${task.estimate.basis.join("; ")}`,
      ].join("\n");
    }),
    ...(plan.unknowns.length > 0 ? [`  unknown: ${plan.unknowns.join("; ")}`] : []),
  ];
  return lines.join("\n");
}
