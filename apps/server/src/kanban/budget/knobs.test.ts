import { describe, expect, it } from "@effect/vitest";

import { clampBudgetPosition, resolveBudgetKnobs } from "./knobs.ts";

describe("resolveBudgetKnobs", () => {
  it("clamps anything the settings file could hold", () => {
    expect(clampBudgetPosition(-5)).toBe(0);
    expect(clampBudgetPosition(500)).toBe(100);
    expect(clampBudgetPosition(Number.NaN)).toBe(50);
  });

  it("maps to concrete knobs, monotonic in the direction the label promises", () => {
    const cheap = resolveBudgetKnobs(0);
    const fast = resolveBudgetKnobs(100);
    expect(cheap.maxCostTier).toBeLessThan(fast.maxCostTier);
    expect(cheap.splitEagerness).toBeLessThan(fast.splitEagerness);
    // Cheap reuses a fat thread for longer; fast abandons it sooner.
    expect(cheap.reuseContextCeilingPercent).toBeGreaterThan(fast.reuseContextCeilingPercent);
    expect(cheap.hardFreshCeilingPercent).toBeGreaterThan(fast.hardFreshCeilingPercent);
    expect(cheap.payHeavySessionFloor).toBe(false);
    expect(fast.payHeavySessionFloor).toBe(true);
    expect(fast.preferFastVariant).toBe(true);
    // Cheap batches on thinner overlap; fast only merges near-duplicates.
    expect(cheap.clusterOverlapFloor).toBeLessThan(fast.clusterOverlapFloor);
    expect(cheap.reuseOverlapFloor).toBe(fast.reuseOverlapFloor);
    expect(cheap.heavyFloorTokens).toBe(10_000);
  });
});
