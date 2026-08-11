import { describe, expect, it } from "@effect/vitest";

import type { OpenRouterCatalogEntry } from "../OpenRouterModelCatalog.ts";
import {
  isSubscriptionHarness,
  measuredTiersForCandidates,
  priceForHarness,
  resolveCatalogEntry,
} from "./pricing.ts";

const entry = (id: string, prompt: number, completion: number): OpenRouterCatalogEntry => ({
  id,
  name: id,
  contextLength: 200_000,
  promptUsdPerMTok: prompt,
  completionUsdPerMTok: completion,
  isFree: false,
});

const byId = new Map<string, OpenRouterCatalogEntry>([
  ["anthropic/claude-sonnet-4-5", entry("anthropic/claude-sonnet-4-5", 3, 15)],
  ["x-ai/grok-4.5", entry("x-ai/grok-4.5", 2, 10)],
]);

describe("resolveCatalogEntry", () => {
  it("supplies the org prefix a CLI harness drops", () => {
    expect(
      resolveCatalogEntry({ instanceId: "claudeAgent", model: "claude-sonnet-4-5", byId })?.id,
    ).toBe("anthropic/claude-sonnet-4-5");
  });

  it("takes an already-qualified slug straight", () => {
    expect(
      resolveCatalogEntry({ instanceId: "openrouter", model: "openrouter/x-ai/grok-4.5", byId })
        ?.id,
    ).toBe("x-ai/grok-4.5");
  });

  it("returns null rather than guessing", () => {
    expect(resolveCatalogEntry({ instanceId: "cursor", model: "some-private-model", byId })).toBe(
      null,
    );
  });
});

describe("priceForHarness", () => {
  it("keeps the two currencies apart", () => {
    expect(isSubscriptionHarness("claudeAgent")).toBe(true);
    expect(isSubscriptionHarness("openrouter")).toBe(false);
    expect(
      priceForHarness({ instanceId: "claudeAgent", model: "claude-sonnet-4-5", byId }).source,
    ).toBe("subscription");
    expect(priceForHarness({ instanceId: "openrouter", model: "x-ai/grok-4.5", byId }).source).toBe(
      "openrouter",
    );
  });

  it("is unknown when no catalog row matched", () => {
    const price = priceForHarness({ instanceId: "cursor", model: "mystery", byId });
    expect(price.source).toBe("unknown");
    expect(price.usdPerMTokIn).toBeNull();
  });
});

describe("measuredTiersForCandidates", () => {
  it("prices a launch pool from the catalog and leaves the unpriced null", () => {
    const tiers = measuredTiersForCandidates(
      [
        { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
        { instanceId: "cursor", model: "mystery" },
      ],
      byId,
    );
    expect(tiers.get("claudeAgent::claude-sonnet-4-5")).toBe(2);
    expect(tiers.get("cursor::mystery")).toBeNull();
  });
});
