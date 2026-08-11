/**
 * Client for `/api/models/facts` — the sourced facts behind every roster row.
 *
 * Benchmark score, price, observed speed and learned usage come from the same
 * assembler the router reads, so the roster can never describe a model in terms
 * the router does not use. `null` means nothing measured it; the UI says so.
 */
import { useEffect, useState } from "react";

/** Kept in step with `CAPABILITY_AXES` on the server; the row renders this order. */
export const CAPABILITY_AXES = ["coding", "it", "design", "planning"] as const;
export type CapabilityAxis = (typeof CAPABILITY_AXES)[number];

/** What each axis is called on a settings row, where "it" alone reads as a typo. */
export const AXIS_LABEL: Record<CapabilityAxis, string> = {
  coding: "code",
  it: "ops",
  design: "design",
  planning: "plan",
};

export type ModelRouteFacts = {
  readonly instanceId: string;
  readonly model: string;
  readonly scores: Readonly<Record<CapabilityAxis, number | null>>;
  readonly benchSource: string | null;
  readonly benchFetchedAt: string | null;
  readonly effectiveContextTokens: number | null;
  readonly medianTurnMs: number | null;
  readonly speedSamples: number;
  /** Observed output tokens per second. Emission speed, nothing more. */
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
  readonly relativeCost: number | null;
  readonly usdPerTask: number | null;
  /** Median wall-clock of one whole task. The only "is it quicker" number. */
  readonly msPerTask: number | null;
  readonly usdPerTaskBasis: "metered" | "list-price" | "unknown";
  readonly usdPerTaskDetail: string;
  readonly taskCount: number;
};

export const routeFactsKey = (instanceId: string, model: string): string =>
  `${instanceId}::${model}`;

export async function fetchModelRouteFacts(): Promise<ReadonlyArray<ModelRouteFacts>> {
  const response = await fetch("/api/models/facts", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`GET /api/models/facts failed (${response.status})`);
  const body = (await response.json()) as { facts?: ReadonlyArray<ModelRouteFacts> };
  return body.facts ?? [];
}

/**
 * The one read of `/api/models/facts` in the app. Every surface that describes
 * a model — the roster row, the picker row — shares this map, so none of them
 * can start describing a route in terms the router does not measure.
 */
export function useModelRouteFacts(): ReadonlyMap<string, ModelRouteFacts> {
  const [facts, setFacts] = useState<ReadonlyMap<string, ModelRouteFacts>>(new Map());
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await fetchModelRouteFacts();
        if (!live) return;
        setFacts(new Map(rows.map((row) => [routeFactsKey(row.instanceId, row.model), row])));
      } catch {
        // A failed read must not invent facts; every row keeps saying "unknown".
        if (live) setFacts(new Map());
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return facts;
}

/**
 * One chip per benchmarked axis, and a single "bench unknown" when no feed has
 * scored this model at all. Scales differ per axis, so a chip always names its
 * axis — `code 89.1` and `design 1382` are not on the same ruler.
 */
export function axisChips(
  facts: ModelRouteFacts | undefined,
): ReadonlyArray<{ readonly axis: CapabilityAxis; readonly text: string }> {
  return CAPABILITY_AXES.filter((axis) => typeof facts?.scores[axis] === "number").map((axis) => ({
    axis,
    text: `${AXIS_LABEL[axis]} ${facts?.scores[axis]}`,
  }));
}

const usd = (value: number): string => (value < 0.01 ? value.toFixed(4) : value.toFixed(2));

/**
 * What one task on this route costs against the cheapest route on the roster.
 *
 * A ratio, not a price: nearly all spend here is plan quota, so the dollars
 * behind it are only a yardstick. Built from observed tokens, so a
 * cheaper-per-token model that needs more turns reads *above* a dearer one.
 * Falls back to the dollars while only one route has been measured, where a
 * ratio would be a comparison with itself.
 */
export function formatCostPerTask(facts: ModelRouteFacts | undefined): string {
  if (!facts) return "cost/task unknown";
  if (facts.relativeCost !== null) return `${facts.relativeCost}× cost/task`;
  if (facts.usdPerTask === null) return "cost/task unknown";
  return `${facts.usdPerTaskBasis === "list-price" ? "~" : ""}$${usd(facts.usdPerTask)}/task`;
}

/** The dollars behind the ratio, and where they came from. For the chip title. */
export function costPerTaskDetail(facts: ModelRouteFacts | undefined): string {
  if (!facts || facts.usdPerTask === null) {
    return facts?.usdPerTaskDetail ?? "no turns observed on this route";
  }
  const yardstick = facts.usdPerTaskBasis === "list-price" ? " at the catalog rate" : "";
  return `$${usd(facts.usdPerTask)}/task${yardstick} — ${facts.usdPerTaskDetail}`;
}

/** Metered routes read in dollars; a subscription reads in the quota it burns. */
export function formatRouteCost(facts: ModelRouteFacts | undefined): string {
  if (!facts) return "cost unknown";
  if (facts.billing === "metered" && facts.usdPerMTokIn !== null) {
    const out = facts.usdPerMTokOut === null ? "?" : facts.usdPerMTokOut;
    return `$${facts.usdPerMTokIn}→${out}/Mtok`;
  }
  if (facts.costBasis === "measured") return `$${"$".repeat(facts.costTier - 1)} tier`;
  return "cost unknown";
}

export function formatRouteSpeed(facts: ModelRouteFacts | undefined): string {
  if (!facts || facts.medianTurnMs === null) return "speed unknown";
  return `${Math.round(facts.medianTurnMs / 1000)}s/turn`;
}

/**
 * How fast the route emits, measured. Sits next to time/task on purpose: a
 * route at 200 tok/s that needs three times the turns finishes later, so these
 * two chips are only ever read together.
 */
export function formatRouteThroughput(facts: ModelRouteFacts | undefined): string {
  if (!facts || facts.tokensPerSecond === null) return "tok/s unknown";
  return `${Math.round(facts.tokensPerSecond)} tok/s`;
}

/** Wall-clock of the median observed task — whether the job actually landed sooner. */
export function formatTimePerTask(facts: ModelRouteFacts | undefined): string {
  if (!facts || facts.msPerTask === null) return "time/task unknown";
  const minutes = facts.msPerTask / 60_000;
  if (minutes < 1) return `${Math.round(facts.msPerTask / 1000)}s/task`;
  if (minutes < 90) return `${Math.round(minutes)}m/task`;
  return `${Math.round(minutes / 6) / 10}h/task`;
}

/** Learned share of the route's own allowance, never a guess from a name. */
export function formatRouteUsage(facts: ModelRouteFacts | undefined): string {
  if (!facts || facts.usagePercent === null) return "usage unknown";
  return `${Math.round(facts.usagePercent)}%/task`;
}

export function formatRouteHeadroom(facts: ModelRouteFacts | undefined): string | null {
  if (!facts || facts.remainingPercent === null) return null;
  return `${facts.remainingPercent}% left`;
}
