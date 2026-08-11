/**
 * The measuring instrument: per-turn token snapshots → the measured table.
 *
 * Rule zero is that no number here is invented. Everything is derived from
 * `ThreadTokenUsageSnapshot` values this box actually observed, or from a
 * provider catalog price. A quantity with no observation is reported as
 * `unknown` with the reason, never as a default.
 *
 * @module kanban/budget/measurements
 */
import type {
  HermesBudgetTable,
  HermesCacheAgeBucket,
  HermesCacheObservation,
  HermesDegradationBand,
  HermesHarnessMeasurement,
  HermesPlanEstimate,
  HermesSessionFloor,
} from "@t3tools/contracts";

/** A null in any addend poisons the sum — an unmeasured part means an unmeasured whole. */
export function sumEstimates(estimates: ReadonlyArray<HermesPlanEstimate>): HermesPlanEstimate {
  const add = (values: ReadonlyArray<number | null>): number | null =>
    values.some((value) => value === null) ? null : (values as number[]).reduce((a, b) => a + b, 0);
  return {
    sessionFloorTokens: add(estimates.map((estimate) => estimate.sessionFloorTokens ?? 0)),
    promptTokens: estimates.reduce((sum, estimate) => sum + estimate.promptTokens, 0),
    chargedInputTokens: add(estimates.map((estimate) => estimate.chargedInputTokens)),
    cachedInputTokens: add(estimates.map((estimate) => estimate.cachedInputTokens ?? 0)),
    expectedOutputTokens: add(estimates.map((estimate) => estimate.expectedOutputTokens)),
    usd: add(estimates.map((estimate) => estimate.usd)),
    quotaFraction: null,
    basis: [...new Set(estimates.flatMap((estimate) => estimate.basis))],
  };
}

/** One observed turn. `harness` is the provider instance id, not the model. */
export type TurnSample = {
  readonly harness: string;
  readonly model: string;
  readonly threadId: string;
  readonly at: string;
  /** 0 for a thread's first turn — the only turn that measures a session floor. */
  readonly turnIndex: number;
  /** ms since the previous turn in this thread; null on the first turn. */
  readonly gapMs: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
  /** Estimated tokens of the user text that opened the turn, when known. */
  readonly promptTokens: number | null;
  /** Provider build the sample was taken against; a floor is only valid for it. */
  readonly providerVersion: string | null;
};

export type PriceRow = {
  readonly usdPerMTokIn: number | null;
  readonly usdPerMTokOut: number | null;
  readonly source: "openrouter" | "subscription" | "unknown";
};

export type TickHealth = {
  readonly ticks: number;
  readonly failed: number;
  readonly nudges: number;
  readonly cardsWithThreads: number;
};

/** Rough stand-in used only where a real tokenizer is not on the path. */
export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(text.trim().length / 4));
}

export function median(values: ReadonlyArray<number>): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function mean(values: ReadonlyArray<number>): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export function cacheAgeBucket(gapMs: number): HermesCacheAgeBucket {
  if (gapMs < 5 * 60_000) return "under5m";
  if (gapMs < 60 * 60_000) return "under1h";
  return "over1h";
}

export const CACHE_AGE_BUCKETS: ReadonlyArray<HermesCacheAgeBucket> = [
  "under5m",
  "under1h",
  "over1h",
];

/**
 * A session floor is the first turn's input minus the prompt that rode along
 * with it: system prompt + tool schemas + skills, before the user's words cost
 * anything.
 */
export function sessionFloorFrom(samples: ReadonlyArray<TurnSample>): HermesSessionFloor {
  const firsts = samples.filter(
    (sample) => sample.turnIndex === 0 && typeof sample.inputTokens === "number",
  );
  if (firsts.length === 0) {
    return {
      status: "unknown",
      floorTokens: null,
      floorCachedTokens: null,
      sampleCount: 0,
      measuredAt: null,
      providerVersion: null,
      detail: "never measured — no first turn observed on this harness",
    };
  }
  const newest = [...firsts].sort((a, b) => b.at.localeCompare(a.at))[0] as TurnSample;
  // Only samples from the same provider build describe today's floor; a CLI
  // system prompt changes with every release.
  const cohort = firsts.filter((sample) => sample.providerVersion === newest.providerVersion);
  const floors = cohort.map((sample) =>
    Math.max(0, (sample.inputTokens as number) - (sample.promptTokens ?? 0)),
  );
  const floorTokens = median(floors);
  // Cache reads inside the floor bill at a fraction of fresh input; without the
  // split a warm 40k start and a cold one look identically expensive.
  const cachedMedian = median(
    cohort
      .map((sample) => sample.cachedInputTokens)
      .filter((value): value is number => value !== null),
  );
  const floorCachedTokens =
    floorTokens === null || cachedMedian === null
      ? null
      : Math.round(Math.max(0, Math.min(cachedMedian, floorTokens)));
  return {
    status: floorTokens === null ? "unknown" : "measured",
    floorTokens: floorTokens === null ? null : Math.round(floorTokens),
    floorCachedTokens,
    sampleCount: cohort.length,
    measuredAt: newest.at,
    providerVersion: newest.providerVersion,
    detail:
      floorTokens === null
        ? "first turns observed but no input tokens reported"
        : `median of ${cohort.length} first turn${cohort.length === 1 ? "" : "s"}${
            floorCachedTokens === null ? "" : `, ${floorCachedTokens} cached`
          }`,
  };
}

export function cacheObservationsFrom(
  samples: ReadonlyArray<TurnSample>,
): ReadonlyArray<HermesCacheObservation> {
  return CACHE_AGE_BUCKETS.map((bucket) => {
    const fractions = samples
      .filter(
        (sample) =>
          sample.gapMs !== null &&
          cacheAgeBucket(sample.gapMs) === bucket &&
          typeof sample.inputTokens === "number" &&
          sample.inputTokens > 0 &&
          typeof sample.cachedInputTokens === "number",
      )
      .map((sample) =>
        Math.max(
          0,
          Math.min(1, (sample.cachedInputTokens as number) / (sample.inputTokens as number)),
        ),
      );
    return {
      bucket,
      sampleCount: fractions.length,
      cachedFraction: median(fractions),
    };
  });
}

export type ResumeEstimate = {
  readonly chargedInputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly basis: ReadonlyArray<string>;
};

/**
 * What a turn in an existing thread actually costs at full rate.
 *
 * `inputTokens − cachedInputTokens` is the charged part. The cached fraction
 * comes from this box's observations for the matching thread age; with no
 * observation it charges the whole input and says so rather than assuming a
 * provider's documented TTL holds here.
 */
export function estimateResumeCost(input: {
  readonly samples: ReadonlyArray<TurnSample>;
  readonly thread: { readonly usedTokens: number | null; readonly idleForMs: number | null };
  readonly promptTokens: number;
}): ResumeEstimate {
  const basis: string[] = [];
  if (input.thread.usedTokens === null) {
    return {
      chargedInputTokens: null,
      cachedInputTokens: null,
      basis: ["thread context size unknown — no token snapshot on this thread"],
    };
  }
  const inputTokens = input.thread.usedTokens + input.promptTokens;
  const observations = cacheObservationsFrom(input.samples);
  const bucket =
    input.thread.idleForMs === null ? null : cacheAgeBucket(Math.max(0, input.thread.idleForMs));
  const exact = bucket ? observations.find((row) => row.bucket === bucket) : undefined;
  const chosen =
    exact && exact.cachedFraction !== null
      ? exact
      : observations.find((row) => row.cachedFraction !== null);

  if (!chosen || chosen.cachedFraction === null) {
    basis.push("cache behaviour unmeasured — charging the whole transcript at full rate");
    return { chargedInputTokens: inputTokens, cachedInputTokens: null, basis };
  }
  if (bucket === null) {
    basis.push(`thread age unknown — used observed ${chosen.bucket} cache fraction`);
  } else if (chosen.bucket !== bucket) {
    basis.push(`no ${bucket} samples — used observed ${chosen.bucket} cache fraction`);
  } else {
    basis.push(
      `observed ${Math.round(chosen.cachedFraction * 100)}% cached over ${chosen.sampleCount} ${bucket} turn${chosen.sampleCount === 1 ? "" : "s"}`,
    );
  }
  const cached = Math.round(inputTokens * chosen.cachedFraction);
  return {
    chargedInputTokens: Math.max(0, inputTokens - cached),
    cachedInputTokens: cached,
    basis,
  };
}

export type TaskCost = {
  /**
   * What one whole task on this route costs. Median across observed threads,
   * so a task is a card's thread — the same unit the board bills in.
   */
  readonly usdPerTask: number | null;
  readonly chargedInputTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * Wall-clock of the median observed task, summed over its turns. This is the
   * number that answers "did the job finish sooner", which tokens/second does
   * not: a route can emit twice as fast and still take longer by needing more
   * turns to land the same task.
   */
  readonly msPerTask: number | null;
  readonly taskCount: number;
  /**
   * `metered` is money that leaves the account. `list-price` is a subscription
   * priced at its catalog rate — what the task *would* cost if billed, useful
   * for comparing routes and never a claim about cash spent, because the real
   * currency there is quota.
   */
  readonly basis: "metered" | "list-price" | "unknown";
  readonly detail: string;
};

const UNKNOWN_TASK_COST = (detail: string): TaskCost => ({
  usdPerTask: null,
  chargedInputTokens: null,
  outputTokens: null,
  msPerTask: null,
  taskCount: 0,
  basis: "unknown",
  detail,
});

/**
 * Cost of a whole task on one route, from this box's own turns.
 *
 * Every turn in a thread is summed, then the median thread is the task. Charged
 * input is `inputTokens − cachedInputTokens`, the same split
 * {@link estimateResumeCost} uses; a cache read is not free at every provider,
 * so this is a floor rather than an upper bound, and it says which it is.
 * No observed thread, or no catalog price, means null — never a default.
 */
export function taskCostFrom(input: {
  readonly samples: ReadonlyArray<TurnSample>;
  readonly harness: string;
  readonly model: string;
  readonly price: PriceRow;
  readonly subscription: boolean;
}): TaskCost {
  const matching = input.samples.filter(
    (sample) => sample.harness === input.harness && sample.model === input.model,
  );
  if (matching.length === 0) return UNKNOWN_TASK_COST("no turns observed on this route");

  const byThread = new Map<
    string,
    { charged: number; output: number; ms: number; timed: boolean; counted: boolean }
  >();
  for (const sample of matching) {
    const thread = byThread.get(sample.threadId) ?? {
      charged: 0,
      output: 0,
      ms: 0,
      timed: false,
      counted: false,
    };
    if (sample.inputTokens !== null) {
      thread.charged += Math.max(0, sample.inputTokens - (sample.cachedInputTokens ?? 0));
      thread.counted = true;
    }
    if (sample.outputTokens !== null) {
      thread.output += sample.outputTokens;
      thread.counted = true;
    }
    if (sample.durationMs !== null) {
      thread.ms += sample.durationMs;
      thread.timed = true;
    }
    byThread.set(sample.threadId, thread);
  }
  const threads = [...byThread.values()].filter((thread) => thread.counted);
  if (threads.length === 0) {
    return UNKNOWN_TASK_COST(`${matching.length} turns observed, none carrying token counts`);
  }

  const chargedInputTokens = median(threads.map((thread) => thread.charged));
  const outputTokens = median(threads.map((thread) => thread.output));
  const msPerTask = median(threads.filter((thread) => thread.timed).map((thread) => thread.ms));
  const { usdPerMTokIn, usdPerMTokOut } = input.price;
  const taskCount = threads.length;
  const priced =
    usdPerMTokIn === null ||
    usdPerMTokOut === null ||
    chargedInputTokens === null ||
    outputTokens === null
      ? null
      : (chargedInputTokens * usdPerMTokIn + outputTokens * usdPerMTokOut) / 1_000_000;

  return {
    usdPerTask: priced,
    chargedInputTokens,
    outputTokens,
    msPerTask,
    taskCount,
    basis: priced === null ? "unknown" : input.subscription ? "list-price" : "metered",
    detail:
      priced === null
        ? `no catalog price for this route (${taskCount} observed task${taskCount === 1 ? "" : "s"})`
        : `median of ${taskCount} observed task${taskCount === 1 ? "" : "s"}${
            input.subscription ? ", priced at the catalog rate — a subscription spends quota" : ""
          }`,
  };
}

const DEGRADATION_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "0–25%", min: 0, max: 25 },
  { label: "25–50%", min: 25, max: 50 },
  { label: "50–75%", min: 50, max: 75 },
  { label: "75–100%", min: 75, max: 101 },
];

/**
 * Degradation proxies from this box, not from a blog post: how many tools a
 * turn takes, how long it runs, and how much it emits as the window fills.
 */
export function degradationFrom(
  samples: ReadonlyArray<TurnSample>,
): ReadonlyArray<HermesDegradationBand> {
  const withContext = samples.filter(
    (sample) =>
      typeof sample.usedTokens === "number" &&
      typeof sample.maxTokens === "number" &&
      (sample.maxTokens as number) > 0,
  );
  return DEGRADATION_BANDS.map((band) => {
    const rows = withContext.filter((sample) => {
      const percent = ((sample.usedTokens as number) / (sample.maxTokens as number)) * 100;
      return percent >= band.min && percent < band.max;
    });
    return {
      band: band.label,
      sampleCount: rows.length,
      meanToolUses: mean(
        rows.map((row) => row.toolUses).filter((value): value is number => value !== null),
      ),
      meanTurnMs: mean(
        rows.map((row) => row.durationMs).filter((value): value is number => value !== null),
      ),
      meanOutputTokens: mean(
        rows.map((row) => row.outputTokens).filter((value): value is number => value !== null),
      ),
    };
  });
}

/** Minimum turns in a band before its means say anything about the model. */
const STAMINA_BAND_MIN_SAMPLES = 3;
/** A band whose mean turn time doubles against the fresh baseline reads as degraded. */
const STAMINA_DEGRADED_FACTOR = 2;

/**
 * Where this model's own turns start degrading, from its banded means: the
 * ceiling is the top of the last well-sampled band whose mean turn time stays
 * under {@link STAMINA_DEGRADED_FACTOR}× the first band's. Null until at least
 * two bands are measured — one band has nothing to degrade against.
 */
export function staminaCeilingFrom(bands: ReadonlyArray<HermesDegradationBand>): number | null {
  const measured = bands.filter((band) => band.sampleCount >= STAMINA_BAND_MIN_SAMPLES);
  if (measured.length < 2) return null;
  const baseline = measured[0]?.meanTurnMs;
  if (baseline === undefined || baseline === null || baseline <= 0) return null;
  let ceiling: number | null = null;
  for (const band of measured) {
    if (band.meanTurnMs !== null && band.meanTurnMs > baseline * STAMINA_DEGRADED_FACTOR) break;
    const upper = Number.parseInt(band.band.split("–")[1] ?? "", 10);
    ceiling = Number.isFinite(upper) ? Math.min(100, upper) : ceiling;
  }
  return ceiling;
}

/** Blended $/Mtok → the tier the router ranks on. Null when price is unknown. */
export function costTierFromPrice(price: PriceRow): number | null {
  const input = price.usdPerMTokIn;
  const output = price.usdPerMTokOut;
  if (input === null && output === null) return null;
  // Weighted the way a coding turn actually reads: mostly input.
  const blended = (input ?? 0) * 0.8 + (output ?? 0) * 0.2;
  // Bands sized against today's catalog: haiku-class ≈1.8, sonnet-class ≈5.4,
  // opus-class ≈27 blended $/Mtok.
  if (blended < 2) return 1;
  if (blended < 10) return 2;
  if (blended < 30) return 3;
  return 4;
}

export function buildBudgetTable(input: {
  readonly samples: ReadonlyArray<TurnSample>;
  readonly harnesses: ReadonlyArray<{ instanceId: string; model: string; price: PriceRow }>;
  readonly tickHealth?: TickHealth | null;
  readonly updatedAt: string | null;
}): HermesBudgetTable {
  const unknowns: string[] = [];
  const harnesses: HermesHarnessMeasurement[] = input.harnesses.map((entry) => {
    const rows = input.samples.filter(
      (sample) => sample.harness === entry.instanceId && sample.model === entry.model,
    );
    const floor = sessionFloorFrom(rows);
    if (floor.status === "unknown") {
      unknowns.push(`session floor unknown for ${entry.instanceId}/${entry.model}`);
    }
    if (entry.price.source === "unknown") {
      unknowns.push(`price unknown for ${entry.instanceId}/${entry.model}`);
    }
    const outputs = rows
      .map((row) => row.outputTokens)
      .filter((value): value is number => value !== null);
    const ownDegradation = degradationFrom(rows);
    return {
      harness: entry.instanceId,
      model: entry.model,
      floor,
      cache: cacheObservationsFrom(rows),
      medianOutputTokens: median(outputs),
      usdPerMTokIn: entry.price.usdPerMTokIn,
      usdPerMTokOut: entry.price.usdPerMTokOut,
      priceSource: entry.price.source,
      costTier: costTierFromPrice(entry.price),
      degradation: ownDegradation,
      staminaCeilingPercent: staminaCeilingFrom(ownDegradation),
    };
  });

  const degradation = degradationFrom(input.samples);
  if (degradation.every((band) => band.sampleCount === 0)) {
    unknowns.push("degradation unmeasured — no turn carried both used and max tokens");
  }

  const health = input.tickHealth ?? null;
  return {
    updatedAt: input.updatedAt,
    harnesses,
    degradation,
    nudgesPerCard:
      health && health.cardsWithThreads > 0 ? health.nudges / health.cardsWithThreads : null,
    failedTickRate: health && health.ticks > 0 ? health.failed / health.ticks : null,
    unknowns,
  };
}
