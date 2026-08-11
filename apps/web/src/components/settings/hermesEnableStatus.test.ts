import type { HermesBrainStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { enableStatusLine, preflightStatusLine } from "./HermesSettingsPanel";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function status(partial: Partial<HermesBrainStatus>): HermesBrainStatus {
  return {
    enabled: true,
    running: true,
    busy: false,
    model: "x-ai/grok-4.5",
    intervalMs: 60_000,
    maxNudges: 3,
    nextTickAt: "2026-01-01T00:00:30.000Z",
    lastHeartbeatAt: null,
    lastModelAt: null,
    lastSkipReason: null,
    tiers: [],
    lastTick: null,
    log: [],
    logPath: null,
    stats: {
      since: "2026-01-01T00:00:00.000Z",
      heartbeats: 0,
      skipped: 0,
      ticks: 0,
      failed: 0,
      writes: 0,
      nudges: 0,
      modelSkipped: 0,
      ruleWrites: 0,
      servedByTier: [],
      spend: undefined,
      usageLogPath: null,
    },
    conversation: {
      turns: 0,
      estTokens: 0,
      memoryChars: 0,
      lastCompactionAt: null,
      startedAt: null,
    },
    ...partial,
  } as HermesBrainStatus;
}

describe("enableStatusLine", () => {
  it("does not claim idle before the first status lands", () => {
    expect(enableStatusLine(null, null, NOW)).toBe("Checking the loop…");
  });

  it("answers the click while the request is in flight", () => {
    expect(enableStatusLine(status({ enabled: false, running: false }), true, NOW)).toBe(
      "Starting the loop…",
    );
  });

  it("separates off from on-but-stalled", () => {
    expect(enableStatusLine(status({ enabled: false, running: false }), null, NOW)).toContain(
      "Off",
    );
    expect(
      enableStatusLine(status({ enabled: true, running: false, nextTickAt: null }), null, NOW),
    ).toContain("no tick is scheduled");
  });

  it("counts down to the next tick when the loop is running", () => {
    expect(enableStatusLine(status({}), null, NOW)).toBe("Watching · next in 30s");
  });
});

describe("preflightStatusLine", () => {
  it("does not claim a verdict before the first check pass", () => {
    expect(preflightStatusLine(null, NOW)).toContain("Not checked yet");
  });

  it("names the check that is holding the loop back", () => {
    const line = preflightStatusLine(
      {
        ok: false,
        at: "2026-01-01T00:00:00.000Z",
        checkId: "forge.auth",
        detail: "gh auth status exited 1",
      },
      NOW,
    );
    expect(line).toContain("forge.auth");
    expect(line).toContain("gh auth status exited 1");
  });

  it("reads as clean when the box passed", () => {
    expect(
      preflightStatusLine(
        { ok: true, at: "2026-01-01T00:00:00.000Z", checkId: null, detail: null },
        NOW,
      ),
    ).toContain("fit to work");
  });
});
