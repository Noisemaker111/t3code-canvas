/**
 * Hermes budget routing — the measured table, the slider knobs, and the plan.
 *
 * Every number here is measured on this box or read from a provider catalog.
 * Anything that has not been measured is reported as `unknown` with a reason,
 * never as a default, because a hardcoded table rots the moment a provider
 * ships a new system prompt.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** 0 = cheapest, 100 = fastest. One user-facing setting; these are its knobs. */
export const HermesBudgetKnobs = Schema.Struct({
  position: Schema.Number,
  /** Ceiling on measured cost tier (1..4) a task may route to. */
  maxCostTier: Schema.Number,
  /** Prefer a provider's fast variant when one exists. */
  preferFastVariant: Schema.Boolean,
  /** 0..1 — how readily one prompt becomes several cards/threads. */
  splitEagerness: Schema.Number,
  /**
   * 0..1 — segments whose keyword overlap clears this merge into one task
   * regardless of eagerness: five fixes for one game are one thread's work.
   */
  clusterOverlapFloor: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0.35))),
  /** 0..1 — minimum topic overlap before an existing thread may be reused. */
  reuseOverlapFloor: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0.18))),
  /** Session-floor charged tokens above which a harness reads as heavy. */
  heavyFloorTokens: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(10_000))),
  /** Context-used % above which reuse loses to a fresh thread. */
  reuseContextCeilingPercent: Schema.Number,
  /** Context-used % that forces a fresh thread regardless of topic match. */
  hardFreshCeilingPercent: Schema.Number,
  /** Whether a heavy harness's measured session floor is worth paying. */
  payHeavySessionFloor: Schema.Boolean,
});
export type HermesBudgetKnobs = typeof HermesBudgetKnobs.Type;

export const HermesMeasurementStatus = Schema.Literals(["measured", "unknown"]);
export type HermesMeasurementStatus = typeof HermesMeasurementStatus.Type;

/** Tokens a harness charges on turn one before the prompt does anything. */
export const HermesSessionFloor = Schema.Struct({
  status: HermesMeasurementStatus,
  floorTokens: Schema.NullOr(Schema.Number),
  /**
   * Median cache-read tokens inside the floor. A cached start bills ~10% of a
   * fresh one, so `floorTokens − floorCachedTokens` is what a new thread
   * actually charges. Null when the harness never reported cache reads.
   */
  floorCachedTokens: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sampleCount: Schema.Number,
  measuredAt: Schema.NullOr(Schema.String),
  /** Provider version the floor was measured against; re-measure when it moves. */
  providerVersion: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type HermesSessionFloor = typeof HermesSessionFloor.Type;

export const HermesCacheAgeBucket = Schema.Literals(["under5m", "under1h", "over1h"]);
export type HermesCacheAgeBucket = typeof HermesCacheAgeBucket.Type;

/** Observed `cachedInputTokens / inputTokens` by how old the thread's last turn was. */
export const HermesCacheObservation = Schema.Struct({
  bucket: HermesCacheAgeBucket,
  sampleCount: Schema.Number,
  cachedFraction: Schema.NullOr(Schema.Number),
});
export type HermesCacheObservation = typeof HermesCacheObservation.Type;

export const HermesPriceSource = Schema.Literals(["openrouter", "subscription", "unknown"]);
export type HermesPriceSource = typeof HermesPriceSource.Type;

/** In-repo degradation proxies, banded by how full the context was. */
export const HermesDegradationBand = Schema.Struct({
  band: Schema.String,
  sampleCount: Schema.Number,
  meanToolUses: Schema.NullOr(Schema.Number),
  meanTurnMs: Schema.NullOr(Schema.Number),
  meanOutputTokens: Schema.NullOr(Schema.Number),
});
export type HermesDegradationBand = typeof HermesDegradationBand.Type;

export const HermesHarnessMeasurement = Schema.Struct({
  /** Provider instance id — the harness, not the model. */
  harness: Schema.String,
  model: Schema.String,
  floor: HermesSessionFloor,
  cache: Schema.Array(HermesCacheObservation),
  /** Median observed output tokens per turn. Null until a turn is observed. */
  medianOutputTokens: Schema.NullOr(Schema.Number),
  usdPerMTokIn: Schema.NullOr(Schema.Number),
  usdPerMTokOut: Schema.NullOr(Schema.Number),
  priceSource: HermesPriceSource,
  /** Measured cost tier 1..4 from blended price; null when price is unknown. */
  costTier: Schema.NullOr(Schema.Number),
  /** This model's own degradation bands — the global table hides who degrades. */
  degradation: Schema.Array(HermesDegradationBand).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<HermesDegradationBand>)),
  ),
  /**
   * Context-used % beyond which this model's own turns measurably degrade
   * (turn time doubling against its fresh-context baseline). Null until
   * enough bands are measured.
   */
  staminaCeilingPercent: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HermesHarnessMeasurement = typeof HermesHarnessMeasurement.Type;

export const HermesBudgetTable = Schema.Struct({
  updatedAt: Schema.NullOr(Schema.String),
  harnesses: Schema.Array(HermesHarnessMeasurement),
  degradation: Schema.Array(HermesDegradationBand),
  /** Nudges per card and failed-tick rate, from the tick log. */
  nudgesPerCard: Schema.NullOr(Schema.Number),
  failedTickRate: Schema.NullOr(Schema.Number),
  unknowns: Schema.Array(Schema.String),
});
export type HermesBudgetTable = typeof HermesBudgetTable.Type;

/** Two currencies, never collapsed: API dollars and subscription quota. */
export const HermesPlanEstimate = Schema.Struct({
  sessionFloorTokens: Schema.NullOr(Schema.Number),
  promptTokens: Schema.Number,
  chargedInputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  expectedOutputTokens: Schema.NullOr(Schema.Number),
  usd: Schema.NullOr(Schema.Number),
  /** Fraction of the provider's plan window this is expected to burn. */
  quotaFraction: Schema.NullOr(Schema.Number),
  basis: Schema.Array(Schema.String),
});
export type HermesPlanEstimate = typeof HermesPlanEstimate.Type;

export const HermesPlanPlacement = Schema.Struct({
  kind: Schema.Literals(["reuse", "new"]),
  threadId: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type HermesPlanPlacement = typeof HermesPlanPlacement.Type;

export const HermesPlanHarness = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  reason: Schema.String,
  /** `measured` when a catalog price decided it; `unmeasured` when nothing did. */
  costBasis: Schema.String,
});
export type HermesPlanHarness = typeof HermesPlanHarness.Type;

export const HermesPlanTask = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  text: Schema.String,
  size: Schema.Literals(["small", "medium", "large"]),
  placement: HermesPlanPlacement,
  harness: Schema.NullOr(HermesPlanHarness),
  estimate: HermesPlanEstimate,
});
export type HermesPlanTask = typeof HermesPlanTask.Type;

export const HermesBudgetPlan = Schema.Struct({
  createdAt: Schema.String,
  position: Schema.Number,
  knobs: HermesBudgetKnobs,
  tasks: Schema.Array(HermesPlanTask),
  totals: HermesPlanEstimate,
  unknowns: Schema.Array(Schema.String),
  /** One line for the composer: `≈$0.04 · 3 threads · haiku · reuse #12`. */
  summary: Schema.String,
});
export type HermesBudgetPlan = typeof HermesBudgetPlan.Type;

/** One predicted-vs-actual pair, recorded per tick. */
export const HermesBudgetDriftSample = Schema.Struct({
  at: Schema.String,
  estimatedInputTokens: Schema.NullOr(Schema.Number),
  actualInputTokens: Schema.NullOr(Schema.Number),
  estimatedUsd: Schema.NullOr(Schema.Number),
  actualUsd: Schema.NullOr(Schema.Number),
  driftPercent: Schema.NullOr(Schema.Number),
});
export type HermesBudgetDriftSample = typeof HermesBudgetDriftSample.Type;

export const HermesBudgetDrift = Schema.Struct({
  sampleCount: Schema.Number,
  meanAbsDriftPercent: Schema.NullOr(Schema.Number),
  recent: Schema.Array(HermesBudgetDriftSample),
});
export type HermesBudgetDrift = typeof HermesBudgetDrift.Type;

/** What one tick predicted and what it actually cost. */
export const HermesTickBudget = Schema.Struct({
  plannedTasks: Schema.Number,
  estimate: HermesPlanEstimate,
  actual: Schema.NullOr(HermesPlanEstimate),
  driftPercent: Schema.NullOr(Schema.Number),
});
export type HermesTickBudget = typeof HermesTickBudget.Type;

export const HermesBudgetStatus = Schema.Struct({
  /** On by default; off means routing ignores the measured table. */
  enabled: Schema.Boolean,
  position: Schema.Number,
  knobs: HermesBudgetKnobs,
  table: HermesBudgetTable,
  drift: HermesBudgetDrift,
  /** Where the measured table is persisted; null when unwritable. */
  tablePath: Schema.NullOr(Schema.String),
});
export type HermesBudgetStatus = typeof HermesBudgetStatus.Type;

export const DEFAULT_HERMES_BUDGET_POSITION = 50;
