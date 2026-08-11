/**
 * Model prices from the models.dev snapshot Install writes to disk, with the
 * live OpenRouter catalog as fallback.
 *
 * The snapshot covers every provider (Anthropic, OpenAI, xAI, …) rather than
 * only what OpenRouter proxies, and reading it costs no network call — which is
 * what makes refreshing the budget table cheap enough to do on a tick.
 *
 * @module kanban/ModelPriceCatalog
 */
import * as NodeFSP from "node:fs/promises";

import type { OpenRouterCatalogEntry } from "./OpenRouterModelCatalog.ts";
import { getOpenRouterCatalog } from "./OpenRouterModelCatalog.ts";

const DEFAULT_SNAPSHOT_PATH = "/opt/t3j/models-dev.json";

export function modelCatalogSnapshotPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.T3CODE_MODEL_CATALOG_FILE?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_SNAPSHOT_PATH;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * models.dev shape: `{ [providerId]: { models: { [modelId]: { cost: { input,
 * output }, limit: { context } } } } }`, costs already in USD per 1M tokens.
 * Anything that does not parse is skipped rather than guessed.
 */
export function parseModelsDevSnapshot(raw: unknown): ReadonlyMap<string, OpenRouterCatalogEntry> {
  const byId = new Map<string, OpenRouterCatalogEntry>();
  const providers = record(raw);
  if (!providers) return byId;

  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = record(providerValue);
    const models = record(provider?.models);
    if (!models) continue;

    for (const [modelId, modelValue] of Object.entries(models)) {
      const model = record(modelValue);
      if (!model) continue;
      const cost = record(model.cost);
      const limit = record(model.limit);
      const promptUsdPerMTok = num(cost?.input);
      const completionUsdPerMTok = num(cost?.output);
      const entry: OpenRouterCatalogEntry = {
        id: `${providerId}/${modelId}`,
        name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
        contextLength: num(limit?.context),
        promptUsdPerMTok,
        completionUsdPerMTok,
        isFree: promptUsdPerMTok === 0 && completionUsdPerMTok === 0,
      };
      // `resolveCatalogEntry` matches on `org/slug` and on a `/slug` suffix, so
      // both the provider-qualified id and the bare slug must resolve.
      byId.set(entry.id, entry);
      if (!byId.has(modelId)) byId.set(modelId, entry);
    }
  }
  return byId;
}

type Snapshot = {
  readonly mtimeMs: number;
  readonly byId: ReadonlyMap<string, OpenRouterCatalogEntry>;
};

let cached: Snapshot | null = null;

/** Re-reads only when Install has rewritten the file. */
export async function readModelCatalogSnapshot(
  path = modelCatalogSnapshotPath(),
): Promise<ReadonlyMap<string, OpenRouterCatalogEntry> | null> {
  try {
    const stat = await NodeFSP.stat(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.byId;
    const byId = parseModelsDevSnapshot(JSON.parse(await NodeFSP.readFile(path, "utf8")));
    if (byId.size === 0) return null;
    cached = { mtimeMs: stat.mtimeMs, byId };
    return byId;
  } catch {
    return null;
  }
}

/** Snapshot first; OpenRouter only when there is no usable snapshot. */
export async function getModelPriceCatalog(): Promise<ReadonlyMap<string, OpenRouterCatalogEntry>> {
  const snapshot = await readModelCatalogSnapshot();
  if (snapshot) return snapshot;
  const catalog = await getOpenRouterCatalog();
  return catalog.byId;
}
