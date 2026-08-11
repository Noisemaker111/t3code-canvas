/**
 * Two currencies, kept apart.
 *
 * API-routed models bill USD at the catalog's `$/Mtok`. Subscription CLIs have
 * marginal USD ≈ 0 and burn plan quota instead; their catalog price is a list
 * price used for ranking, never as a bill. One number cannot describe both, and
 * pretending otherwise is what makes routing lie.
 *
 * @module kanban/budget/pricing
 */
import {
  FAMILY_ORG_PREFIX,
  isSubscriptionFamily,
  usageProviderIdForInstance,
} from "@t3tools/shared/providerFamily";

import type { OpenRouterCatalogEntry } from "../OpenRouterModelCatalog.ts";
import { openRouterIdFromSlug } from "../OpenRouterModelCatalog.ts";
import { measuredCostKey, type MeasuredCostTiers } from "../ModelRouting.ts";
import { costTierFromPrice, type PriceRow } from "./measurements.ts";

export function isSubscriptionHarness(instanceId: string): boolean {
  return isSubscriptionFamily(usageProviderIdForInstance(instanceId));
}

/**
 * Find a catalog row for a harness's model slug. CLI harnesses report bare
 * slugs (`claude-sonnet-4-5`), so the provider family supplies the org prefix.
 * No match means the price is unknown — not a guess.
 */
export function resolveCatalogEntry(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly byId: ReadonlyMap<string, OpenRouterCatalogEntry>;
}): OpenRouterCatalogEntry | null {
  const direct = openRouterIdFromSlug(input.model);
  if (direct) {
    const hit = input.byId.get(direct);
    if (hit) return hit;
  }
  const slug = input.model.trim().toLowerCase();
  if (!slug) return null;
  const org = FAMILY_ORG_PREFIX[usageProviderIdForInstance(input.instanceId)];
  if (org) {
    const hit = input.byId.get(`${org}/${slug}`);
    if (hit) return hit;
  }
  for (const [id, entry] of input.byId) {
    if (id.endsWith(`/${slug}`)) return entry;
  }
  return null;
}

/**
 * Catalog-price tiers for a launch's candidate pool, keyed `instanceId::model`.
 * Computed at launch time so routing is measured from the first card on a
 * fresh box, not only after a tick or a panel visit has warmed a cache.
 */
export function measuredTiersForCandidates(
  candidates: ReadonlyArray<{ instanceId: string; model: string }>,
  byId: ReadonlyMap<string, OpenRouterCatalogEntry>,
): MeasuredCostTiers {
  return new Map(
    candidates.map((candidate) => [
      measuredCostKey(candidate.instanceId, candidate.model),
      costTierFromPrice(
        priceForHarness({ instanceId: candidate.instanceId, model: candidate.model, byId }),
      ),
    ]),
  );
}

export function priceForHarness(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly byId: ReadonlyMap<string, OpenRouterCatalogEntry>;
}): PriceRow {
  const entry = resolveCatalogEntry(input);
  if (!entry) {
    return { usdPerMTokIn: null, usdPerMTokOut: null, source: "unknown" };
  }
  return {
    usdPerMTokIn: entry.promptUsdPerMTok,
    usdPerMTokOut: entry.completionUsdPerMTok,
    source: isSubscriptionHarness(input.instanceId) ? "subscription" : "openrouter",
  };
}
