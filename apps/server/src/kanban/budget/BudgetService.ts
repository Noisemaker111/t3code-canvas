/**
 * Budget routing runtime: refresh the measured table, answer the status query,
 * and turn raw composer text into a plan.
 *
 * Nothing here writes to the board. Measuring is explicit (the panel's
 * "Measure now" or a tick while budget routing is on) so a box that never asks
 * for it never pays for it.
 *
 * @module kanban/budget/BudgetService
 */
import type {
  BoardSettings,
  HermesBudgetDrift,
  HermesBudgetPlan,
  HermesBudgetStatus,
  HermesBudgetTable,
  HermesPlanEstimate,
} from "@t3tools/contracts";

import type { OpenRouterCatalogEntry } from "../OpenRouterModelCatalog.ts";
import { getModelPriceCatalog } from "../ModelPriceCatalog.ts";
import {
  candidatesFromShellProviders,
  primaryUtilization,
  providerFamilyUsable,
  usageProviderIdForInstance,
} from "../ModelRouting.ts";
import type { UsageResponse } from "../../usage/UsageService.ts";
import { getUsageService } from "../../usage/UsageService.ts";
import type { BoardApi } from "../hermes/boardApi.ts";
import {
  appendDriftSample,
  hermesBudgetTablePath,
  putSamples,
  readBudgetStore,
  BUDGET_SAMPLE_LIMIT,
} from "./budgetStore.ts";
import { mergeTurnSamples, turnSamplesFromThread, type ThreadUsageInput } from "./collector.ts";
import { clampBudgetPosition, resolveBudgetKnobs } from "./knobs.ts";
import {
  capabilityForModel,
  codingScoreOf,
  getModelCapabilityCatalog,
  type ModelCapabilityEntry,
} from "../ModelCapabilityCatalog.ts";
import {
  buildBudgetTable,
  costTierFromPrice,
  degradationFrom,
  sessionFloorFrom,
  staminaCeilingFrom,
  median,
  type TickHealth,
  type TurnSample,
} from "./measurements.ts";
import { buildBudgetPlan, type PlanHarness, type PlanThread } from "./plan.ts";
import { isSubscriptionHarness, priceForHarness } from "./pricing.ts";
import { quotaWindowsForModel, shadowPrice } from "./shadowPrice.ts";

export type BudgetProviderRow = {
  readonly instanceId: string;
  readonly version: string | null;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly auth: { status?: string } | string | null;
  readonly models: ReadonlyArray<{ slug: string; name?: string }>;
};

export type BudgetDeps = {
  readonly api: BoardApi;
  readonly boardSettings: () => Promise<BoardSettings>;
  readonly listProviders: () => Promise<ReadonlyArray<BudgetProviderRow>>;
  /** Thread usage activities, for the measurement pass. */
  readonly readThreadUsage: (threadId: string) => Promise<ThreadUsageInput | null>;
  readonly usage?: () => Promise<UsageResponse | null>;
  /** Observed quota burn per hour for `(family, windowId)`; defaults to the usage service's own history. */
  readonly burnRatePerHour?: (family: string, windowId: string) => number | null;
  /** Benchmark capability snapshot; defaults to the on-disk catalog, null when absent. */
  readonly capability?: () => Promise<ReadonlyMap<string, ModelCapabilityEntry> | null>;
  readonly catalog?: () => Promise<ReadonlyMap<string, OpenRouterCatalogEntry>>;
  readonly tickHealth?: () => TickHealth | null;
  readonly now?: () => Date;
};

/** Reading every thread on a busy board is not worth it; the newest ones carry the signal. */
const MAX_THREADS_SAMPLED = 24;

/**
 * Last computed measured tiers, keyed `instanceId::model`. Launch routing is a
 * synchronous path that cannot await a catalog fetch, so it reads this cache and
 * falls back to "unmeasured" when nothing has filled it yet.
 */
let cachedTiers: ReadonlyMap<string, number | null> = new Map();

export function cachedMeasuredCostTiers(): ReadonlyMap<string, number | null> {
  return cachedTiers;
}

const usageOf = (deps: BudgetDeps): Promise<UsageResponse | null> =>
  deps.usage ? deps.usage() : getUsageService().getUsageSafe();

const catalogOf = async (deps: BudgetDeps): Promise<ReadonlyMap<string, OpenRouterCatalogEntry>> =>
  deps.catalog ? deps.catalog() : getModelPriceCatalog();

async function threadIdsOnBoard(api: BoardApi): Promise<ReadonlyArray<string>> {
  const cards = await api.list().catch(() => []);
  return cards
    .filter((card) => card.threadId && card.archivedAt === null)
    .slice(-MAX_THREADS_SAMPLED)
    .map((card) => String(card.threadId));
}

/** Read every live thread's token snapshots into the store. Writes no board state. */
export async function refreshBudgetMeasurements(
  deps: BudgetDeps,
): Promise<{ threads: number; samples: number }> {
  const now = deps.now ?? (() => new Date());
  const threadIds = await threadIdsOnBoard(deps.api);
  const collected = await Promise.all(
    threadIds.map((threadId) =>
      deps
        .readThreadUsage(threadId)
        .then((usage) => (usage ? turnSamplesFromThread(usage) : []))
        .catch(() => [] as ReadonlyArray<TurnSample>),
    ),
  );
  const merged = mergeTurnSamples(readBudgetStore().samples, collected.flat(), BUDGET_SAMPLE_LIMIT);
  putSamples(merged, now().toISOString());
  return { threads: threadIds.length, samples: merged.length };
}

type HarnessRow = {
  readonly instanceId: string;
  readonly model: string;
  readonly name: string;
  readonly usable: boolean;
  readonly version: string | null;
};

async function harnessRows(deps: BudgetDeps): Promise<{
  rows: ReadonlyArray<HarnessRow>;
  usage: UsageResponse | null;
}> {
  const [providers, usage] = await Promise.all([
    deps.listProviders().catch(() => [] as ReadonlyArray<BudgetProviderRow>),
    usageOf(deps).catch(() => null),
  ]);
  const versions = new Map(providers.map((provider) => [provider.instanceId, provider.version]));
  const rows = candidatesFromShellProviders(providers)
    .filter((candidate) => candidate.enabled && candidate.installed !== false)
    .map((candidate) => ({
      instanceId: candidate.instanceId,
      model: candidate.model,
      name: candidate.name,
      usable: providerFamilyUsable(usage, candidate.instanceId).ok && candidate.authOk !== false,
      version: versions.get(candidate.instanceId) ?? null,
    }));
  return { rows, usage };
}

export async function budgetTable(deps: BudgetDeps): Promise<HermesBudgetTable> {
  const [{ rows }, byId] = await Promise.all([harnessRows(deps), catalogOf(deps)]);
  const store = readBudgetStore();
  // Harnesses with observations stay in the table even when the provider is
  // currently off — that history is what makes a re-measure comparable.
  const observed = new Set(store.samples.map((sample) => `${sample.harness}::${sample.model}`));
  const harnesses = rows
    .filter((row) => observed.has(`${row.instanceId}::${row.model}`) || row.usable)
    .map((row) => ({
      instanceId: row.instanceId,
      model: row.model,
      price: priceForHarness({ instanceId: row.instanceId, model: row.model, byId }),
    }));
  cachedTiers = new Map(
    harnesses.map((entry) => [
      `${entry.instanceId}::${entry.model}`,
      costTierFromPrice(entry.price),
    ]),
  );
  return buildBudgetTable({
    samples: store.samples,
    harnesses,
    tickHealth: deps.tickHealth?.() ?? null,
    updatedAt: store.updatedAt,
  });
}

function driftSummary(): HermesBudgetDrift {
  const samples = readBudgetStore().drift;
  const drifts = samples
    .map((sample) => sample.driftPercent)
    .filter((value): value is number => value !== null);
  const meanAbs =
    drifts.length === 0
      ? null
      : drifts.reduce((sum, value) => sum + Math.abs(value), 0) / drifts.length;
  return {
    sampleCount: samples.length,
    meanAbsDriftPercent: meanAbs === null ? null : Math.round(meanAbs * 10) / 10,
    recent: samples.slice(-20).reverse(),
  };
}

export async function getBudgetStatus(deps: BudgetDeps): Promise<HermesBudgetStatus> {
  const settings = await deps.boardSettings();
  const position = clampBudgetPosition(settings.hermesBudgetPosition);
  return {
    enabled: settings.hermesBudgetRoutingEnabled,
    position,
    knobs: resolveBudgetKnobs(position),
    table: await budgetTable(deps),
    drift: driftSummary(),
    tablePath: hermesBudgetTablePath(),
  };
}

const capabilityOf = (
  deps: BudgetDeps,
): Promise<ReadonlyMap<string, ModelCapabilityEntry> | null> =>
  deps.capability ? deps.capability() : getModelCapabilityCatalog();

async function planThreads(deps: BudgetDeps): Promise<ReadonlyArray<PlanThread>> {
  const [cards, capability] = await Promise.all([
    deps.api.list().catch(() => []),
    capabilityOf(deps).catch(() => null),
  ]);
  const threaded = cards
    .filter((card) => card.threadId && card.archivedAt === null && card.at !== "done")
    .slice(-MAX_THREADS_SAMPLED);
  const threads = await Promise.all(
    threaded.map(async (card): Promise<PlanThread | null> => {
      const threadId = String(card.threadId);
      const [transcript, usage] = await Promise.all([
        deps.api.threadTranscript({ threadId, limit: 4 }).catch(() => null),
        deps.readThreadUsage(threadId).catch(() => null),
      ]);
      if (!transcript || !transcript.exists) return null;
      const samples = usage ? turnSamplesFromThread(usage) : [];
      const newest = samples[samples.length - 1] ?? null;
      const usedTokens = newest?.usedTokens ?? null;
      const maxTokens = newest?.maxTokens ?? null;
      // Fullness against the context the model holds *well*: a 1M window whose
      // effective span is 200k reads 200k-full at 200k, not 20%-full.
      const effective = usage?.model
        ? capabilityForModel(capability, usage.model)?.effectiveContextTokens
        : null;
      const window =
        maxTokens !== null && maxTokens > 0
          ? effective != null && effective > 0
            ? Math.min(maxTokens, effective)
            : maxTokens
          : null;
      return {
        threadId,
        cardId: String(card.id),
        title: `${card.title}\n${transcript.title}`,
        tail: transcript.entries.map((entry) => entry.text).join("\n"),
        usedTokens,
        usedPercentage:
          usedTokens !== null && window !== null
            ? Math.min(100, (usedTokens / window) * 100)
            : null,
        idleForMs: transcript.idleForMs,
        instanceId: usage?.instanceId ?? null,
        model: usage?.model ?? null,
      } satisfies PlanThread;
    }),
  );
  return threads.filter((thread): thread is PlanThread => thread !== null);
}

export async function planHarnesses(deps: BudgetDeps): Promise<ReadonlyArray<PlanHarness>> {
  const [{ rows, usage }, byId, capability] = await Promise.all([
    harnessRows(deps),
    catalogOf(deps),
    capabilityOf(deps).catch(() => null),
  ]);
  const store = readBudgetStore();
  // Clocked off the snapshot's own timestamp — ≤ one poll stale, no wall-clock read.
  const usageNowMs = usage ? Date.parse(usage.fetchedAt) : Number.NaN;
  const burnRate =
    deps.burnRatePerHour ??
    ((family: string, windowId: string) => getUsageService().burnRatePerHour(family, windowId));
  const harnesses = rows.map((row) => {
    const samples = store.samples.filter(
      (sample) => sample.harness === row.instanceId && sample.model === row.model,
    );
    const price = priceForHarness({ instanceId: row.instanceId, model: row.model, byId });
    const outputs = samples
      .map((sample) => sample.outputTokens)
      .filter((value): value is number => value !== null);
    const floor = sessionFloorFrom(samples);
    // A floor measured against a different provider build is not this build's
    // floor; report it unknown rather than quoting a stale number.
    const stale =
      floor.status === "measured" &&
      row.version !== null &&
      floor.providerVersion !== null &&
      floor.providerVersion !== row.version;
    return {
      instanceId: row.instanceId,
      model: row.model,
      name: row.name,
      usable: row.usable,
      subscription: isSubscriptionHarness(row.instanceId),
      price,
      costTier: costTierFromPrice(price),
      floor: stale
        ? {
            ...floor,
            status: "unknown" as const,
            floorTokens: null,
            floorCachedTokens: null,
            detail: `measured on ${floor.providerVersion}, provider is now ${row.version} — re-measure`,
          }
        : floor,
      medianOutputTokens: median(outputs),
      quotaUtilization: primaryUtilization(
        usage?.providers[usageProviderIdForInstance(row.instanceId)],
      ),
      shadowPrice: (() => {
        if (!isSubscriptionHarness(row.instanceId) || !Number.isFinite(usageNowMs)) return null;
        const family = usageProviderIdForInstance(row.instanceId);
        return shadowPrice({
          windows: quotaWindowsForModel(usage?.providers[family], row.model),
          nowMs: usageNowMs,
          burnRatePerHour: (windowId) => burnRate(family, windowId),
        });
      })(),
      codingScore: codingScoreOf(capabilityForModel(capability, row.model)),
      staminaCeilingPercent: staminaCeilingFrom(degradationFrom(samples)),
    } satisfies PlanHarness;
  });
  cachedTiers = new Map(
    harnesses.map((harness) => [`${harness.instanceId}::${harness.model}`, harness.costTier]),
  );
  return harnesses;
}

export async function buildPlanForText(deps: BudgetDeps, text: string): Promise<HermesBudgetPlan> {
  const now = deps.now ?? (() => new Date());
  const settings = await deps.boardSettings();
  const knobs = resolveBudgetKnobs(settings.hermesBudgetPosition);
  const [threads, harnesses] = await Promise.all([planThreads(deps), planHarnesses(deps)]);
  return buildBudgetPlan({
    text,
    knobs,
    threads,
    harnesses,
    samples: readBudgetStore().samples,
    now: now().toISOString(),
  });
}

/** Predicted vs actual for one tick. A router that never learns stays wrong. */
export function recordBudgetDrift(input: {
  readonly at: string;
  readonly estimate: HermesPlanEstimate;
  readonly actual: HermesPlanEstimate | null;
}): number | null {
  const estimated = input.estimate.chargedInputTokens;
  const actual = input.actual?.chargedInputTokens ?? null;
  const driftPercent =
    estimated === null || actual === null || estimated <= 0
      ? null
      : Math.round(((actual - estimated) / estimated) * 1000) / 10;
  appendDriftSample({
    at: input.at,
    estimatedInputTokens: estimated,
    actualInputTokens: actual,
    estimatedUsd: input.estimate.usd,
    actualUsd: input.actual?.usd ?? null,
    driftPercent,
  });
  return driftPercent;
}
