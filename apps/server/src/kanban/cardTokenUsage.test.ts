import { assert, describe, it } from "@effect/vitest";

import { rollUpCardTokenUsage } from "./cardTokenUsage.ts";

describe("rollUpCardTokenUsage", () => {
  it("adds per-turn deltas across the thread", () => {
    const usage = rollUpCardTokenUsage([
      {
        turnId: "t1",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { lastInputTokens: 100, lastCachedInputTokens: 40, lastOutputTokens: 20 },
      },
      {
        turnId: "t2",
        createdAt: "2026-01-01T00:05:00.000Z",
        payload: { lastInputTokens: 300, lastCachedInputTokens: 250, lastOutputTokens: 80 },
      },
    ]);
    assert.equal(usage?.inputTokens, 400);
    assert.equal(usage?.cachedInputTokens, 290);
    assert.equal(usage?.outputTokens, 100);
    assert.equal(usage?.totalTokens, 500);
    assert.equal(usage?.turns, 2);
  });

  it("keeps only the last snapshot of a streaming turn", () => {
    const usage = rollUpCardTokenUsage([
      {
        turnId: "t1",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { lastInputTokens: 100, lastOutputTokens: 5 },
      },
      {
        turnId: "t1",
        createdAt: "2026-01-01T00:00:09.000Z",
        payload: { lastInputTokens: 100, lastOutputTokens: 60 },
      },
    ]);
    assert.equal(usage?.turns, 1);
    assert.equal(usage?.outputTokens, 60);
    assert.equal(usage?.totalTokens, 160);
  });

  it("reads a cumulative-only provider off its newest snapshot instead of summing", () => {
    const usage = rollUpCardTokenUsage([
      {
        turnId: "t1",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { usedTokens: 500, inputTokens: 400, outputTokens: 100 },
      },
      {
        turnId: "t2",
        createdAt: "2026-01-01T00:05:00.000Z",
        payload: { usedTokens: 900, inputTokens: 700, outputTokens: 200 },
      },
    ]);
    assert.equal(usage?.inputTokens, 700);
    assert.equal(usage?.outputTokens, 200);
    assert.equal(usage?.totalTokens, 900);
  });

  it("falls back to processed tokens when the snapshot splits nothing out", () => {
    const usage = rollUpCardTokenUsage([
      { turnId: null, createdAt: "2026-01-01T00:00:00.000Z", payload: { usedTokens: 1234 } },
    ]);
    assert.equal(usage?.totalTokens, 1234);
  });

  it("is null for a thread that never reported usage", () => {
    assert.equal(rollUpCardTokenUsage([]), null);
  });
});
