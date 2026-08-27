/**
 * Model bench client: OpenRouter streaming results (TTFT, tokens, cost, Intel).
 * Default fixture is structure (ramble → mission). Hermes brief optional.
 * Persists trial history in localStorage.
 */

export type ModelBenchRole = "hermes" | "structure";

export type ModelBenchFixtureMode = "structure" | "hermes";

export type ModelBenchCandidate = {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
};

/**
 * Paid, semi-cheap OpenRouter model ids for structure bench.
 * Sourced from live OpenRouter `/api/v1/models` (specific versioned ids only —
 * no free tier, no bare `deepseek/deepseek-chat`, no Gemini 2.x leftovers).
 *
 * Approx list prices (USD / 1M tokens, prompt→completion) at catalog pull:
 * - openai/gpt-5.4-mini 0.75→4.50 · gpt-5-mini 0.25→2 · gpt-4.1-mini 0.40→1.60
 * - anthropic/claude-haiku-4.5 1→5
 * - google/gemini-3.6-flash 1.50→7.50 · 3.5-flash 1.50→9 · 3.5-flash-lite 0.30→2.50
 * - x-ai/grok-4.3 1.25→2.50 · grok-build-0.1 1→2
 * - deepseek/deepseek-v4-flash 0.10→0.20 · v4-pro 0.44→0.87 · v3.2 0.27→0.40
 * - qwen/qwen3.6-flash · qwen3-coder-flash · qwen3-coder-next
 * - mistralai/mistral-small-2603 · devstral-2512 · medium-3.1
 */
export const SEMI_CHEAP_OPENROUTER_IDS: ReadonlyArray<string> = [
  // OpenAI — current mini/coding tier
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  // Anthropic — current Haiku only (not legacy claude-3-haiku unless needed as fill)
  "anthropic/claude-haiku-4.5",
  // Google — current 3.x flash line (not 2.5 / 2.0)
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3-flash-preview",
  // xAI
  "x-ai/grok-4.3",
  "x-ai/grok-4.20",
  "x-ai/grok-build-0.1",
  // DeepSeek — versioned only (never bare deepseek/deepseek-chat)
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-chat-v3.1",
  // Qwen — flash / coder SKUs
  "qwen/qwen3.6-flash",
  "qwen/qwen3-coder-flash",
  "qwen/qwen3-coder-next",
  "qwen/qwen3.7-plus",
  "qwen/qwen3-coder-30b-a3b-instruct",
  // Mistral — dated/versioned
  "mistralai/mistral-small-2603",
  "mistralai/devstral-2512",
  "mistralai/mistral-medium-3.1",
  "mistralai/codestral-2508",
  // Strong cheap general
  "z-ai/glm-5.1",
  "moonshotai/kimi-k2.6",
  "minimax/minimax-m3",
];

/** Prompt USD/MTok band for “semi-cheap paid” when filtering the live catalog. */
export const SEMI_CHEAP_PROMPT_USD_MIN = 0.05;
export const SEMI_CHEAP_PROMPT_USD_MAX = 2.5;
export const SEMI_CHEAP_COMPLETION_USD_MAX = 12;

export function isSemiCheapCatalogEntry(entry: {
  id?: string;
  isFree: boolean;
  promptUsdPerMTok: number | null;
  completionUsdPerMTok: number | null;
}): boolean {
  if (entry.isFree) return false;
  const id = (entry.id ?? "").toLowerCase();
  if (id.includes(":free") || id.includes("image") || id.includes("audio")) return false;
  if (id.startsWith("~")) return false;
  // Reject vague / legacy routing aliases we do not want as defaults
  if (id === "deepseek/deepseek-chat") return false;
  if (id.includes("gemini-2.0") || id.includes("gemini-2.5-flash") || id.includes("gemini-2.5-pro"))
    return false;
  const p = entry.promptUsdPerMTok;
  const c = entry.completionUsdPerMTok;
  if (p === null || c === null) return false;
  if (p <= 0 || c <= 0) return false;
  return (
    p >= SEMI_CHEAP_PROMPT_USD_MIN &&
    p <= SEMI_CHEAP_PROMPT_USD_MAX &&
    c <= SEMI_CHEAP_COMPLETION_USD_MAX
  );
}

/** Match composer option slug to a curated OpenRouter id (never free variants). */
export function slugMatchesOpenRouterId(slug: string, openRouterId: string): boolean {
  const s = slug.toLowerCase();
  const id = openRouterId.toLowerCase();
  if (isExcludedBenchSlug(s) || isExcludedBenchSlug(id)) return false;
  return s === id || s === `openrouter/${id}` || s.endsWith(`/${id}`);
}

function isFreeSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  return s.includes(":free") || s.endsWith("/free") || s.includes("/free/");
}

/** Free, image/audio, alias (~), or known-bad vague ids. */
export function isExcludedBenchSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  if (isFreeSlug(s)) return true;
  if (s.startsWith("~") || s.includes("/~")) return true;
  if (s.includes("image") || s.includes("audio") || s.includes("whisper")) return true;
  if (s.endsWith("/deepseek-chat") || s.endsWith("deepseek/deepseek-chat")) return true;
  if (s.includes("gemini-2.0") || s.includes("gemini-2.5-flash") || s.includes("gemini-2.5-pro"))
    return true;
  if (s.includes("claude-3-haiku") || s.includes("claude-3.5-haiku")) return true;
  if (s.includes("gpt-4o-mini") && !s.includes("gpt-4.1")) return true; // prefer 4.1/5.x minis
  return false;
}

export type IntelligenceDimensions = {
  readonly fidelity: number;
  readonly reasoning: number;
  readonly actionability: number;
  readonly completeness: number;
};

export type ModelBenchTrialResult = {
  readonly role: ModelBenchRole;
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly openRouterId: string | null;
  readonly ok: boolean;
  /** Headers → first content token (excludes provider queue). */
  readonly ttftMs: number | null;
  /** Request start → response headers (queue + network). */
  readonly headersMs?: number | null;
  /** Request start → stream end. */
  readonly completionMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
  readonly costSource: "usage+list_price" | "estimated_tokens+list_price" | "unknown";
  readonly tokensSource: "openrouter_usage" | "tiktoken" | "none";
  /** Format/structure only (JSON shape, headings). */
  readonly structureScore?: number;
  /** LLM-judge 0–100. Null if judge skipped/failed. */
  readonly intelligenceScore?: number | null;
  readonly intelligence?: IntelligenceDimensions | null;
  readonly intelligenceNote?: string | null;
  readonly judgeModel?: string | null;
  /** Legacy alias of structureScore. */
  readonly qualityScore: number;
  readonly outputPreview: string;
  readonly error?: string;
  readonly ranAt: string;
  readonly runId?: string;
};

export type OpenRouterCatalogWire = {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly contextLength: number | null;
    readonly promptUsdPerMTok: number | null;
    readonly completionUsdPerMTok: number | null;
    readonly isFree: boolean;
  }>;
  readonly error?: string;
};

/** Side-by-side row for one model (structure and/or hermes roles). */
export type ModelBenchCompareRow = {
  readonly model: string;
  readonly label: string;
  readonly instanceId: string;
  readonly structure: ModelBenchTrialResult | null;
  readonly hermes: ModelBenchTrialResult | null;
  readonly combinedRank: number;
};

const STORAGE_KEY = "t3.modelBench.results.v4";
const LEGACY_STORAGE_KEYS = [
  "t3.modelBench.results.v3",
  "t3.modelBench.results.v2",
  "t3.modelBench.results.v1",
] as const;
const MAX_HISTORY = 400;

export function structureOf(result: ModelBenchTrialResult): number {
  return result.structureScore ?? result.qualityScore ?? 0;
}

export function intelligenceOf(result: ModelBenchTrialResult): number | null {
  if (typeof result.intelligenceScore === "number") return result.intelligenceScore;
  return null;
}

/**
 * Rank for pick-a-winner. Intelligence dominates when present; structure is a
 * light tie-breaker. Speed/cost still matter but cannot bury a dumb plan.
 */
export function rankScore(result: ModelBenchTrialResult): number {
  if (!result.ok) return -1;
  const intel = intelligenceOf(result);
  const structure = structureOf(result);
  const latency = result.completionMs;
  const latencyScore = Math.max(0, 40 - latency / 1000);
  const costScore =
    result.costUsd === null
      ? 10
      : result.costUsd === 0
        ? 25
        : Math.max(0, 20 - Math.log10(result.costUsd * 1_000_000 + 1) * 4);
  const ttftBonus = result.ttftMs === null ? 0 : Math.max(0, 8 - result.ttftMs / 500);
  if (intel !== null) {
    return (
      intel * 0.55 + structure * 0.1 + latencyScore * 0.15 + costScore * 0.12 + ttftBonus * 0.08
    );
  }
  // No judge: fall back to structure-weighted rank.
  return structure * 0.5 + latencyScore * 0.22 + costScore * 0.2 + ttftBonus * 0.08;
}

export function readBenchHistory(): ReadonlyArray<ModelBenchTrialResult> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as ModelBenchTrialResult[];
    }
    for (const key of LEGACY_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    return [];
  } catch {
    return [];
  }
}

export function writeBenchHistory(results: ReadonlyArray<ModelBenchTrialResult>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(results.slice(-MAX_HISTORY)));
  } catch {
    /* quota */
  }
}

export function appendBenchHistory(
  trials: ReadonlyArray<ModelBenchTrialResult>,
): ReadonlyArray<ModelBenchTrialResult> {
  const next = [...readBenchHistory(), ...trials];
  writeBenchHistory(next);
  return next;
}

export function clearBenchHistory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function groupCompareRows(
  trials: ReadonlyArray<ModelBenchTrialResult>,
  runId?: string,
): ReadonlyArray<ModelBenchCompareRow> {
  // Drop trials from retired roles (old saved history may still carry them).
  const known = runId ? trials.filter((t) => t.runId === runId) : trials;
  const filtered = known.filter((t) => t.role === "structure" || t.role === "hermes");
  const byModel = new Map<
    string,
    {
      model: string;
      label: string;
      instanceId: string;
      structure: ModelBenchTrialResult | null;
      hermes: ModelBenchTrialResult | null;
    }
  >();
  for (const t of filtered) {
    const key = `${t.instanceId}:${t.model}`;
    const existing = byModel.get(key) ?? {
      model: t.model,
      label: t.label,
      instanceId: t.instanceId,
      structure: null,
      hermes: null,
    };
    byModel.set(key, {
      ...existing,
      structure: t.role === "structure" ? t : existing.structure,
      hermes: t.role === "hermes" ? t : existing.hermes,
    });
  }
  return [...byModel.values()]
    .map((row) => {
      const scores = [row.structure, row.hermes]
        .filter((r): r is ModelBenchTrialResult => Boolean(r?.ok))
        .map(rankScore);
      const combinedRank =
        scores.length === 0 ? -1 : scores.reduce((a, b) => a + b, 0) / scores.length;
      return { ...row, combinedRank };
    })
    .toSorted((a, b) => b.combinedRank - a.combinedRank);
}

/**
 * Pick semi-cheap paid models from composer options using curated ids + catalog prices.
 */
export function pickSemiCheapModelSlugs(input: {
  optionSlugs: ReadonlyArray<string>;
  catalogEntries?: ReadonlyArray<{
    id: string;
    isFree: boolean;
    promptUsdPerMTok: number | null;
    completionUsdPerMTok: number | null;
  }>;
  max?: number;
}): ReadonlyArray<string> {
  const max = input.max ?? 10;
  const slugs = input.optionSlugs;
  const picked: string[] = [];
  const used = new Set<string>();

  const take = (slug: string) => {
    if (isExcludedBenchSlug(slug) || used.has(slug) || picked.length >= max) return;
    used.add(slug);
    picked.push(slug);
  };

  // 1) Curated live-catalog list in order
  for (const id of SEMI_CHEAP_OPENROUTER_IDS) {
    const match =
      slugs.find((s) => !isExcludedBenchSlug(s) && s.toLowerCase() === `openrouter/${id}`) ??
      slugs.find((s) => slugMatchesOpenRouterId(s, id));
    if (match) take(match);
  }

  // 2) Fill from catalog-priced semi-cheap (skip free / image / legacy)
  if (picked.length < max && input.catalogEntries) {
    const priced = [...input.catalogEntries]
      .filter((e) => isSemiCheapCatalogEntry(e))
      .toSorted((a, b) => (a.promptUsdPerMTok ?? 99) - (b.promptUsdPerMTok ?? 99));
    for (const entry of priced) {
      const match =
        slugs.find(
          (s) =>
            !isExcludedBenchSlug(s) && s.toLowerCase() === `openrouter/${entry.id.toLowerCase()}`,
        ) ?? slugs.find((s) => slugMatchesOpenRouterId(s, entry.id));
      if (match) take(match);
    }
  }

  return picked;
}

export async function fetchOpenRouterCatalog(): Promise<OpenRouterCatalogWire> {
  const response = await fetch("/api/model-bench/catalog", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    return { entries: [], error: `Catalog HTTP ${response.status}` };
  }
  return (await response.json()) as OpenRouterCatalogWire;
}

export async function runServerModelBench(input: {
  candidates: ReadonlyArray<ModelBenchCandidate>;
  roles?: ReadonlyArray<ModelBenchRole>;
}): Promise<{ trials: ModelBenchTrialResult[]; error?: string }> {
  const response = await fetch("/api/model-bench/run", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidates: input.candidates,
      roles: input.roles ?? ["structure"],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { trials: [], error: `Bench HTTP ${response.status}: ${text.slice(0, 160)}` };
  }
  const body = (await response.json()) as { trials?: ModelBenchTrialResult[]; error?: string };
  return {
    trials: Array.isArray(body.trials) ? body.trials : [],
    ...(body.error ? { error: body.error } : {}),
  };
}

/** Prefer structure → hermes for single-column views. */
export function primaryTrial(row: ModelBenchCompareRow): ModelBenchTrialResult | null {
  return row.structure ?? row.hermes;
}

export type BenchHighlightField = "ttft" | "done" | "cost" | "fmt" | "intel";

export function metricNumeric(
  t: ModelBenchTrialResult | null | undefined,
  field: BenchHighlightField,
): number | null {
  if (!t?.ok) return null;
  switch (field) {
    case "ttft":
      return typeof t.ttftMs === "number" && Number.isFinite(t.ttftMs) ? t.ttftMs : null;
    case "done":
      return Number.isFinite(t.completionMs) ? t.completionMs : null;
    case "cost":
      return typeof t.costUsd === "number" && Number.isFinite(t.costUsd) ? t.costUsd : null;
    case "fmt": {
      const v = t.structureScore ?? t.qualityScore;
      return typeof v === "number" ? v : null;
    }
    case "intel":
      return typeof t.intelligenceScore === "number" ? t.intelligenceScore : null;
    default:
      return null;
  }
}

/**
 * Rank keys `${instanceId}:${model}` as 1st / 2nd for a metric.
 * Lower is better for ttft/done/cost; higher for fmt/intel.
 */
export function computeMetricPodium(
  rows: ReadonlyArray<ModelBenchCompareRow>,
  field: BenchHighlightField,
  getTrial: (row: ModelBenchCompareRow) => ModelBenchTrialResult | null = primaryTrial,
): ReadonlyMap<string, 1 | 2> {
  const lowerBetter = field === "ttft" || field === "done" || field === "cost";
  const scored = rows
    .map((row) => {
      const v = metricNumeric(getTrial(row), field);
      return v === null ? null : { key: `${row.instanceId}:${row.model}`, v };
    })
    .filter((x): x is { key: string; v: number } => x !== null)
    .toSorted((a, b) => (lowerBetter ? a.v - b.v : b.v - a.v));

  const out = new Map<string, 1 | 2>();
  if (scored[0]) out.set(scored[0].key, 1);
  if (scored[1] && scored[1].key !== scored[0]?.key) out.set(scored[1].key, 2);
  return out;
}

export type BenchProgressSlot = {
  readonly key: string;
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly status: "queued" | "running" | "done" | "error";
  readonly error?: string;
};

/**
 * Run candidates one-by-one (optionally concurrent) and call onTrial as each
 * model finishes so the UI can insert rows progressively.
 */
export async function runServerModelBenchProgressive(input: {
  candidates: ReadonlyArray<ModelBenchCandidate>;
  roles?: ReadonlyArray<ModelBenchRole>;
  concurrency?: number;
  onTrial: (trials: ReadonlyArray<ModelBenchTrialResult>, candidate: ModelBenchCandidate) => void;
  onSlot?: (slot: BenchProgressSlot) => void;
  signal?: AbortSignal;
}): Promise<{ errors: number }> {
  const roles = input.roles ?? (["structure"] as const);
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 2, 4));
  let errors = 0;
  let cursor = 0;
  const list = input.candidates;

  const worker = async () => {
    while (cursor < list.length) {
      if (input.signal?.aborted) return;
      const i = cursor;
      cursor += 1;
      const candidate = list[i];
      if (!candidate) return;
      const key = `${candidate.instanceId}:${candidate.model}`;
      input.onSlot?.({
        key,
        instanceId: candidate.instanceId,
        model: candidate.model,
        label: candidate.label,
        status: "running",
      });
      const { trials, error } = await runServerModelBench({
        candidates: [candidate],
        roles: [...roles],
      });
      if (input.signal?.aborted) return;
      if (error || trials.length === 0) {
        errors += 1;
        input.onSlot?.({
          key,
          instanceId: candidate.instanceId,
          model: candidate.model,
          label: candidate.label,
          status: "error",
          error: error ?? "No trials",
        });
        continue;
      }
      input.onTrial(trials, candidate);
      input.onSlot?.({
        key,
        instanceId: candidate.instanceId,
        model: candidate.model,
        label: candidate.label,
        status: "done",
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));
  return { errors };
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format bench cost as dollars. Always `$…` — never scientific notation
 * (`$1.2e-5`). Tiny amounts just get more fixed decimals.
 */
export function formatUsd(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "—";
  if (cost === 0) return "$0";
  const abs = Math.abs(cost);
  const sign = cost < 0 ? "-" : "";
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.0001) return `${sign}$${trimFixed(abs, 6)}`;
  // Was toExponential — keep fixed dollars instead.
  if (abs >= 1e-8) return `${sign}$${trimFixed(abs, 8)}`;
  return `${sign}<$0.00000001`;
}

/** Full exact dollars for tooltips (still no scientific notation). */
export function formatUsdExact(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "—";
  if (cost === 0) return "$0";
  const abs = Math.abs(cost);
  const sign = cost < 0 ? "-" : "";
  if (abs >= 0.01) return `${sign}$${abs.toFixed(6).replace(/\.?0+$/, "")}`;
  return `${sign}$${abs.toFixed(8).replace(/\.?0+$/, "")}`;
}

function trimFixed(n: number, maxDp: number): string {
  const factor = 10 ** maxDp;
  const rounded = Math.round((n + Number.EPSILON) * factor) / factor;
  const s = rounded.toFixed(maxDp);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}
