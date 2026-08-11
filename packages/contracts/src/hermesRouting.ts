/**
 * Typed hand-off between Hermes's semantic routing skills and the deterministic
 * launch runtime. This is intentionally a compact decision brief, not a dump of
 * provider configuration, usage telemetry, board state, or thread transcripts.
 */
import * as Schema from "effect/Schema";

import { ModelSelection } from "./orchestration.ts";

export const HERMES_ROUTE_CONFIDENCE = ["measured", "learned", "estimated", "unknown"] as const;
export const HermesRouteConfidence = Schema.Literals(HERMES_ROUTE_CONFIDENCE);
export type HermesRouteConfidence = typeof HermesRouteConfidence.Type;

export const HermesCapacityBilling = Schema.Literals(["subscription", "metered"]);
export type HermesCapacityBilling = typeof HermesCapacityBilling.Type;

export const HermesCapacityPool = Schema.Struct({
  id: Schema.String,
  billing: HermesCapacityBilling,
  /** Remaining share of the binding allowance/window, 0..100. */
  remainingPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
  /** Metered routes only. Subscription capacity never pretends to be cash. */
  balanceUsd: Schema.NullOr(Schema.Number),
  confidence: HermesRouteConfidence,
  detail: Schema.String,
});
export type HermesCapacityPool = typeof HermesCapacityPool.Type;

export const HermesTaskUsageEstimate = Schema.Struct({
  /** Percentage points of the route's capacity pool, never a fraction. */
  lowPercent: Schema.NullOr(Schema.Number),
  likelyPercent: Schema.NullOr(Schema.Number),
  highPercent: Schema.NullOr(Schema.Number),
  confidence: HermesRouteConfidence,
  basis: Schema.String,
});
export type HermesTaskUsageEstimate = typeof HermesTaskUsageEstimate.Type;

/**
 * Compact benchmark evidence, one number per kind of work the board routes.
 * Null is honest and must not be guessed from a model name. Scales differ per
 * axis by design — rows are only ever compared within an axis, never across.
 * Cost is absent on purpose: `meteredPrice` and the capacity pool carry it from
 * this box's own measurements.
 */
export const HermesRouteCapability = Schema.Struct({
  coding: Schema.NullOr(Schema.Number),
  /** Terminal, ops and infrastructure work. */
  it: Schema.NullOr(Schema.Number),
  /** UI and front-end work. */
  design: Schema.NullOr(Schema.Number),
  /** Multi-step decomposition and tool-use planning. */
  planning: Schema.NullOr(Schema.Number),
  effectiveContextTokens: Schema.NullOr(Schema.Number),
  /** Which benchmark produced each present axis, joined for the brief. */
  source: Schema.NullOr(Schema.String),
});
export type HermesRouteCapability = typeof HermesRouteCapability.Type;

/**
 * Emission speed, observed. Rank on it only for "how fast does output appear" —
 * never for "which route finishes the task sooner or cheaper", which is
 * `HermesTaskCost.msPerTask` and `HermesTaskCost.relative`. A route at 200
 * tok/s that needs three times the turns loses on both.
 */
export const HermesRouteSpeed = Schema.Struct({
  /** Median duration observed on this exact harness/model, not provider marketing. */
  medianTurnMs: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
  /** Median output tokens per second over turns that emitted anything. */
  tokensPerSecond: Schema.NullOr(Schema.Number),
  throughputSamples: Schema.Number,
});
export type HermesRouteSpeed = typeof HermesRouteSpeed.Type;

export const HermesMeteredPrice = Schema.Struct({
  inputUsdPerMTok: Schema.NullOr(Schema.Number),
  outputUsdPerMTok: Schema.NullOr(Schema.Number),
  source: Schema.String,
});

/**
 * What one whole task on this route has actually cost: median over the threads
 * this box observed, priced from the catalog.
 *
 * Rank on `relative`, not on the dollars. Almost all spend here is plan quota,
 * so the money is a yardstick rather than a bill — and because it is built from
 * observed tokens, a cheaper-per-token model that needs more turns to finish
 * correctly lands above a dearer one that finishes in fewer.
 */
export const HermesTaskCost = Schema.Struct({
  /** Cost against the cheapest measured route on the roster, which is 1. */
  relative: Schema.NullOr(Schema.Number),
  usdPerTask: Schema.NullOr(Schema.Number),
  /** Wall-clock of the median observed task. The only "is it quicker" number. */
  msPerTask: Schema.NullOr(Schema.Number),
  basis: Schema.Literals(["metered", "list-price", "unknown"]),
  taskCount: Schema.Number,
  detail: Schema.String,
});
export type HermesTaskCost = typeof HermesTaskCost.Type;
export type HermesMeteredPrice = typeof HermesMeteredPrice.Type;

export const HermesRouteOption = Schema.Struct({
  routeId: Schema.String,
  selection: ModelSelection,
  available: Schema.Boolean,
  ownerRule: Schema.String,
  optionsSummary: Schema.String,
  /** Owner-approved values Hermes may choose semantically for this route. */
  optionChoices: Schema.Array(
    Schema.Struct({ id: Schema.String, values: Schema.Array(Schema.String) }),
  ),
  capability: HermesRouteCapability,
  speed: HermesRouteSpeed,
  capacity: HermesCapacityPool,
  usage: HermesTaskUsageEstimate,
  /** Null for subscriptions; compact marginal prices for genuinely metered routes. */
  meteredPrice: Schema.NullOr(HermesMeteredPrice),
  /** One number to compare routes on, in the unit a task is actually bought in. */
  taskCost: HermesTaskCost,
});
export type HermesRouteOption = typeof HermesRouteOption.Type;

export const HermesRoutingProject = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  repo: Schema.NullOr(Schema.String),
  /** Evidence already collected by a project-routing skill; never a checkout dump. */
  evidence: Schema.Array(Schema.String),
});
export type HermesRoutingProject = typeof HermesRoutingProject.Type;

export const HermesRoutingThread = Schema.Struct({
  threadId: Schema.String,
  cardId: Schema.NullOr(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  contextUsedPercent: Schema.NullOr(Schema.Number),
  compatibleRouteIds: Schema.Array(Schema.String),
});
export type HermesRoutingThread = typeof HermesRoutingThread.Type;

export const HermesRoutingPolicy = Schema.Struct({
  /** Explicit card fields are human constraints, not suggestions. */
  pinnedProjectId: Schema.NullOr(Schema.String),
  pinnedRouteId: Schema.NullOr(Schema.String),
  naturalLanguageRules: Schema.Array(Schema.String),
  allowedRouteIds: Schema.Array(Schema.String),
  rosterEnforced: Schema.Boolean,
  preferSubscriptions: Schema.Boolean,
  preserveScarceUsage: Schema.Boolean,
  maxTaskUsagePercent: Schema.NullOr(Schema.Number),
});
export type HermesRoutingPolicy = typeof HermesRoutingPolicy.Type;

export const HermesRoutingBrief = Schema.Struct({
  cardId: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      name: Schema.String,
      mimeType: Schema.String,
    }),
  ),
  projects: Schema.Array(HermesRoutingProject),
  routes: Schema.Array(HermesRouteOption),
  threads: Schema.Array(HermesRoutingThread),
  policy: HermesRoutingPolicy,
});
export type HermesRoutingBrief = typeof HermesRoutingBrief.Type;

export const HermesExpectedWork = Schema.Struct({
  investigation: Schema.Literals(["none", "low", "medium", "high"]),
  implementation: Schema.Literals(["none", "low", "medium", "high"]),
  verification: Schema.Literals(["none", "low", "medium", "high"]),
  risk: Schema.Literals(["low", "medium", "high", "critical"]),
  contextPressure: Schema.Literals(["low", "medium", "high"]),
  expectedTurns: Schema.Tuple([Schema.Number, Schema.Number]),
});
export type HermesExpectedWork = typeof HermesExpectedWork.Type;

export const HermesWorkPlacement = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new"), threadId: Schema.Null }),
  Schema.Struct({ kind: Schema.Literal("reuse"), threadId: Schema.String }),
]);
export type HermesWorkPlacement = typeof HermesWorkPlacement.Type;

export const HermesRouteProvenance = Schema.Struct({
  source: Schema.Literals(["human", "hermes", "fallback"]),
  skill: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type HermesRouteProvenance = typeof HermesRouteProvenance.Type;

export const HermesLaunchTask = Schema.Struct({
  sourceCardId: Schema.String,
  title: Schema.String,
  brief: Schema.String,
  projectId: Schema.String,
  placement: HermesWorkPlacement,
  execution: Schema.Struct({
    routeId: Schema.String,
    selection: ModelSelection,
    usage: HermesTaskUsageEstimate,
  }),
  expectedWork: HermesExpectedWork,
  reason: Schema.String,
  alternativesConsidered: Schema.Array(Schema.String),
  provenance: HermesRouteProvenance,
});
export type HermesLaunchTask = typeof HermesLaunchTask.Type;

export const HermesLaunchPlan = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["ready", "blocked"]),
  sourceCardId: Schema.String,
  tasks: Schema.Array(HermesLaunchTask),
  blockedReason: Schema.NullOr(Schema.String),
});
export type HermesLaunchPlan = typeof HermesLaunchPlan.Type;
