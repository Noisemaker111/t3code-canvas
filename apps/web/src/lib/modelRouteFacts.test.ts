import { describe, expect, it } from "vite-plus/test";

import {
  axisChips,
  formatCostPerTask,
  formatRouteCost,
  formatRouteSpeed,
  formatRouteThroughput,
  formatRouteUsage,
  formatTimePerTask,
  type ModelRouteFacts,
} from "./modelRouteFacts";

const BLANK: ModelRouteFacts = {
  instanceId: "claudeAgent",
  model: "claude-opus-5",
  scores: { coding: null, it: null, design: null, planning: null },
  benchSource: null,
  benchFetchedAt: null,
  effectiveContextTokens: null,
  medianTurnMs: null,
  speedSamples: 0,
  tokensPerSecond: null,
  throughputSamples: 0,
  costTier: 2,
  costBasis: "unmeasured",
  billing: "subscription",
  usdPerMTokIn: null,
  usdPerMTokOut: null,
  priceSource: "unknown",
  remainingPercent: null,
  usagePercent: null,
  usageConfidence: "unknown",
  usageBasis: "no comparable tasks observed",
  relativeCost: null,
  usdPerTask: null,
  msPerTask: null,
  usdPerTaskBasis: "unknown",
  usdPerTaskDetail: "no turns observed on this route",
  taskCount: 0,
};

describe("roster row facts", () => {
  it("says unknown instead of filling a gap", () => {
    expect(axisChips(BLANK)).toEqual([]);
    expect(formatRouteCost(BLANK)).toBe("cost unknown");
    expect(formatRouteSpeed(BLANK)).toBe("speed unknown");
    expect(formatRouteThroughput(BLANK)).toBe("tok/s unknown");
    expect(formatTimePerTask(BLANK)).toBe("time/task unknown");
    expect(formatRouteUsage(BLANK)).toBe("usage unknown");
    expect(formatCostPerTask(BLANK)).toBe("cost/task unknown");
    expect(axisChips(undefined)).toEqual([]);
  });

  it("renders a metered route in dollars and a subscription in tiers", () => {
    expect(
      formatRouteCost({
        ...BLANK,
        billing: "metered",
        usdPerMTokIn: 0.75,
        usdPerMTokOut: 4.5,
        costBasis: "measured",
      }),
    ).toBe("$0.75→4.5/Mtok");
    expect(formatRouteCost({ ...BLANK, costTier: 3, costBasis: "measured" })).toBe("$$$ tier");
  });

  it("names each axis and lists only the ones a feed scored", () => {
    expect(
      axisChips({ ...BLANK, scores: { coding: 89.1, it: null, design: 1382, planning: null } }),
    ).toEqual([
      { axis: "coding", text: "code 89.1" },
      { axis: "design", text: "design 1382" },
    ]);
  });

  it("compares routes as a ratio, because the plan is what actually gets spent", () => {
    expect(formatCostPerTask({ ...BLANK, relativeCost: 1, usdPerTask: 0.4, taskCount: 5 })).toBe(
      "1× cost/task",
    );
    // The point of the ratio: a cheaper-per-token model needing more turns
    // lands above a dearer one that finishes in fewer.
    expect(formatCostPerTask({ ...BLANK, relativeCost: 2.3, usdPerTask: 0.92, taskCount: 4 })).toBe(
      "2.3× cost/task",
    );
  });

  it("prices a whole task, and marks a subscription's number as notional", () => {
    expect(
      formatCostPerTask({
        ...BLANK,
        usdPerTask: 0.0412,
        usdPerTaskBasis: "metered",
        taskCount: 6,
      }),
    ).toBe("$0.04/task");
    // Sub-cent tasks are the common case on a cheap route; two decimals would
    // round every one of them to $0.00.
    expect(formatCostPerTask({ ...BLANK, usdPerTask: 0.0031, usdPerTaskBasis: "metered" })).toBe(
      "$0.0031/task",
    );
    expect(
      formatCostPerTask({
        ...BLANK,
        usdPerTask: 1.37,
        usdPerTaskBasis: "list-price",
        taskCount: 4,
      }),
    ).toBe("~$1.37/task");
  });

  it("separates how fast a route emits from whether the job landed sooner", () => {
    // The whole point: 200 tok/s reads faster than 40, and still loses on the
    // only two numbers that decide anything — time and cost to finish.
    const quick = { ...BLANK, tokensPerSecond: 203.4, throughputSamples: 12 };
    const slow = { ...BLANK, tokensPerSecond: 41.2, throughputSamples: 12 };
    expect(formatRouteThroughput(quick)).toBe("203 tok/s");
    expect(formatRouteThroughput(slow)).toBe("41 tok/s");
    expect(formatTimePerTask({ ...quick, msPerTask: 172_800_000, taskCount: 4 })).toBe("48h/task");
    expect(formatTimePerTask({ ...slow, msPerTask: 7_200_000, taskCount: 4 })).toBe("2h/task");
    expect(formatTimePerTask({ ...BLANK, msPerTask: 45_000 })).toBe("45s/task");
    expect(formatTimePerTask({ ...BLANK, msPerTask: 18 * 60_000 })).toBe("18m/task");
  });

  it("reads speed and usage from what was observed", () => {
    expect(formatRouteSpeed({ ...BLANK, medianTurnMs: 41_000, speedSamples: 9 })).toBe("41s/turn");
    expect(formatRouteUsage({ ...BLANK, usagePercent: 4.2, usageConfidence: "learned" })).toBe(
      "4%/task",
    );
  });
});
