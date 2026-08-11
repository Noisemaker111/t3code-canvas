import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  deriveMessageMetrics,
  deriveTurnMetrics,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});

describe("deriveTurnMetrics", () => {
  function makeTurnActivity(
    id: string,
    kind: string,
    turnId: string,
    createdAt: string,
    payload: unknown,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: TurnId.make(turnId),
      createdAt,
    };
  }

  it("uses the latest snapshot per turn and prefers per-turn output tokens", () => {
    const metrics = deriveTurnMetrics([
      makeTurnActivity("a1", "context-window.updated", "t1", "2026-01-01T00:00:01Z", {
        usedTokens: 1000,
        outputTokens: 300,
      }),
      makeTurnActivity("a2", "context-window.updated", "t1", "2026-01-01T00:00:05Z", {
        usedTokens: 1200,
        lastOutputTokens: 420,
        outputTokens: 500,
        durationMs: 4200,
      }),
    ]);

    expect(metrics.get("t1")).toEqual({ outputTokens: 420, durationMs: 4200 });
  });

  it("never reports context-window size as a turn's output tokens", () => {
    const metrics = deriveTurnMetrics([
      makeTurnActivity("a1", "context-window.updated", "t2", "2026-01-01T00:00:09Z", {
        usedTokens: 80_000,
      }),
    ]);

    expect(metrics.get("t2")).toEqual({ outputTokens: null, durationMs: null });
  });

  it("attributes cumulative-only output tokens as per-turn deltas", () => {
    const metrics = deriveTurnMetrics([
      makeTurnActivity("a1", "context-window.updated", "t1", "2026-01-01T00:00:01Z", {
        usedTokens: 1000,
        outputTokens: 300,
      }),
      makeTurnActivity("a2", "context-window.updated", "t2", "2026-01-01T00:00:09Z", {
        usedTokens: 2000,
        outputTokens: 750,
      }),
    ]);

    // First turn has no prior baseline; the second reports only its own share.
    expect(metrics.get("t1")).toEqual({ outputTokens: 300, durationMs: null });
    expect(metrics.get("t2")).toEqual({ outputTokens: 450, durationMs: null });
  });

  it("ignores non-context-window activities", () => {
    const metrics = deriveTurnMetrics([
      makeTurnActivity("a1", "tool.completed", "t3", "2026-01-01T00:00:03Z", { tokens: 55 }),
    ]);

    expect(metrics.has("t3")).toBe(false);
  });
});

describe("deriveMessageMetrics", () => {
  it("maps message.metrics activities by message id", () => {
    const metrics = deriveMessageMetrics([
      makeActivity("m1", "message.metrics", { messageId: "assistant:item-1", tokens: 128 }),
      makeActivity("m2", "message.metrics", { messageId: "assistant:item-2", tokens: 0 }),
      makeActivity("m3", "tool.completed", { messageId: "assistant:item-3", tokens: 9 }),
    ]);

    expect(metrics.get("assistant:item-1")).toEqual({ tokens: 128 });
    expect(metrics.has("assistant:item-2")).toBe(false);
    expect(metrics.has("assistant:item-3")).toBe(false);
  });
});
