import { describe, expect, it } from "@effect/vitest";

import { quotaWindowsForModel, shadowPrice } from "./shadowPrice.ts";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
// @effect-diagnostics-next-line globalDate:off
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe("quotaWindowsForModel", () => {
  const provider = {
    resources: {
      session: { kind: "consumption" as const, unit: "percent", utilization: 0.4 },
      weekly: { kind: "consumption" as const, unit: "percent", utilization: 0.2 },
      weeklyOpus: { kind: "consumption" as const, unit: "percent", utilization: 0.9 },
      listToday: { kind: "consumption" as const, unit: "USD", used: 3.2 },
      balance: { kind: "balance" as const, unit: "USD", available: 10 },
    },
  };

  it("binds the top-tier bucket only to top-tier models", () => {
    const opus = quotaWindowsForModel(provider, "claude-opus-5");
    const haiku = quotaWindowsForModel(provider, "claude-haiku-4-5");
    expect(opus.map((w) => w.id)).toContain("weeklyOpus");
    expect(haiku.map((w) => w.id)).not.toContain("weeklyOpus");
  });

  it("keeps meters and balances out", () => {
    const ids = quotaWindowsForModel(provider, "claude-opus-5").map((w) => w.id);
    expect(ids).not.toContain("listToday");
    expect(ids).not.toContain("balance");
  });
});

describe("shadowPrice", () => {
  it("is null when nothing is measured", () => {
    expect(shadowPrice({ windows: [], nowMs: NOW })).toBeNull();
  });

  it("prices an imminent reset with headroom at ~0 — use it or lose it", () => {
    const priced = shadowPrice({
      windows: [{ id: "weekly", utilization: 0.4, resetsAt: inHours(1) }],
      nowMs: NOW,
    });
    expect(priced?.price).toBeLessThan(0.01);
    expect(priced?.detail).toContain("resets 1h");
  });

  it("stands on utilization when there is no reset clock", () => {
    const priced = shadowPrice({
      windows: [{ id: "weekly", utilization: 0.6, resetsAt: null }],
      nowMs: NOW,
    });
    expect(priced?.price).toBeCloseTo(0.6, 5);
  });

  it("stays cheap while the measured burn cannot reach the cap before reset", () => {
    const priced = shadowPrice({
      windows: [{ id: "weekly", utilization: 0.5, resetsAt: inHours(10) }],
      nowMs: NOW,
      // 1%/h × 10h = 10% projected spend against 50% headroom → a fifth of it.
      burnRatePerHour: () => 0.01,
    });
    expect(priced?.price).toBeCloseTo(0.5 * (0.1 / 0.5), 5);
  });

  it("prices a cap on track to bind at the full utilization", () => {
    const priced = shadowPrice({
      windows: [{ id: "session", utilization: 0.8, resetsAt: inHours(4) }],
      nowMs: NOW,
      // 10%/h × 4h = 40% projected against 20% headroom → clamps to 1.
      burnRatePerHour: () => 0.1,
    });
    expect(priced?.price).toBeCloseTo(0.8, 5);
  });

  it("lets the binding window win", () => {
    const priced = shadowPrice({
      windows: [
        { id: "session", utilization: 0.1, resetsAt: inHours(1) },
        { id: "weeklyOpus", utilization: 0.95, resetsAt: null },
      ],
      nowMs: NOW,
    });
    expect(priced?.price).toBeCloseTo(0.95, 5);
    expect(priced?.detail).toContain("weeklyOpus");
  });
});
