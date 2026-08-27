import { describe, expect, it } from "@effect/vitest";

import {
  probeAgentSliceRuntime,
  renderAgentSliceShim,
  resolveMaxRuntimeSec,
  wrapAgentSpawn,
  type AgentSliceProbeInput,
} from "./agentSlice.ts";

const FOUR_HOURS = 4 * 60 * 60;
const runtime = { slice: "t3j-agents.slice", maxRuntimeSec: FOUR_HOURS };

const linuxRootService = (overrides: Partial<AgentSliceProbeInput> = {}): AgentSliceProbeInput => ({
  uid: 0,
  env: { INVOCATION_ID: "abc123" },
  ...overrides,
});

describe("probeAgentSliceRuntime", () => {
  it("activates on linux as root under systemd", () => {
    expect(probeAgentSliceRuntime(linuxRootService())).toEqual({
      slice: "t3j-agents.slice",
      maxRuntimeSec: FOUR_HOURS,
    });
  });

  it("honors a configured slice name", () => {
    expect(
      probeAgentSliceRuntime(
        linuxRootService({ env: { INVOCATION_ID: "abc123", T3J_AGENT_SLICE: "other.slice" } }),
      ),
    ).toEqual({ slice: "other.slice", maxRuntimeSec: FOUR_HOURS });
  });

  it("treats an empty T3J_AGENT_SLICE as a typed opt-out", () => {
    expect(
      probeAgentSliceRuntime(
        linuxRootService({ env: { INVOCATION_ID: "abc123", T3J_AGENT_SLICE: "" } }),
      ),
    ).toBeNull();
  });

  it("stays off without root or outside a systemd service", () => {
    expect(probeAgentSliceRuntime(linuxRootService({ uid: 1000 }))).toBeNull();
    expect(probeAgentSliceRuntime(linuxRootService({ uid: null }))).toBeNull();
    expect(probeAgentSliceRuntime(linuxRootService({ env: {} }))).toBeNull();
  });
});

describe("resolveMaxRuntimeSec", () => {
  // An agent process with no deadline is what let a `tsgo` run for 29 hours at
  // 64% of a core with nothing on the box owning it.
  it("caps an agent scope at four hours by default", () => {
    expect(resolveMaxRuntimeSec(undefined)).toBe(FOUR_HOURS);
  });

  it("treats an empty value as a typed opt-out and honors an explicit cap", () => {
    expect(resolveMaxRuntimeSec("")).toBeNull();
    expect(resolveMaxRuntimeSec("  ")).toBeNull();
    expect(resolveMaxRuntimeSec("3600")).toBe(3600);
  });

  // A typo must not silently remove the cap — that is the failure it exists for.
  it("falls back to the default for anything unusable", () => {
    expect(resolveMaxRuntimeSec("soon")).toBe(FOUR_HOURS);
    expect(resolveMaxRuntimeSec("-5")).toBe(FOUR_HOURS);
  });
});

describe("wrapAgentSpawn", () => {
  it("prefixes the command with a scoped systemd-run", () => {
    const wrapped = wrapAgentSpawn(
      runtime,
      { command: "/usr/bin/opencode", args: ["serve", "--port=1"] },
      "t3j-agent-opencode-1-1",
    );
    expect(wrapped.command).toBe("systemd-run");
    expect(wrapped.args).toEqual([
      "--quiet",
      "--scope",
      "--collect",
      "--slice=t3j-agents.slice",
      `--property=RuntimeMaxSec=${FOUR_HOURS}`,
      "--unit=t3j-agent-opencode-1-1",
      "--",
      "/usr/bin/opencode",
      "serve",
      "--port=1",
    ]);
  });

  it("leaves the scope uncapped when the cap is opted out", () => {
    const wrapped = wrapAgentSpawn(
      { slice: "t3j-agents.slice", maxRuntimeSec: null },
      { command: "/usr/bin/opencode", args: [] },
      "t3j-agent-opencode-1-2",
    );
    expect(wrapped.args.some((arg) => arg.startsWith("--property=RuntimeMaxSec"))).toBe(false);
  });
});

describe("renderAgentSliceShim", () => {
  it("exec-chains through systemd-run with the payload quoted", () => {
    const shim = renderAgentSliceShim(runtime, "claude", "/root/.local/bin/claude");
    expect(shim.startsWith("#!/bin/sh\nexec systemd-run")).toBe(true);
    expect(shim).toContain("'--slice=t3j-agents.slice'");
    expect(shim).toContain(`'--property=RuntimeMaxSec=${FOUR_HOURS}'`);
    expect(shim).toContain('"--unit=t3j-agent-claude-$$"');
    expect(shim).toContain(`-- '/root/.local/bin/claude' "$@"`);
  });

  it("survives a quote in the executable path", () => {
    const shim = renderAgentSliceShim(runtime, "chromium", "/opt/o'dd/chrome");
    expect(shim).toContain(`'/opt/o'\\''dd/chrome'`);
  });
});

/**
 * A slice only contains what enters it, so containment is a property of every
 * spawn site rather than of this module. On 3 Aug 2026 `runOpenCodeCommand`
 * was the one provider-CLI spawner that never called `inAgentSlice`; its
 * `models --verbose` probe ran in the board's own cgroup and throttled the
 * server into answering nothing. This is the tripwire for that.
 */
describe("agent CLI spawners enter the slice", () => {
  /**
   * Provider/agent CLI spawners that still bypass the slice. Their probes are
   * short `--version` reads rather than inventory loads, so they have not hurt
   * the box yet — but the list must only ever shrink. Do not add to it.
   */
  const KNOWN_UNSLICED = new Set([
    "provider/Layers/ClaudeProvider.ts",
    "provider/Layers/CodexProvider.ts",
    "provider/Layers/CursorProvider.ts",
    "provider/Layers/GrokProvider.ts",
    "provider/providerMaintenanceRunner.ts",
  ]);

  /** Board infrastructure: git, updates, host shell. Must NOT be slice-capped. */
  const AGENT_SPAWNER_DIRS = ["provider", "textGeneration", "btw", "terminal"];

  /**
   * Counted per spawn site, not per file: `opencodeRuntime.ts` already wrapped
   * its `serve` spawn, so a file-level "imports inAgentSlice" check passed
   * while `runOpenCodeCommand` beside it escaped. Every `ChildProcess.make`
   * needs its own wrap, so the counts must not diverge.
   */
  it("wraps every child-process spawn in a provider/agent CLI module", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const NodePath = await import("node:path");
    const serverSrc = NodePath.join(import.meta.dirname, "..");
    const countOf = (source: string, needle: string) => source.split(needle).length - 1;

    const offenders: string[] = [];
    for (const dir of AGENT_SPAWNER_DIRS) {
      const entries = await readdir(NodePath.join(serverSrc, dir), {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }
        const absolute = NodePath.join(entry.parentPath, entry.name);
        const relative = NodePath.relative(serverSrc, absolute).split(NodePath.sep).join("/");
        if (KNOWN_UNSLICED.has(relative)) continue;
        const source = await readFile(absolute, "utf8");
        const spawns = countOf(source, "ChildProcess.make(");
        if (spawns === 0) continue;
        const wraps = countOf(source, "inAgentSlice(");
        if (wraps < spawns) offenders.push(`${relative} (${spawns} spawns, ${wraps} sliced)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
