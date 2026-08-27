import { describe, expect, it } from "@effect/vitest";

import {
  capabilityForModel,
  codingScoreOf,
  parseCapabilitySnapshot,
} from "./ModelCapabilityCatalog.ts";

const snapshot = parseCapabilitySnapshot({
  fetchedAt: "2026-08-01T00:00:00.000Z",
  models: {
    "anthropic/claude-opus-5": {
      coding: { score: 78.2, source: "terminal-bench" },
      design: { score: 1382, source: "design-arena" },
      effectiveContextTokens: 800_000,
    },
    // The one-axis shape the first snapshots used still parses as coding.
    "claude-haiku-4-5": { codingScore: 51, source: "legacy" },
    junk: "not a row",
  },
});

describe("parseCapabilitySnapshot", () => {
  it("indexes qualified ids and bare slugs, skipping what does not parse", () => {
    expect(snapshot.get("anthropic/claude-opus-5")?.scores.coding).toBe(78.2);
    expect(snapshot.get("anthropic/claude-opus-5")?.scores.design).toBe(1382);
    expect(snapshot.get("anthropic/claude-opus-5")?.sources.design).toBe("design-arena");
    expect(snapshot.get("claude-opus-5")?.effectiveContextTokens).toBe(800_000);
    expect(snapshot.get("junk")).toBeUndefined();
  });

  it("reports absent numbers as null, never a default", () => {
    expect(snapshot.get("claude-haiku-4-5")?.effectiveContextTokens).toBeNull();
    expect(snapshot.get("claude-haiku-4-5")?.scores.it).toBeNull();
    expect(snapshot.get("claude-haiku-4-5")?.scores.coding).toBe(51);
  });
});

describe("capabilityForModel", () => {
  it("matches a bare CLI slug against a qualified id", () => {
    expect(codingScoreOf(capabilityForModel(snapshot, "claude-opus-5"))).toBe(78.2);
  });

  it("is null with no snapshot or no match", () => {
    expect(capabilityForModel(null, "claude-opus-5")).toBeNull();
    expect(capabilityForModel(snapshot, "gpt-5-mini")).toBeNull();
  });
});
