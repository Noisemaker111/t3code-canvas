import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_BROWSER_DEFAULT_PROFILE,
  AGENT_BROWSER_MAX_CAPTURE_WIDTH,
  AGENT_BROWSER_MIN_CAPTURE_WIDTH,
  agentBrowserCaptureWidth,
  normalizeAgentBrowserProfile,
} from "./agentBrowser.ts";

describe("agentBrowserCaptureWidth", () => {
  it("rounds a viewer's width up to a bucket, so a drag is not a restart", () => {
    expect(agentBrowserCaptureWidth(700)).toBe(960);
    expect(agentBrowserCaptureWidth(900)).toBe(960);
    expect(agentBrowserCaptureWidth(961)).toBe(1280);
  });

  it("never asks for less than the floor or more than the ceiling", () => {
    expect(agentBrowserCaptureWidth(120)).toBe(AGENT_BROWSER_MIN_CAPTURE_WIDTH);
    expect(agentBrowserCaptureWidth(0)).toBe(AGENT_BROWSER_MIN_CAPTURE_WIDTH);
    expect(agentBrowserCaptureWidth(Number.NaN)).toBe(AGENT_BROWSER_MIN_CAPTURE_WIDTH);
    expect(agentBrowserCaptureWidth(6_000)).toBe(AGENT_BROWSER_MAX_CAPTURE_WIDTH);
  });
});

describe("normalizeAgentBrowserProfile", () => {
  it("falls back to the default jar for anything empty", () => {
    expect(normalizeAgentBrowserProfile(undefined)).toBe(AGENT_BROWSER_DEFAULT_PROFILE);
    expect(normalizeAgentBrowserProfile("  ")).toBe(AGENT_BROWSER_DEFAULT_PROFILE);
    expect(normalizeAgentBrowserProfile("///")).toBe(AGENT_BROWSER_DEFAULT_PROFILE);
  });

  it("keeps a name a directory can hold, and one jar per spelling", () => {
    expect(normalizeAgentBrowserProfile("  Staging ")).toBe("staging");
    expect(normalizeAgentBrowserProfile("work/../etc")).toBe("work----etc");
    expect(normalizeAgentBrowserProfile("a".repeat(64))).toHaveLength(32);
  });
});
