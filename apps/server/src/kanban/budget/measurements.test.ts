import { describe, expect, it } from "@effect/vitest";

import {
  buildBudgetTable,
  cacheAgeBucket,
  cacheObservationsFrom,
  costTierFromPrice,
  degradationFrom,
  estimateResumeCost,
  sessionFloorFrom,
  staminaCeilingFrom,
  taskCostFrom,
  type TurnSample,
} from "./measurements.ts";

const sample = (overrides: Partial<TurnSample>): TurnSample => ({
  harness: "claudeAgent",
  model: "claude-sonnet-4-5",
  threadId: "t1",
  at: "2026-07-01T00:00:00.000Z",
  turnIndex: 0,
  gapMs: null,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  usedTokens: null,
  maxTokens: null,
  toolUses: null,
  durationMs: null,
  promptTokens: null,
  providerVersion: "2.1.0",
  ...overrides,
});

describe("sessionFloorFrom", () => {
  it("says unknown when nothing was ever measured", () => {
    const floor = sessionFloorFrom([]);
    expect(floor.status).toBe("unknown");
    expect(floor.floorTokens).toBeNull();
    expect(floor.detail).toContain("never measured");
  });

  it("subtracts the prompt that rode along with the first turn", () => {
    const floor = sessionFloorFrom([
      sample({ turnIndex: 0, inputTokens: 41_000, promptTokens: 1_000 }),
    ]);
    expect(floor.status).toBe("measured");
    expect(floor.floorTokens).toBe(40_000);
  });

  it("only counts first turns from the newest provider build", () => {
    const floor = sessionFloorFrom([
      sample({ at: "2026-06-01T00:00:00.000Z", inputTokens: 90_000, providerVersion: "2.0.0" }),
      sample({ at: "2026-07-01T00:00:00.000Z", inputTokens: 30_000, providerVersion: "2.1.0" }),
    ]);
    expect(floor.floorTokens).toBe(30_000);
    expect(floor.providerVersion).toBe("2.1.0");
    expect(floor.sampleCount).toBe(1);
  });

  it("ignores resume turns", () => {
    const floor = sessionFloorFrom([sample({ turnIndex: 3, inputTokens: 200_000 })]);
    expect(floor.status).toBe("unknown");
  });

  it("splits out cache reads so a warm start is not priced as a cold one", () => {
    const floor = sessionFloorFrom([
      sample({ inputTokens: 41_000, cachedInputTokens: 36_000, promptTokens: 1_000 }),
      sample({
        threadId: "t2",
        inputTokens: 41_000,
        cachedInputTokens: 38_000,
        promptTokens: 1_000,
      }),
    ]);
    expect(floor.floorTokens).toBe(40_000);
    expect(floor.floorCachedTokens).toBe(37_000);
    expect(floor.detail).toContain("cached");
  });

  it("reports cached as null when the harness never said", () => {
    const floor = sessionFloorFrom([sample({ inputTokens: 41_000, promptTokens: 1_000 })]);
    expect(floor.floorCachedTokens).toBeNull();
  });
});

describe("cache observations", () => {
  it("buckets by how old the thread's last turn was", () => {
    expect(cacheAgeBucket(60_000)).toBe("under5m");
    expect(cacheAgeBucket(20 * 60_000)).toBe("under1h");
    expect(cacheAgeBucket(3 * 60 * 60_000)).toBe("over1h");
  });

  it("reports the observed cached fraction per bucket and null where blind", () => {
    const rows = cacheObservationsFrom([
      sample({ turnIndex: 1, gapMs: 30_000, inputTokens: 100, cachedInputTokens: 90 }),
      sample({ turnIndex: 2, gapMs: 45_000, inputTokens: 100, cachedInputTokens: 80 }),
    ]);
    expect(rows.find((row) => row.bucket === "under5m")?.cachedFraction).toBeCloseTo(0.85, 5);
    expect(rows.find((row) => row.bucket === "over1h")?.cachedFraction).toBeNull();
  });
});

describe("estimateResumeCost", () => {
  it("charges the whole transcript and says so when cache behaviour is unmeasured", () => {
    const estimate = estimateResumeCost({
      samples: [],
      thread: { usedTokens: 100_000, idleForMs: 60_000 },
      promptTokens: 500,
    });
    expect(estimate.chargedInputTokens).toBe(100_500);
    expect(estimate.cachedInputTokens).toBeNull();
    expect(estimate.basis[0]).toContain("unmeasured");
  });

  it("discounts by the observed fraction for the matching age", () => {
    const estimate = estimateResumeCost({
      samples: [sample({ turnIndex: 1, gapMs: 30_000, inputTokens: 100, cachedInputTokens: 90 })],
      thread: { usedTokens: 100_000, idleForMs: 60_000 },
      promptTokens: 0,
    });
    expect(estimate.cachedInputTokens).toBe(90_000);
    expect(estimate.chargedInputTokens).toBe(10_000);
    expect(estimate.basis[0]).toContain("90% cached");
  });

  it("is unknown when the thread never reported a context size", () => {
    const estimate = estimateResumeCost({
      samples: [],
      thread: { usedTokens: null, idleForMs: 1_000 },
      promptTokens: 10,
    });
    expect(estimate.chargedInputTokens).toBeNull();
    expect(estimate.basis[0]).toContain("unknown");
  });
});

describe("taskCostFrom", () => {
  const price = { usdPerMTokIn: 3, usdPerMTokOut: 15, source: "openrouter" as const };
  const route = { harness: "claudeAgent", model: "claude-sonnet-4-5" };

  it("bills a task as the whole thread, charging only uncached input", () => {
    const cost = taskCostFrom({
      samples: [
        sample({ threadId: "a", inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 }),
        sample({
          threadId: "a",
          inputTokens: 30_000,
          cachedInputTokens: 25_000,
          outputTokens: 500,
        }),
      ],
      ...route,
      price,
      subscription: false,
    });
    // charged input 10k + 5k = 15k; output 1.5k → 15k*3 + 1.5k*15 per Mtok
    expect(cost.chargedInputTokens).toBe(15_000);
    expect(cost.outputTokens).toBe(1_500);
    expect(cost.usdPerTask).toBeCloseTo(0.0675, 6);
    expect(cost.basis).toBe("metered");
    expect(cost.taskCount).toBe(1);
  });

  it("times the whole task, so throughput cannot pass for finishing sooner", () => {
    const cost = taskCostFrom({
      samples: [
        sample({ threadId: "a", inputTokens: 1_000, outputTokens: 400, durationMs: 60_000 }),
        sample({ threadId: "a", inputTokens: 1_000, outputTokens: 200, durationMs: 30_000 }),
      ],
      ...route,
      price,
      subscription: false,
    });
    // 600 tokens in 90s is a brisk route; the task still took 90s, and that is
    // the number a routing decision reads.
    expect(cost.msPerTask).toBe(90_000);
  });

  it("leaves task time unknown when no turn carried a duration", () => {
    const cost = taskCostFrom({
      samples: [sample({ threadId: "a", inputTokens: 1_000, outputTokens: 10 })],
      ...route,
      price,
      subscription: false,
    });
    expect(cost.msPerTask).toBeNull();
  });

  it("takes the median thread, not the loudest one", () => {
    const thread = (id: string, input: number) =>
      sample({ threadId: id, inputTokens: input, cachedInputTokens: 0, outputTokens: 0 });
    const cost = taskCostFrom({
      samples: [thread("a", 1_000), thread("b", 2_000), thread("c", 900_000)],
      ...route,
      price,
      subscription: false,
    });
    expect(cost.chargedInputTokens).toBe(2_000);
    expect(cost.taskCount).toBe(3);
  });

  it("marks a subscription's number as the catalog rate, not money spent", () => {
    const cost = taskCostFrom({
      samples: [sample({ threadId: "a", inputTokens: 1_000, outputTokens: 100 })],
      ...route,
      price,
      subscription: true,
    });
    expect(cost.basis).toBe("list-price");
    expect(cost.detail).toContain("a subscription spends quota");
  });

  it("is unknown with no observed turns, and with no catalog price", () => {
    expect(
      taskCostFrom({ samples: [], ...route, price, subscription: false }).usdPerTask,
    ).toBeNull();
    const unpriced = taskCostFrom({
      samples: [sample({ threadId: "a", inputTokens: 1_000, outputTokens: 10 })],
      ...route,
      price: { usdPerMTokIn: null, usdPerMTokOut: null, source: "unknown" as const },
      subscription: false,
    });
    expect(unpriced.usdPerTask).toBeNull();
    expect(unpriced.basis).toBe("unknown");
    expect(unpriced.detail).toContain("1 observed task");
  });
});

describe("costTierFromPrice", () => {
  it("is null when nothing priced the model", () => {
    expect(costTierFromPrice({ usdPerMTokIn: null, usdPerMTokOut: null, source: "unknown" })).toBe(
      null,
    );
  });

  it("ranks by blended price, not by name", () => {
    expect(costTierFromPrice({ usdPerMTokIn: 0.1, usdPerMTokOut: 0.4, source: "openrouter" })).toBe(
      1,
    );
    expect(costTierFromPrice({ usdPerMTokIn: 3, usdPerMTokOut: 15, source: "openrouter" })).toBe(2);
    expect(costTierFromPrice({ usdPerMTokIn: 15, usdPerMTokOut: 75, source: "openrouter" })).toBe(
      3,
    );
    expect(costTierFromPrice({ usdPerMTokIn: 30, usdPerMTokOut: 150, source: "openrouter" })).toBe(
      4,
    );
  });
});

describe("degradationFrom", () => {
  it("bands observed turns by how full the window was", () => {
    const bands = degradationFrom([
      sample({ usedTokens: 10, maxTokens: 100, toolUses: 2, durationMs: 1_000 }),
      sample({ usedTokens: 80, maxTokens: 100, toolUses: 12, durationMs: 9_000 }),
    ]);
    expect(bands.find((band) => band.band === "0–25%")?.meanToolUses).toBe(2);
    expect(bands.find((band) => band.band === "75–100%")?.meanTurnMs).toBe(9_000);
    expect(bands.find((band) => band.band === "25–50%")?.sampleCount).toBe(0);
  });
});

describe("staminaCeilingFrom", () => {
  const band = (label: string, sampleCount: number, meanTurnMs: number | null) => ({
    band: label,
    sampleCount,
    meanToolUses: null,
    meanTurnMs,
    meanOutputTokens: null,
  });

  it("is null until two bands are measured", () => {
    expect(staminaCeilingFrom([band("0–25%", 5, 4_000)])).toBeNull();
    expect(staminaCeilingFrom([band("0–25%", 5, 4_000), band("25–50%", 1, 30_000)])).toBeNull();
  });

  it("stops the ceiling where turn time doubles against the fresh baseline", () => {
    const ceiling = staminaCeilingFrom([
      band("0–25%", 5, 4_000),
      band("25–50%", 4, 6_000),
      band("50–75%", 4, 9_500),
      band("75–100%", 3, 5_000),
    ]);
    expect(ceiling).toBe(50);
  });

  it("extends to the top when nothing degrades", () => {
    const ceiling = staminaCeilingFrom([
      band("0–25%", 5, 4_000),
      band("25–50%", 4, 5_000),
      band("75–100%", 3, 6_000),
    ]);
    expect(ceiling).toBe(100);
  });
});

describe("buildBudgetTable", () => {
  it("names every unknown instead of defaulting it", () => {
    const table = buildBudgetTable({
      samples: [],
      harnesses: [
        {
          instanceId: "claudeAgent",
          model: "claude-sonnet-4-5",
          price: { usdPerMTokIn: null, usdPerMTokOut: null, source: "unknown" },
        },
      ],
      updatedAt: null,
    });
    expect(table.harnesses[0]?.floor.status).toBe("unknown");
    expect(table.harnesses[0]?.costTier).toBeNull();
    expect(table.unknowns).toContain("session floor unknown for claudeAgent/claude-sonnet-4-5");
    expect(table.unknowns).toContain("price unknown for claudeAgent/claude-sonnet-4-5");
  });
});
