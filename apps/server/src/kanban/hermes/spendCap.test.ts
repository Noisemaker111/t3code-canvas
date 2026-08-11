import { describe, expect, it } from "@effect/vitest";

import { evaluateSpendCap, spendInWindowUsd } from "./spendCap.ts";

const row = (ranAt: string, usd: number | null) => ({ ranAt, usd });
const NOW = Date.parse("2026-01-02T12:00:00.000Z");

describe("spendInWindowUsd", () => {
  it("counts only the rows inside the window", () => {
    const rows = [
      row("2026-01-02T11:00:00.000Z", 1.5),
      row("2026-01-02T06:00:00.000Z", 2),
      row("2025-12-30T00:00:00.000Z", 100),
    ];
    expect(spendInWindowUsd(rows, NOW)).toBe(3.5);
  });

  it("ignores unpriced and malformed rows instead of counting them as zero cost", () => {
    const rows = [row("2026-01-02T11:00:00.000Z", null), row("not-a-date", 5)];
    expect(spendInWindowUsd(rows, NOW)).toBe(0);
  });
});

describe("evaluateSpendCap", () => {
  it("is off at zero, which is the default", () => {
    const state = evaluateSpendCap({
      capUsd: 0,
      nowMs: NOW,
      rows: [row("2026-01-02T11:00:00.000Z", 99)],
    });
    expect(state.blocked).toBe(false);
  });

  it("treats a negative or malformed cap as off rather than as a permanent stop", () => {
    expect(evaluateSpendCap({ capUsd: -5, nowMs: NOW, rows: [] }).blocked).toBe(false);
    expect(evaluateSpendCap({ capUsd: Number.NaN, nowMs: NOW, rows: [] }).blocked).toBe(false);
  });

  it("lets a tick through under the cap", () => {
    const state = evaluateSpendCap({
      capUsd: 10,
      nowMs: NOW,
      rows: [row("2026-01-02T11:00:00.000Z", 4)],
    });
    expect(state.blocked).toBe(false);
    expect(state.spentUsd).toBe(4);
  });

  it("blocks at the cap and says what was spent against what", () => {
    const state = evaluateSpendCap({
      capUsd: 10,
      nowMs: NOW,
      rows: [row("2026-01-02T11:00:00.000Z", 6), row("2026-01-02T09:00:00.000Z", 4.25)],
    });
    expect(state.blocked).toBe(true);
    expect(state.reason).toContain("$10.25 of $10.00");
    expect(state.reason).toContain("rules still run");
  });

  it("unblocks as the window rolls off, with no reset needed", () => {
    const rows = [row("2026-01-01T11:00:00.000Z", 20)];
    expect(evaluateSpendCap({ capUsd: 10, nowMs: NOW, rows }).blocked).toBe(false);
    expect(
      evaluateSpendCap({ capUsd: 10, nowMs: Date.parse("2026-01-01T12:00:00.000Z"), rows }).blocked,
    ).toBe(true);
  });
});
