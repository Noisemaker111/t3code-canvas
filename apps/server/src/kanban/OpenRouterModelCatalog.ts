/**
 * OpenRouter model catalog (pricing + context) for Board model-bench.
 * Authenticates with the shared provider credential table.
 */
import { resolveProviderKey } from "../usage/UsageService.ts";

export type OpenRouterCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
  /** USD per 1M prompt tokens */
  readonly promptUsdPerMTok: number | null;
  /** USD per 1M completion tokens */
  readonly completionUsdPerMTok: number | null;
  readonly isFree: boolean;
};

type CatalogCache = {
  fetchedAtMs: number;
  entries: ReadonlyArray<OpenRouterCatalogEntry>;
};

const CACHE_TTL_MS = 30 * 60_000;
let cache: CatalogCache | undefined;

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Map OpenCode slug `openrouter/org/model` → OpenRouter id `org/model`. */
export function openRouterIdFromSlug(slug: string): string | null {
  const trimmed = slug.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("openrouter/")) return trimmed.slice("openrouter/".length);
  // Already org/model style
  if (trimmed.includes("/") && !trimmed.startsWith("opencode/")) return trimmed;
  return null;
}

export function estimateUsdCost(input: {
  promptTokens: number;
  completionTokens: number;
  entry: OpenRouterCatalogEntry | null;
}): number | null {
  if (!input.entry) return null;
  const p = input.entry.promptUsdPerMTok;
  const c = input.entry.completionUsdPerMTok;
  if (p === null && c === null) return null;
  const prompt = ((p ?? 0) * input.promptTokens) / 1_000_000;
  const completion = ((c ?? 0) * input.completionTokens) / 1_000_000;
  return Math.round((prompt + completion) * 1_000_000) / 1_000_000;
}

export function estimateTokensFromText(text: string): number {
  // Rough tokenizer stand-in for ranking; not billed accuracy.
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function getOpenRouterCatalog(options?: {
  force?: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}): Promise<{
  entries: ReadonlyArray<OpenRouterCatalogEntry>;
  byId: Map<string, OpenRouterCatalogEntry>;
  error?: string;
}> {
  const now = Date.now();
  if (!options?.force && cache && now - cache.fetchedAtMs < CACHE_TTL_MS) {
    return {
      entries: cache.entries,
      byId: new Map(cache.entries.map((e) => [e.id, e])),
    };
  }

  const key = await resolveProviderKey("openrouter", {
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
      headers: {
        Accept: "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
    if (!response.ok) {
      return {
        entries: cache?.entries ?? [],
        byId: new Map((cache?.entries ?? []).map((e) => [e.id, e])),
        error: `OpenRouter models returned ${response.status}`,
      };
    }
    const body = (await response.json()) as { data?: unknown };
    const rows = Array.isArray(body.data) ? body.data : [];
    const entries: OpenRouterCatalogEntry[] = [];
    for (const row of rows) {
      const item = object(row);
      if (!item) continue;
      const id = string(item.id);
      if (!id) continue;
      const pricing = object(item.pricing) ?? {};
      // OpenRouter prices are USD per token as strings (e.g. "0.000003").
      const promptPerTok = number(pricing.prompt);
      const completionPerTok = number(pricing.completion);
      const promptUsdPerMTok =
        promptPerTok === undefined ? null : Math.round(promptPerTok * 1_000_000 * 1e6) / 1e6;
      const completionUsdPerMTok =
        completionPerTok === undefined
          ? null
          : Math.round(completionPerTok * 1_000_000 * 1e6) / 1e6;
      const isFree =
        (promptPerTok === 0 || promptPerTok === undefined) &&
        (completionPerTok === 0 || completionPerTok === undefined) &&
        id.includes(":free");
      entries.push({
        id,
        name: string(item.name) ?? id,
        contextLength: number(item.context_length) ?? null,
        promptUsdPerMTok,
        completionUsdPerMTok,
        isFree: isFree || (promptUsdPerMTok === 0 && completionUsdPerMTok === 0),
      });
    }
    cache = { fetchedAtMs: now, entries };
    return { entries, byId: new Map(entries.map((e) => [e.id, e])) };
  } catch (cause) {
    return {
      entries: cache?.entries ?? [],
      byId: new Map((cache?.entries ?? []).map((e) => [e.id, e])),
      error: cause instanceof Error ? cause.message : "Failed to load OpenRouter catalog",
    };
  }
}
