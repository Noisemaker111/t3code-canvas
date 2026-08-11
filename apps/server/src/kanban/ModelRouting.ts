/**
 * Deterministic provider/roster facts shared by Hermes routing and launch
 * validation. This module intentionally makes no semantic routing decision.
 */
import type { BoardModelRosterEntry, ProviderOptionSelection } from "@t3tools/contracts";
import { usageProviderIdForInstance } from "@t3tools/shared/providerFamily";
import { stripMeasuredClaims } from "@t3tools/shared/rosterRuleClaims";

import type { UsageResponse } from "../usage/UsageService.ts";

export type RouteModelCandidate = {
  readonly instanceId: string;
  readonly model: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly installed?: boolean;
  readonly authOk?: boolean;
};

/** Measured `$/Mtok` tiers keyed by `instanceId::model`. Built by the budget table. */
export type MeasuredCostTiers = ReadonlyMap<string, number | null>;

export function measuredCostKey(instanceId: string, model: string): string {
  return `${instanceId}::${model}`;
}

/** Measured display tier, or neutral/unmeasured when no price fact exists. */
export function tierFor(
  candidate: { instanceId: string; model: string; name?: string },
  measured: MeasuredCostTiers | undefined,
): { tier: 1 | 2 | 3 | 4; basis: "measured" | "unmeasured" } {
  const hit = measured?.get(measuredCostKey(candidate.instanceId, candidate.model));
  if (typeof hit === "number" && hit >= 1 && hit <= 4) {
    return { tier: Math.round(hit) as 1 | 2 | 3 | 4, basis: "measured" };
  }
  return { tier: 2, basis: "unmeasured" };
}

export { usageProviderIdForInstance };

export function primaryUtilization(
  provider: UsageResponse["providers"][string] | undefined,
): number | null {
  if (!provider?.resources) return null;
  const preferred = ["session", "weekly", "daily", "totalUsage", "monthly", "credits", "balance"];
  for (const id of preferred) {
    const resource = provider.resources[id];
    if (!resource) continue;
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
    if (resource.kind === "balance" && typeof resource.available === "number") {
      if (resource.available <= 0) return 1;
      return null;
    }
  }
  return null;
}

/** Fail-open when usage unknown; hard-block exhausted/unauthorized families. */
export function providerFamilyUsable(
  usage: UsageResponse | null | undefined,
  instanceId: string,
): { ok: boolean; detail: string | null } {
  if (!usage) return { ok: true, detail: null };
  const family = usageProviderIdForInstance(instanceId);

  if (family === "opencode") {
    const unauthorized = usage.errors.find(
      (error) => error.providerId === family && error.code === "unauthorized",
    );
    if (unauthorized) return { ok: false, detail: unauthorized.message };
    return { ok: true, detail: null };
  }

  const unauthorized = usage.errors.find(
    (error) => error.providerId === family && error.code === "unauthorized",
  );
  if (unauthorized) return { ok: false, detail: unauthorized.message };

  const provider = usage.providers[family];
  if (!provider) return { ok: true, detail: null };

  for (const resource of Object.values(provider.resources)) {
    if (
      resource.kind === "balance" &&
      typeof resource.available === "number" &&
      resource.available <= 0
    ) {
      return { ok: false, detail: `${family} balance exhausted` };
    }
    const util =
      typeof resource.utilization === "number"
        ? resource.utilization
        : typeof resource.used === "number" &&
            typeof resource.limit === "number" &&
            resource.limit > 0
          ? resource.used / resource.limit
          : null;
    if (util !== null && util >= 0.98) {
      return { ok: false, detail: `${family} rate limit exhausted` };
    }
  }
  return { ok: true, detail: null };
}

/**
 * The roster as a lookup: preference rank (array order) and the owner's rule
 * for each model. Absent from the map means "not on the roster".
 *
 * The rule is stripped of speed, capability and cost claims on the way through.
 * Every consumer of a seat's note goes through here, so a "Very fast, Low IQ,
 * $$$" typed before the guard existed still cannot reach a routing decision —
 * the measured facts on the same line already answer all three, and they stay
 * true when the model or the price changes.
 */
type RosterIndex = ReadonlyMap<
  string,
  {
    readonly rank: number;
    readonly note: string;
    readonly options: ReadonlyArray<ProviderOptionSelection>;
    readonly effortRange: { readonly min: string; readonly max: string } | null;
  }
>;

export function buildRosterIndex(
  roster: ReadonlyArray<BoardModelRosterEntry> | undefined,
): RosterIndex {
  const index = new Map<
    string,
    {
      rank: number;
      note: string;
      options: ReadonlyArray<ProviderOptionSelection>;
      effortRange: { min: string; max: string } | null;
    }
  >();
  (roster ?? []).forEach((entry, rank) => {
    index.set(measuredCostKey(entry.instanceId, entry.model), {
      rank,
      note: stripMeasuredClaims(entry.note ?? ""),
      options: entry.options ?? [],
      effortRange: entry.effortRange ?? null,
    });
  });
  return index;
}

/** How a rule's provider options read in a prompt block. */
export function formatRosterOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): string {
  return (options ?? []).map((option) => `${option.id}=${String(option.value)}`).join(" ");
}

const onRoster = (candidate: { instanceId: string; model: string }, index: RosterIndex) =>
  index.has(measuredCostKey(candidate.instanceId, candidate.model));

function isReady(candidate: RouteModelCandidate): boolean {
  if (!candidate.enabled) return false;
  if (candidate.installed === false) return false;
  if (candidate.authOk === false) return false;
  return candidate.model.trim().length > 0 && candidate.instanceId.trim().length > 0;
}

/**
 * Sourced capability and speed for one route, keyed `instanceId::model`.
 * Benchmark snapshot and observed turns only — never a model-name guess.
 */
export type ModelEvidence = {
  readonly scores: Readonly<Record<string, number | null>>;
  readonly benchSource: string | null;
  readonly medianTurnMs: number | null;
  readonly sampleCount: number;
  /** Observed output tokens per second — emission speed, not time to done. */
  readonly tokensPerSecond: number | null;
  readonly throughputSamples: number;
};

export type ModelEvidenceIndex = ReadonlyMap<string, ModelEvidence>;

/**
 * `bench=coding:63.4,it:22 speed=41s(n=9) tps=112(n=8)`, with unknowns said out
 * loud. Only measured axes are listed — an axis nobody benchmarked must not
 * read as zero, and `tps` is emission speed only.
 */
function formatEvidence(evidence: ModelEvidence | undefined): string {
  const measured = Object.entries(evidence?.scores ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([axis, score]) => `${axis}:${score}`);
  const bench =
    measured.length === 0
      ? "bench=unknown"
      : `bench=${measured.join(",")}(${evidence?.benchSource ?? "snapshot"})`;
  const speed =
    evidence?.medianTurnMs === null || evidence?.medianTurnMs === undefined
      ? "speed=unknown"
      : `speed=${Math.round(evidence.medianTurnMs / 1000)}s(n=${evidence.sampleCount})`;
  const throughput =
    evidence?.tokensPerSecond === null || evidence?.tokensPerSecond === undefined
      ? "tps=unknown"
      : `tps=${Math.round(evidence.tokensPerSecond)}(n=${evidence.throughputSamples})`;
  return `${bench} ${speed} ${throughput}`;
}

/**
 * Read above the model list so `tps` cannot be mistaken for the thing to rank
 * on. It is the one fact here that invites the wrong inference: a route that
 * emits twice as fast still loses when it needs three times the turns.
 */
const EVIDENCE_LEGEND =
  "# bench=benchmark score per axis · speed=median turn · tps=output tokens/second." +
  " tps is emission speed only: it does not say a task finishes sooner or for less." +
  " Rank on the route's cost/task and time/task in the routing brief.";

/** Format AVAILABLE MODELS block for Hermes / MCP. */
export function formatAvailableModelsBlock(
  candidates: ReadonlyArray<RouteModelCandidate>,
  usage?: UsageResponse | null,
  measuredCostTiers?: MeasuredCostTiers,
  roster?: { entries: ReadonlyArray<BoardModelRosterEntry>; enforced: boolean },
  evidence?: ModelEvidenceIndex,
): string {
  if (candidates.length === 0) return "(no provider models reported)";
  const rosterIndex = buildRosterIndex(roster?.entries);
  const rostered = candidates.filter(
    (candidate) => isReady(candidate) && onRoster(candidate, rosterIndex),
  );
  // Hermes must not be told about a model it is not allowed to spend on.
  const enforcing = roster?.enforced === true;
  const listed = enforcing ? rostered : candidates;
  const lines: string[] = [];
  for (const candidate of listed) {
    if (!isReady(candidate)) continue;
    const seat = rosterIndex.get(measuredCostKey(candidate.instanceId, candidate.model));
    const use = seat && seat.note.length > 0 ? ` use="${seat.note.replace(/"/g, "'")}"` : "";
    const band = seat?.effortRange
      ? ` effortChoices=${seat.effortRange.min}..${seat.effortRange.max}`
      : "";
    const opts =
      (seat && seat.options.length > 0 ? ` ${formatRosterOptions(seat.options)}` : "") + band;
    const family = usageProviderIdForInstance(candidate.instanceId);
    const usable = providerFamilyUsable(usage, candidate.instanceId);
    const util = primaryUtilization(usage?.providers[family]);
    const priced = tierFor(candidate, measuredCostTiers);
    const utilLabel = util === null ? "usage=?" : `util=${Math.round(util * 100)}%`;
    const status = usable.ok ? "ok" : `blocked:${usable.detail ?? "unusable"}`;
    const facts = formatEvidence(
      evidence?.get(measuredCostKey(candidate.instanceId, candidate.model)),
    );
    lines.push(
      `- instanceId=${candidate.instanceId} model=${candidate.model} name=${candidate.name}${use}${opts} cost=$${priced.tier}(${priced.basis}) ${facts} ${utilLabel} ${status}`,
    );
  }
  return lines.length > 0 ? [EVIDENCE_LEGEND, ...lines].join("\n") : "(no ready models)";
}

export function formatUsageBlock(usage: UsageResponse | null | undefined): string {
  if (!usage) return "(usage unavailable)";
  const lines: string[] = [];
  for (const [id, provider] of Object.entries(usage.providers)) {
    const windows = Object.entries(provider.resources)
      .filter(
        ([, resource]) =>
          resource.kind === "consumption" && typeof resource.utilization === "number",
      )
      .map(
        ([resourceId, resource]) =>
          `${resourceId}=${Math.round((resource.utilization as number) * 100)}%${
            resource.resetsAt ? ` resets=${resource.resetsAt}` : ""
          }`,
      );
    const util = primaryUtilization(provider);
    const summary =
      windows.length > 0
        ? windows.join(" · ")
        : `util=${util === null ? "?" : `${Math.round(util * 100)}%`}`;
    lines.push(
      `- ${id} (${provider.displayName}${provider.plan ? ` · ${provider.plan}` : ""}): ${summary}`,
    );
  }
  for (const error of usage.errors) {
    lines.push(`- error ${error.providerId ?? "?"}: ${error.code} ${error.message}`.trim());
  }
  return lines.length > 0 ? lines.join("\n") : "(no usage rows)";
}

export function candidatesFromShellProviders(
  providers: ReadonlyArray<{
    instanceId?: string;
    id?: string;
    enabled?: boolean;
    installed?: boolean;
    auth?: { status?: string } | string | null;
    models?: ReadonlyArray<{ slug: string; name?: string }>;
  }>,
): RouteModelCandidate[] {
  const out: RouteModelCandidate[] = [];
  for (const provider of providers) {
    const instanceId = String(provider.instanceId ?? provider.id ?? "").trim();
    if (!instanceId) continue;
    const authStatus =
      typeof provider.auth === "string"
        ? provider.auth
        : provider.auth && typeof provider.auth === "object"
          ? provider.auth.status
          : undefined;
    const authOk =
      authStatus === undefined || authStatus === "authenticated" || authStatus === "ok";
    for (const model of provider.models ?? []) {
      if (!model.slug?.trim()) continue;
      out.push({
        instanceId,
        model: model.slug,
        name: model.name?.trim() || model.slug,
        enabled: provider.enabled !== false,
        installed: provider.installed !== false,
        authOk,
      });
    }
  }
  return out;
}
