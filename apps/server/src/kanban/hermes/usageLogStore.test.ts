import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HermesTickTranscript } from "@t3tools/contracts";

import { BOARD_WRITE_METHODS } from "./boardApi.ts";
import {
  addSpend,
  appendHermesUsage,
  bindHermesUsageLog,
  emptyHermesSpend,
  readHermesSpend,
  readHermesUsageLog,
  toUsageRow,
  unbindHermesUsageLog,
  writeHermesSpend,
} from "./usageLogStore.ts";

const tick = (overrides: Partial<HermesTickTranscript> = {}): HermesTickTranscript => ({
  id: "tick-1",
  ranAt: "2026-01-01T00:00:00.000Z",
  durationMs: 4_200,
  tier: "openrouter",
  model: "x-ai/grok-4.5",
  attempts: [],
  program: "await board.list();",
  calls: [],
  logs: [],
  summary: "summary",
  error: null,
  recordOnly: false,
  cost: {
    promptChars: 40_000,
    snapshotChars: 32_000,
    programChars: 600,
    modelCalls: 1,
    modelMs: 3_800,
    executionMs: 400,
    usage: { inputTokens: 10_000, cachedInputTokens: 9_000, outputTokens: 200, usd: 0.004 },
  },
  ...overrides,
});

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-usage-"));
  try {
    bindHermesUsageLog(baseDir);
    return use(baseDir);
  } finally {
    unbindHermesUsageLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

describe("hermes usage log", () => {
  it("flattens a tick into numbers you can average over", () => {
    const row = toUsageRow(
      tick({
        calls: [
          { method: "updateCard", args: {}, result: {} },
          { method: "list", args: {}, result: [] },
        ],
        ruleActions: 2,
      }),
      BOARD_WRITE_METHODS,
    );

    expect(row).toMatchObject({
      tier: "openrouter",
      modelCalls: 1,
      promptChars: 40_000,
      snapshotChars: 32_000,
      modelMs: 3_800,
      executionMs: 400,
      calls: 2,
      writes: 1,
      ruleActions: 2,
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
      outputTokens: 200,
      usd: 0.004,
      failed: false,
    });
  });

  it("keeps every tick, unlike the 30-tick transcript log", () => {
    withTempBase(() => {
      for (let index = 0; index < 120; index += 1) {
        appendHermesUsage(toUsageRow(tick({ id: `tick-${index}` }), BOARD_WRITE_METHODS));
      }

      const rows = readHermesUsageLog(500);

      expect(rows).toHaveLength(120);
      expect(rows[0]?.id).toBe("tick-0");
    });
  });

  it("reports null tokens for a tier that reports none, never a guess", () => {
    const row = toUsageRow(
      tick({
        tier: "cursor",
        cost: {
          promptChars: 40_000,
          snapshotChars: 32_000,
          programChars: 600,
          modelCalls: 1,
          modelMs: 12_000,
          executionMs: 400,
        },
      }),
      BOARD_WRITE_METHODS,
    );

    expect(row.inputTokens).toBeNull();
    expect(row.usd).toBeNull();
    expect(row.modelMs).toBe(12_000);
  });
});

describe("hermes spend", () => {
  it("counts an unmeasured tier's calls, so the total is not read as complete", () => {
    const measured = addSpend(emptyHermesSpend(), tick());
    const both = addSpend(
      measured,
      tick({
        tier: "cursor",
        cost: {
          promptChars: 1,
          snapshotChars: 1,
          programChars: 1,
          modelCalls: 1,
          modelMs: 9_000,
          executionMs: 0,
        },
      }),
    );

    expect(both).toEqual({
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
      outputTokens: 200,
      usd: 0.004,
      measuredCalls: 1,
      unmeasuredCalls: 1,
      modelMs: 12_800,
    });
  });

  it("ignores a tick that never called a model", () => {
    const spend = addSpend(
      emptyHermesSpend(),
      tick({
        tier: null,
        modelSkipped: true,
        cost: {
          promptChars: 0,
          snapshotChars: 0,
          programChars: 0,
          modelCalls: 0,
          modelMs: 0,
          executionMs: 30,
        },
      }),
    );

    expect(spend).toEqual(emptyHermesSpend());
  });

  it("survives a restart, because the point of a spend number is the trend", () => {
    withTempBase(() => {
      writeHermesSpend({
        since: "2026-01-01T00:00:00.000Z",
        spend: addSpend(emptyHermesSpend(), tick()),
        counters: { ticks: 7 },
        servedByTier: { openrouter: 7 },
        ruleFires: { "mergeable-pr": { count: 3, lastAt: "2026-01-01T00:00:00.000Z" } },
      });

      const restored = readHermesSpend();

      expect(restored?.since).toBe("2026-01-01T00:00:00.000Z");
      expect(restored?.spend.usd).toBe(0.004);
      expect(restored?.counters["ticks"]).toBe(7);
      expect(restored?.servedByTier["openrouter"]).toBe(7);
    });
  });
});
