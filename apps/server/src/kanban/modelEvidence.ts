/**
 * One assembler for the sourced facts about a route: benchmark score from the
 * capability snapshot, median turn from observed turns, price and measured cost
 * tier from the price catalog, and the binding capacity window.
 *
 * Every consumer that would otherwise reach for a model name reads this
 * instead — the MCP model block, the settings roster, and Hermes's routing
 * brief all describe the same route the same way. Unknown stays unknown.
 *
 * @module kanban/modelEvidence
 */
import {
  CAPABILITY_AXES,
  capabilityForModel,
  getModelCapabilityCatalog,
  type CapabilityAxis,
} from "./ModelCapabilityCatalog.ts";
import { getModelPriceCatalog } from "./ModelPriceCatalog.ts";
import { readBudgetStore } from "./budget/budgetStore.ts";
import { isSubscriptionHarness, priceForHarness } from "./budget/pricing.ts";
import { taskCostFrom } from "./budget/measurements.ts";
import { capacityPoolForRoute, routeSpeed, taskUsageEstimate } from "./hermes/routeFacts.ts";
import { routingUsageSamples } from "./hermes/routingUsageStore.ts";
import { cachedMeasuredCostTiers } from "./budget/BudgetService.ts";
import { measuredCostKey, tierFor } from "./ModelRouting.ts";
import type { ModelEvidenceIndex } from "./ModelRouting.ts";
import { getUsageService } from "../usage/UsageService.ts";

export type ModelRoute = { readonly instanceId: string; readonly model: string };

const axisScores = (
  capability: { scores: Readonly<Record<CapabilityAxis, number | null>> } | null,
): Readonly<Record<CapabilityAxis, number | null>> =>
  capability?.scores ?? { coding: null, it: null, design: null, planning: null };

const joinSources = (
  capability: { sources: Readonly<Partial<Record<CapabilityAxis, string>>> } | null,
): string | null => {
  const named = CAPABILITY_AXES.filter((axis) => capability?.sources[axis]).map(
    (axis) => `${axis}=${capability?.sources[axis]}`,
  );
  return named.length > 0 ? named.join(" ") : null;
};

/** Capability + speed only — what the MCP model block and the roster row share. */
export async function modelEvidenceIndex(
  routes: ReadonlyArray<ModelRoute>,
): Promise<ModelEvidenceIndex> {
  const capabilities = await getModelCapabilityCatalog().catch(() => null);
  const samples = readBudgetStore().samples;
  return new Map(
    routes.map((route) => {
      const capability = capabilityForModel(capabilities, route.model);
      const speed = routeSpeed(samples, route.instanceId, route.model);
      return [
        measuredCostKey(route.instanceId, route.model),
        {
          scores: axisScores(capability),
          benchSource: joinSources(capability),
          medianTurnMs: speed.medianTurnMs,
          sampleCount: speed.sampleCount,
          tokensPerSecond: speed.tokensPerSecond,
          throughputSamples: speed.throughputSamples,
        },
      ];
    }),
  );
}

export type ModelRouteFacts = {
  readonly instanceId: string;
  readonly model: string;
  readonly scores: Readonly<Record<CapabilityAxis, number | null>>;
  readonly benchSource: string | null;
  readonly benchFetchedAt: string | null;
  readonly effectiveContextTokens: number | null;
  readonly medianTurnMs: number | null;
  readonly speedSamples: number;
  /**
   * Observed output tokens per second. How fast the route emits — not whether
   * it finishes sooner, which is {@link ModelRouteFacts.msPerTask}, or for less,
   * which is {@link ModelRouteFacts.relativeCost}.
   */
  readonly tokensPerSecond: number | null;
  readonly throughputSamples: number;
  readonly costTier: number;
  readonly costBasis: "measured" | "unmeasured";
  readonly billing: "subscription" | "metered";
  readonly usdPerMTokIn: number | null;
  readonly usdPerMTokOut: number | null;
  readonly priceSource: string;
  readonly remainingPercent: number | null;
  readonly usagePercent: number | null;
  readonly usageConfidence: string;
  readonly usageBasis: string;
  /**
   * Cost of one task on this route against the cheapest measured route on the
   * roster, which is 1. This is the number to compare on: nearly all spend here
   * is plan quota, so the dollars behind it are a yardstick, not a bill — and a
   * cheaper-per-token model that needs more turns lands above a dearer one.
   */
  readonly relativeCost: number | null;
  /** Median cost of one whole task on this route, from observed turns. */
  readonly usdPerTask: number | null;
  /** Median wall-clock of one whole task, summed over its turns. */
  readonly msPerTask: number | null;
  readonly usdPerTaskBasis: "metered" | "list-price" | "unknown";
  readonly usdPerTaskDetail: string;
  readonly taskCount: number;
};

/**
 * Cost against the cheapest measured route on this roster. One route, or none
 * priced, leaves it null — a ratio to itself says nothing.
 */
export function relativeTo(
  rows: ReadonlyArray<{ readonly usdPerTask: number | null }>,
  usdPerTask: number | null,
): number | null {
  if (usdPerTask === null) return null;
  const priced = rows
    .map((row) => row.usdPerTask)
    .filter((value): value is number => value !== null && value > 0);
  if (priced.length < 2) return null;
  const cheapest = Math.min(...priced);
  return Math.round((usdPerTask / cheapest) * 10) / 10;
}

/** The full row a settings surface renders. Same sources, nothing added. */
export async function modelRouteFacts(
  routes: ReadonlyArray<ModelRoute>,
): Promise<ReadonlyArray<ModelRouteFacts>> {
  const [capabilities, prices, usage] = await Promise.all([
    getModelCapabilityCatalog().catch(() => null),
    getModelPriceCatalog().catch(() => new Map()),
    getUsageService().getUsageSafe(),
  ]);
  const samples = readBudgetStore().samples;
  const learned = routingUsageSamples();
  const tiers = cachedMeasuredCostTiers();

  const rows = routes.map((route) => {
    const capability = capabilityForModel(capabilities, route.model);
    const speed = routeSpeed(samples, route.instanceId, route.model);
    const priced = tierFor(route, tiers);
    const price = priceForHarness({
      instanceId: route.instanceId,
      model: route.model,
      byId: prices,
    });
    const capacity = capacityPoolForRoute(route.instanceId, usage);
    const task = taskUsageEstimate(`${route.instanceId}/${route.model}`, learned);
    const subscription = isSubscriptionHarness(route.instanceId);
    const cost = taskCostFrom({
      samples,
      harness: route.instanceId,
      model: route.model,
      price,
      subscription,
    });
    return {
      instanceId: route.instanceId,
      model: route.model,
      scores: axisScores(capability),
      benchSource: joinSources(capability),
      benchFetchedAt: capability?.fetchedAt ?? null,
      effectiveContextTokens: capability?.effectiveContextTokens ?? null,
      medianTurnMs: speed.medianTurnMs,
      speedSamples: speed.sampleCount,
      tokensPerSecond: speed.tokensPerSecond,
      throughputSamples: speed.throughputSamples,
      costTier: priced.tier,
      costBasis: priced.basis,
      billing: (subscription ? "subscription" : "metered") as "subscription" | "metered",
      usdPerMTokIn: price.usdPerMTokIn,
      usdPerMTokOut: price.usdPerMTokOut,
      priceSource: price.source,
      remainingPercent: capacity.remainingPercent,
      usagePercent: task.likelyPercent,
      usageConfidence: task.confidence,
      usageBasis: task.basis,
      usdPerTask: cost.usdPerTask,
      msPerTask: cost.msPerTask,
      usdPerTaskBasis: cost.basis,
      usdPerTaskDetail: cost.detail,
      taskCount: cost.taskCount,
    };
  });

  return rows.map((row) => ({ ...row, relativeCost: relativeTo(rows, row.usdPerTask) }));
}
