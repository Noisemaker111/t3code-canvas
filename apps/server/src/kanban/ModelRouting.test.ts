import { describe, expect, it } from "@effect/vitest";
import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildRosterIndex,
  candidatesFromShellProviders,
  formatAvailableModelsBlock,
  measuredCostKey,
  providerFamilyUsable,
  tierFor,
} from "./ModelRouting.ts";

const CANDIDATE = {
  instanceId: "codex",
  model: "gpt-5.6",
  name: "GPT-5.6",
  enabled: true,
  installed: true,
  authOk: true,
};

describe("deterministic routing facts", () => {
  it("does not infer an unmeasured tier from a model name", () => {
    expect(
      tierFor({ instanceId: "x", model: "super-fast-mini", name: "Cheap Turbo" }, new Map()),
    ).toEqual({ tier: 2, basis: "unmeasured" });
  });

  it("keeps roster membership exact", () => {
    const roster = buildRosterIndex([
      {
        instanceId: "codex" as ProviderInstanceId,
        model: "gpt-5.6",
        note: "risky architecture",
        options: [],
      },
    ]);
    expect(roster.has(measuredCostKey("codex", "gpt-5.6"))).toBe(true);
    expect(roster.has(measuredCostKey("codex", "gpt-5-mini"))).toBe(false);
  });

  it("strips a rule's speed and cost claims before any consumer reads it", () => {
    const seat = buildRosterIndex([
      {
        instanceId: "codex" as ProviderInstanceId,
        model: "gpt-5.6",
        note: "Very fast, $$$, amazing at design, use for changelogs",
        options: [],
      },
    ]).get(measuredCostKey("codex", "gpt-5.6"));
    // The owner's read on the model survives; the two facts the box measures
    // on every turn do not.
    expect(seat?.note).toBe("amazing at design, use for changelogs");

    // And so they never reach the block Hermes reads.
    const block = formatAvailableModelsBlock(
      [CANDIDATE],
      null,
      undefined,
      {
        entries: [
          {
            instanceId: "codex" as ProviderInstanceId,
            model: "gpt-5.6",
            note: "Very fast, $$$, best planner, use for changelogs",
            options: [],
          },
        ],
        enforced: true,
      },
      undefined,
    );
    expect(block).toContain('use="best planner, use for changelogs"');
    expect(block).not.toContain("Very fast");
    expect(block).not.toContain("$$$");
  });

  it("hard-blocks exhausted provider capacity", () => {
    const result = providerFamilyUsable(
      {
        fetchedAt: "2026-08-02T00:00:00.000Z",
        errors: [],
        providers: {
          codex: {
            displayName: "Codex",
            fetchedAt: "2026-08-02T00:00:00.000Z",
            resources: {
              weekly: { kind: "consumption", unit: "percent", utilization: 1 },
            },
          },
        },
      },
      "codex",
    );
    expect(result.ok).toBe(false);
  });

  it("carries benchmark and speed evidence into the model block", () => {
    const block = formatAvailableModelsBlock(
      [CANDIDATE],
      null,
      undefined,
      undefined,
      new Map([
        [
          measuredCostKey("codex", "gpt-5.6"),
          {
            scores: { coding: 63.4, it: 22, design: null, planning: null },
            benchSource: "coding=terminal-bench it=itbench",
            medianTurnMs: 41_000,
            sampleCount: 9,
            tokensPerSecond: 112.4,
            throughputSamples: 8,
          },
        ],
      ]),
    );
    expect(block).toContain("bench=coding:63.4,it:22(coding=terminal-bench it=itbench)");
    expect(block).toContain("speed=41s(n=9)");
    expect(block).toContain("tps=112(n=8)");
    // Throughput never ships without the warning that it is not time to done.
    expect(block).toContain("tps is emission speed only");
  });

  it("says unknown rather than guessing capability from a model name", () => {
    const block = formatAvailableModelsBlock([CANDIDATE]);
    expect(block).toContain("bench=unknown");
    expect(block).toContain("speed=unknown");
    expect(block).toContain("tps=unknown");
    expect(block).toContain("cost=$2(unmeasured)");
  });

  it("normalizes provider registry rows without choosing among them", () => {
    expect(
      candidatesFromShellProviders([
        {
          instanceId: "codex" as ProviderInstanceId,
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6" }, { slug: "gpt-5-mini" }],
        },
      ]).map((candidate) => candidate.model),
    ).toEqual(["gpt-5.6", "gpt-5-mini"]);
  });
});
