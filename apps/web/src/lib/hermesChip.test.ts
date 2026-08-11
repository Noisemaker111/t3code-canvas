import { describe, expect, it } from "vite-plus/test";
import type { HermesBoardStatus } from "@t3tools/contracts";

import { describeCapturePickup, describeHermesChip } from "./hermesChip";

const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

const status = (patch: Partial<HermesBoardStatus> = {}): HermesBoardStatus => ({
  enabled: true,
  running: true,
  busy: false,
  intervalMs: 60_000,
  model: "x-ai/grok-4.5",
  lastHeartbeatAt: "2025-12-31T23:59:30.000Z",
  lastModelAt: "2025-12-31T23:59:30.000Z",
  lastSkipReason: null,
  lastSkipIsBoxBlock: false,
  lastBeatAt: "2025-12-31T23:59:30.000Z",
  lastSummary: "p1/a0/pr0 · 1 action",
  lastTier: "cursor",
  nextTickAt: "2026-01-01T00:00:30.000Z",
  lastError: null,
  providerError: null,
  consecutiveFailures: 0,
  pipelineIdle: false,
  cardActivity: [],
  cardWatch: [],
  nextModelCheckAt: null,
  ...patch,
});

describe("describeHermesChip", () => {
  it("counts down to the next tick instead of guessing from the last beat", () => {
    expect(describeHermesChip(status(), nowMs)).toMatchObject({
      label: "Hermes live",
      detail: "next 30s",
      tone: "good",
    });
  });

  it("does not call a long tick a restart", () => {
    // The old chip read a beat older than the interval as "starting".
    const slow = status({ busy: true, lastBeatAt: "2025-12-31T23:55:00.000Z", nextTickAt: null });
    expect(describeHermesChip(slow, nowMs)).toMatchObject({
      label: "Hermes working",
      tone: "working",
    });
  });

  it("names the failure rather than showing amber", () => {
    const failing = status({ consecutiveFailures: 3, lastError: "no Hermes tier answered" });
    expect(describeHermesChip(failing, nowMs)).toMatchObject({
      label: "Hermes failing ×3",
      detail: "no Hermes tier answered",
      tone: "bad",
    });
  });

  // An idle board never runs the tick that would fail, so the selection is
  // what the chip has to read.
  it("says when the picked model has no transport, before any tick fails", () => {
    const stranded = status({
      providerError: "claude (claude) is not a transport Hermes can run — pick a cursor instance",
    });
    expect(describeHermesChip(stranded, nowMs)).toMatchObject({
      label: "Hermes has no provider",
      tone: "bad",
    });
  });

  it("calls out a brain that will touch nothing", () => {
    expect(describeHermesChip(status({ pipelineIdle: true }), nowMs)).toMatchObject({
      label: "Hermes idle",
      tone: "warn",
    });
  });

  it("flags an overdue tick", () => {
    expect(
      describeHermesChip(status({ nextTickAt: "2025-12-31T23:58:00.000Z" }), nowMs),
    ).toMatchObject({ label: "Hermes late", tone: "warn" });
  });

  it("says when the cheap heartbeat deliberately skipped the model", () => {
    expect(
      describeHermesChip(
        status({ lastSkipReason: "No actionable cards or pending questions." }),
        nowMs,
      ),
    ).toMatchObject({
      label: "Hermes watching",
      detail: "next 30s",
      tone: "good",
    });
  });

  it("warns when a PR card still needs reconciliation instead of green watching", () => {
    expect(
      describeHermesChip(
        status({
          lastSkipReason: "A pull request card needs reconciliation.",
        }),
        nowMs,
      ),
    ).toMatchObject({
      label: "Hermes stuck on PR",
      tone: "warn",
    });
  });

  it("flags a failing box check instead of reading as calm watching", () => {
    expect(
      describeHermesChip(
        status({
          lastSkipReason:
            "box check forge.auth is failing: gh auth status exited 1 — PRs cannot be opened",
          lastSkipIsBoxBlock: true,
        }),
        nowMs,
      ),
    ).toMatchObject({
      label: "Hermes blocked",
      tone: "bad",
    });
  });

  it("reports a switched-on brain with nothing scheduled", () => {
    expect(describeHermesChip(status({ running: false, nextTickAt: null }), nowMs)).toMatchObject({
      label: "Hermes not ticking",
      tone: "warn",
    });
  });
});

describe("describeCapturePickup", () => {
  it("tells the sender when Hermes is off", () => {
    expect(describeCapturePickup(null)).toContain("Hermes is off");
    expect(describeCapturePickup(status({ enabled: false }))).toContain("Hermes is off");
  });

  it("warns when the brain is on but will not move the card", () => {
    expect(describeCapturePickup(status({ pipelineIdle: true }))).toContain(
      "leave this card alone",
    );
  });

  it("promises the end of the running tick while one is in flight", () => {
    expect(describeCapturePickup(status({ busy: true }))).toContain("moment that one finishes");
  });

  it("promises now, because sending wakes the loop", () => {
    expect(describeCapturePickup(status({ nextTickAt: null }))).toBe("Hermes picks this up now.");
  });
});
