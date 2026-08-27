import { describe, expect, it } from "@effect/vitest";

import { mergeTurnSamples, turnSamplesFromThread } from "./collector.ts";

const activity = (turnId: string, createdAt: string, payload: Record<string, unknown>) => ({
  kind: "context-window.updated",
  createdAt,
  turnId,
  payload,
});

describe("turnSamplesFromThread", () => {
  it("keeps the last snapshot per turn and derives the gap between turns", () => {
    const samples = turnSamplesFromThread({
      threadId: "t1",
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-5",
      providerVersion: "2.1.0",
      firstUserText: "x".repeat(400),
      activities: [
        activity("turn-1", "2026-07-01T00:00:00.000Z", { usedTokens: 10, lastInputTokens: 100 }),
        activity("turn-1", "2026-07-01T00:00:05.000Z", { usedTokens: 20, lastInputTokens: 41_000 }),
        activity("turn-2", "2026-07-01T00:10:05.000Z", {
          usedTokens: 50,
          lastInputTokens: 60_000,
          lastCachedInputTokens: 55_000,
        }),
      ],
    });
    expect(samples).toHaveLength(2);
    expect(samples[0]?.inputTokens).toBe(41_000);
    expect(samples[0]?.promptTokens).toBe(100);
    expect(samples[1]?.gapMs).toBe(600_000);
    expect(samples[1]?.cachedInputTokens).toBe(55_000);
  });

  it("measures nothing when the thread has no model selection", () => {
    expect(
      turnSamplesFromThread({
        threadId: "t1",
        instanceId: null,
        model: null,
        providerVersion: null,
        firstUserText: null,
        activities: [activity("turn-1", "2026-07-01T00:00:00.000Z", { usedTokens: 10 })],
      }),
    ).toHaveLength(0);
  });
});

describe("mergeTurnSamples", () => {
  it("is idempotent per thread turn", () => {
    const input = {
      threadId: "t1",
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-5",
      providerVersion: "2.1.0",
      firstUserText: null,
      activities: [activity("turn-1", "2026-07-01T00:00:00.000Z", { usedTokens: 10 })],
    };
    const first = turnSamplesFromThread(input);
    const merged = mergeTurnSamples(first, turnSamplesFromThread(input), 100);
    expect(merged).toHaveLength(1);
  });
});
