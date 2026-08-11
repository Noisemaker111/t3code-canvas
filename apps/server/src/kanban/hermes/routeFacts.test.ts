import { describe, expect, it } from "@effect/vitest";

import { capacityPoolForRoute, routeSpeed, taskUsageEstimate } from "./routeFacts.ts";

describe("semantic route facts", () => {
  it("expresses subscription scarcity as remaining percentage, never cash", () => {
    const pool = capacityPoolForRoute("codex-primary", {
      fetchedAt: "2026-08-02T00:00:00.000Z",
      errors: [],
      providers: {
        codex: {
          displayName: "Codex",
          fetchedAt: "2026-08-02T00:00:00.000Z",
          resources: {
            session: {
              kind: "consumption",
              unit: "percent",
              utilization: 0.74,
              resetsAt: "2026-08-03T00:00:00.000Z",
            },
            weekly: { kind: "consumption", unit: "percent", utilization: 0.4 },
          },
        },
      },
    });
    expect(pool.billing).toBe("subscription");
    expect(pool.remainingPercent).toBe(26);
    expect(pool.balanceUsd).toBeNull();
    expect(pool.detail).toContain("session");
  });

  it("expresses a configured metered balance as percent plus cash", () => {
    const pool = capacityPoolForRoute("openrouter", {
      fetchedAt: "2026-08-02T00:00:00.000Z",
      errors: [],
      providers: {
        openrouter: {
          displayName: "OpenRouter",
          fetchedAt: "2026-08-02T00:00:00.000Z",
          resources: {
            balance: {
              kind: "balance",
              unit: "usd",
              available: 4,
              limit: 5,
            },
          },
        },
      },
    });
    expect(pool.billing).toBe("metered");
    expect(pool.remainingPercent).toBe(80);
    expect(pool.balanceUsd).toBe(4);
  });

  it("does not invent capability-adjacent speed from a model name", () => {
    expect(routeSpeed([], "claude", "claude-super-fast-turbo").medianTurnMs).toBeNull();
    expect(
      routeSpeed(
        [
          {
            harness: "claude",
            model: "opus",
            threadId: "t1",
            at: "2026-08-02T00:00:00.000Z",
            turnIndex: 0,
            gapMs: null,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            usedTokens: 2,
            maxTokens: 100,
            toolUses: 0,
            durationMs: 900,
            promptTokens: 1,
            providerVersion: "1",
          },
        ],
        "claude",
        "opus",
      ).medianTurnMs,
    ).toBe(900);
  });

  it("measures tokens per second, and refuses to read it as time to done", () => {
    const turn = (id: string, outputTokens: number | null, durationMs: number) => ({
      harness: "claude",
      model: "opus",
      threadId: id,
      at: "2026-08-02T00:00:00.000Z",
      turnIndex: 0,
      gapMs: null,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens,
      usedTokens: 10,
      maxTokens: 100,
      toolUses: 0,
      durationMs,
      promptTokens: 1,
      providerVersion: "1",
    });
    const speed = routeSpeed(
      [turn("t1", 400, 4000), turn("t2", 200, 1000), turn("t3", 300, 2000)],
      "claude",
      "opus",
    );
    expect(speed.tokensPerSecond).toBe(150);
    expect(speed.throughputSamples).toBe(3);
    // A turn that emitted nothing is latency, not throughput.
    const withEmpty = routeSpeed([turn("t1", 200, 1000), turn("t2", 0, 9000)], "claude", "opus");
    expect(withEmpty.tokensPerSecond).toBe(200);
    expect(withEmpty.throughputSamples).toBe(1);
    expect(withEmpty.sampleCount).toBe(2);
    // No emitted tokens anywhere: unknown, never a stand-in.
    expect(routeSpeed([turn("t1", null, 1000)], "claude", "opus").tokensPerSecond).toBeNull();
  });

  it("shows unknown until real percentage observations exist", () => {
    expect(taskUsageEstimate("codex/sol", []).confidence).toBe("unknown");
    expect(
      taskUsageEstimate("codex/sol", [
        { routeId: "codex/sol", observedPercent: 1 },
        { routeId: "codex/sol", observedPercent: 2 },
        { routeId: "codex/sol", observedPercent: 5 },
      ]),
    ).toMatchObject({
      lowPercent: 1,
      likelyPercent: 2,
      highPercent: 5,
      confidence: "estimated",
    });
  });
});
