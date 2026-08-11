/**
 * Compact, evidence-only facts for Hermes routing.
 *
 * Raw provider resources, price tables, benchmark snapshots and turn histories
 * terminate here. Hermes receives percentages and small measured facts, with
 * unknowns preserved instead of model-name or price-tier guesses.
 */
import type {
  HermesCapacityPool,
  HermesRouteCapability,
  HermesRouteSpeed,
  HermesTaskUsageEstimate,
} from "@t3tools/contracts";
import { usageProviderIdForInstance } from "@t3tools/shared/providerFamily";

import type { UsageResponse, UsageResource } from "../../usage/UsageService.ts";
import type { ModelCapabilityEntry } from "../ModelCapabilityCatalog.ts";
import type { TurnSample } from "../budget/measurements.ts";
import { median } from "../budget/measurements.ts";
import { isSubscriptionHarness } from "../budget/pricing.ts";

function utilization(resource: UsageResource): number | null {
  if (typeof resource.utilization === "number" && Number.isFinite(resource.utilization)) {
    return Math.max(0, Math.min(1, resource.utilization));
  }
  if (
    typeof resource.used === "number" &&
    typeof resource.limit === "number" &&
    resource.limit > 0
  ) {
    return Math.max(0, Math.min(1, resource.used / resource.limit));
  }
  if (
    resource.kind === "balance" &&
    typeof resource.available === "number" &&
    typeof resource.limit === "number" &&
    resource.limit > 0
  ) {
    return Math.max(0, Math.min(1, 1 - resource.available / resource.limit));
  }
  return null;
}

function dollars(resource: UsageResource): number | null {
  if (resource.kind !== "balance") return null;
  if (typeof resource.available === "number" && Number.isFinite(resource.available)) {
    return Math.max(0, resource.available);
  }
  return null;
}

/** The binding capacity window for one route, expressed in the currency the user owns. */
export function capacityPoolForRoute(
  instanceId: string,
  usage: UsageResponse | null,
): HermesCapacityPool {
  const family = usageProviderIdForInstance(instanceId);
  const provider = usage?.providers[family];
  const windows = Object.entries(provider?.resources ?? {})
    .map(([id, resource]) => ({ id, resource, utilization: utilization(resource) }))
    .filter(
      (entry): entry is { id: string; resource: UsageResource; utilization: number } =>
        entry.utilization !== null,
    )
    .toSorted((left, right) => right.utilization - left.utilization);
  const binding = windows[0] ?? null;
  const balance =
    Object.values(provider?.resources ?? {})
      .map(dollars)
      .find((value): value is number => value !== null) ?? null;
  const subscription = isSubscriptionHarness(instanceId);

  return {
    id: family,
    billing: subscription ? "subscription" : "metered",
    remainingPercent:
      binding === null ? null : Math.round(Math.max(0, 1 - binding.utilization) * 100),
    resetsAt: binding?.resource.resetsAt ?? null,
    balanceUsd: subscription ? null : balance,
    confidence: binding === null && balance === null ? "unknown" : "measured",
    detail:
      binding === null
        ? provider?.stale
          ? "usage snapshot is stale"
          : "provider does not report a bounded allowance"
        : `${binding.id} is the binding allowance`,
  };
}

export function routeCapability(capability: ModelCapabilityEntry | null): HermesRouteCapability {
  const sources = Object.entries(capability?.sources ?? {}).map(
    ([axis, source]) => `${axis}=${source}`,
  );
  return {
    coding: capability?.scores.coding ?? null,
    it: capability?.scores.it ?? null,
    design: capability?.scores.design ?? null,
    planning: capability?.scores.planning ?? null,
    effectiveContextTokens: capability?.effectiveContextTokens ?? null,
    source: sources.length > 0 ? sources.join(" ") : null,
  };
}

/**
 * Speed for this exact harness/model, measured two ways because they answer
 * different questions. `tokensPerSecond` is how fast the route emits;
 * `medianTurnMs` is how long a turn takes. Neither says the job finished
 * sooner — `taskCost.msPerTask` does. Model-name adjectives never enter any of
 * them.
 */
export function routeSpeed(
  samples: ReadonlyArray<TurnSample>,
  instanceId: string,
  model: string,
): HermesRouteSpeed {
  const matching = samples.filter(
    (sample) =>
      sample.harness === instanceId && sample.model === model && sample.durationMs !== null,
  );
  // A turn that emitted nothing measures latency, not throughput; dividing it
  // in would read as a slow model rather than a short answer.
  const rates = matching
    .filter((sample) => (sample.outputTokens ?? 0) > 0 && (sample.durationMs ?? 0) > 0)
    .map((sample) => (sample.outputTokens as number) / ((sample.durationMs as number) / 1000));
  const tokensPerSecond = median(rates);
  return {
    medianTurnMs: median(
      matching
        .map((sample) => sample.durationMs)
        .filter((value): value is number => value !== null),
    ),
    sampleCount: matching.length,
    tokensPerSecond: tokensPerSecond === null ? null : Math.round(tokensPerSecond * 10) / 10,
    throughputSamples: rates.length,
  };
}

export type LearnedUsageSample = {
  readonly routeId: string;
  readonly observedPercent: number;
};

/**
 * Only observed percentage samples may produce a percentage estimate. Until
 * enough exist, "unknown" is cheaper and safer than fake precision.
 */
export function taskUsageEstimate(
  routeId: string,
  samples: ReadonlyArray<LearnedUsageSample>,
): HermesTaskUsageEstimate {
  const values = samples
    .filter((sample) => sample.routeId === routeId)
    .map((sample) => sample.observedPercent)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .toSorted((a, b) => a - b);
  if (values.length < 3) {
    return {
      lowPercent: null,
      likelyPercent: null,
      highPercent: null,
      confidence: "unknown",
      basis:
        values.length === 0
          ? "no comparable tasks observed"
          : `only ${values.length} comparable task(s)`,
    };
  }
  const at = (fraction: number) =>
    values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * fraction)))] ??
    null;
  return {
    lowPercent: at(0.2),
    likelyPercent: at(0.5),
    highPercent: at(0.8),
    confidence: values.length >= 10 ? "learned" : "estimated",
    basis: `${values.length} observed tasks on this exact route`,
  };
}
