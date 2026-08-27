import { describe, expect, it } from "@effect/vitest";

import {
  classifyAgentBinary,
  formatAgentCliDetail,
  type AgentCliObservation,
} from "./agentCliTruth.ts";

describe("classifyAgentBinary", () => {
  it("trusts known binary names", () => {
    expect(classifyAgentBinary({ binary: "claude", versionLine: null })).toBe("claude");
    expect(classifyAgentBinary({ binary: "codex", versionLine: "codex-cli 0.1" })).toBe("codex");
    expect(classifyAgentBinary({ binary: "cursor-agent", versionLine: "0.1.0" })).toBe(
      "cursor-agent",
    );
    expect(classifyAgentBinary({ binary: "grok", versionLine: "grok 1.0.0" })).toBe("grok");
  });

  it("maps agent + grok version to grok (not cursor)", () => {
    expect(
      classifyAgentBinary({ binary: "agent", versionLine: "grok 1.0.0 (3cd0d0cbce) [stable]" }),
    ).toBe("grok");
  });
});

describe("formatAgentCliDetail", () => {
  it("fails with no binaries", () => {
    expect(formatAgentCliDetail([]).status).toBe("fail");
  });

  it("labels agent→grok honestly", () => {
    const obs: AgentCliObservation[] = [
      {
        binary: "agent",
        path: "/usr/local/bin/agent",
        kind: "grok",
        versionLine: "grok 1.0.0",
        versionFailed: false,
      },
      {
        binary: "codex",
        path: "/usr/bin/codex",
        kind: "codex",
        versionLine: "codex 0.1",
        versionFailed: false,
      },
    ];
    const result = formatAgentCliDetail(obs);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("agent→grok");
    expect(result.detail).toContain("codex");
  });

  it("warns when version probes all fail", () => {
    const obs: AgentCliObservation[] = [
      {
        binary: "claude",
        path: "/bin/claude",
        kind: "claude",
        versionLine: null,
        versionFailed: true,
      },
    ];
    const result = formatAgentCliDetail(obs);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("version probes failed");
  });
});
