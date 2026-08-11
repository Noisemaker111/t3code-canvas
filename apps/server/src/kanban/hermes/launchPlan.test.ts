import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { ProviderInstanceId } from "@t3tools/contracts";

import { applyValidatedLaunchPlan, validateLaunchPlan } from "./launchPlan.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";

const selection = {
  instanceId: ProviderInstanceId.make("codex-primary"),
  model: "gpt-5.6",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const usage = {
  lowPercent: 1,
  likelyPercent: 2,
  highPercent: 4,
  confidence: "learned" as const,
  basis: "12 observed tasks",
};

const brief = {
  cardId: "card-1",
  prompt: "Repair tenant session isolation and add regression tests.",
  attachments: [],
  projects: [{ id: "project-1", slug: "vps-code", name: "vps-code", repo: "x/y", evidence: [] }],
  routes: [
    {
      routeId: "codex-primary/gpt-5.6",
      selection,
      available: true,
      ownerRule: "Use for risky architecture work.",
      optionsSummary: "reasoningEffort=high",
      optionChoices: [],
      capability: {
        coding: 94,
        it: null,
        design: null,
        planning: null,
        effectiveContextTokens: 200000,
        source: "benchmark",
      },
      speed: { medianTurnMs: 9000, sampleCount: 12, tokensPerSecond: 88, throughputSamples: 12 },
      capacity: {
        id: "codex",
        billing: "subscription" as const,
        remainingPercent: 62,
        resetsAt: "2026-08-03T00:00:00.000Z",
        balanceUsd: null,
        confidence: "measured" as const,
        detail: "weekly",
      },
      usage,
      meteredPrice: null,
      taskCost: {
        relative: null,
        usdPerTask: null,
        msPerTask: null,
        basis: "unknown" as const,
        taskCount: 0,
        detail: "",
      },
    },
  ],
  threads: [],
  policy: {
    pinnedProjectId: null,
    pinnedRouteId: null,
    naturalLanguageRules: [],
    allowedRouteIds: ["codex-primary/gpt-5.6"],
    rosterEnforced: true,
    preferSubscriptions: true,
    preserveScarceUsage: true,
    maxTaskUsagePercent: 10,
  },
};

const plan = {
  version: 1 as const,
  status: "ready" as const,
  sourceCardId: "card-1",
  blockedReason: null,
  tasks: [
    {
      sourceCardId: "card-1",
      title: "Repair tenant isolation",
      brief: "Mission\nRepair tenant isolation.\n\nDone when\nRegression tests pass.",
      projectId: "project-1",
      placement: { kind: "new" as const, threadId: null },
      execution: { routeId: "codex-primary/gpt-5.6", selection, usage },
      expectedWork: {
        investigation: "high" as const,
        implementation: "medium" as const,
        verification: "high" as const,
        risk: "critical" as const,
        contextPressure: "medium" as const,
        expectedTurns: [3, 7] as [number, number],
      },
      reason: "Cross-tenant security requires the strongest available debugging route.",
      alternativesConsidered: ["sonnet: lower observed debugging quality"],
      provenance: {
        source: "hermes" as const,
        skill: "select-execution",
        at: "model-authored",
      },
    },
  ],
};

describe("LaunchPlan validation", () => {
  it("canonicalizes runtime-owned route facts and provenance", () => {
    const validated = validateLaunchPlan(
      plan,
      brief,
      DateTime.makeUnsafe("2026-08-02T12:00:00.000Z"),
    );
    expect(validated.tasks[0]?.execution.usage).toEqual(usage);
    expect(validated.tasks[0]?.provenance).toEqual({
      source: "hermes",
      skill: "select-execution",
      at: "2026-08-02T12:00:00.000Z",
    });
  });

  it("fails closed when a route becomes unavailable", () => {
    expect(() =>
      validateLaunchPlan(plan, {
        ...brief,
        routes: brief.routes.map((route) => ({ ...route, available: false })),
      }),
    ).toThrow(/unavailable/);
  });

  it("fails closed when percentage use is unknown under a hard cap", () => {
    expect(() =>
      validateLaunchPlan(plan, {
        ...brief,
        routes: brief.routes.map((route) => ({
          ...route,
          usage: {
            lowPercent: null,
            likelyPercent: null,
            highPercent: null,
            confidence: "unknown" as const,
            basis: "no samples",
          },
        })),
      }),
    ).toThrow(/unknown usage/);
  });

  it("rejects changed provider options", () => {
    expect(() =>
      validateLaunchPlan(
        {
          ...plan,
          tasks: plan.tasks.map((task) => ({
            ...task,
            execution: {
              ...task.execution,
              selection: { ...selection, options: [] },
            },
          })),
        },
        brief,
      ),
    ).toThrow(/validated model\/options/);
  });
  it("accepts one owner-approved semantic option value", () => {
    const selectableBrief = {
      ...brief,
      routes: brief.routes.map((route) => ({
        ...route,
        selection: { ...route.selection, options: [] },
        optionChoices: [{ id: "reasoningEffort", values: ["low", "medium", "high"] }],
      })),
    };
    expect(() => validateLaunchPlan(plan, selectableBrief)).not.toThrow();
  });

  it("restores cards and archives started threads when a split launch fails", async () => {
    const source = makeFakeCard({ id: "card-1", title: "Original", body: "Original body" });
    const { api, state } = makeFakeBoardApi({
      cards: [source],
      launchFailures: { "card-2": "provider unavailable" },
    });
    const splitPlan = validateLaunchPlan(
      { ...plan, tasks: [plan.tasks[0]!, { ...plan.tasks[0]!, title: "Second task" }] },
      brief,
    );

    await expect(applyValidatedLaunchPlan(api, splitPlan)).rejects.toThrow(/provider unavailable/);

    const restored = state.cards.find((card) => card.id === "card-1");
    const split = state.cards.find((card) => card.id === "card-2");
    expect(restored?.at).toBe("prompts");
    expect(restored?.threadId).toBeNull();
    expect(restored?.title).toBe("Original");
    expect(split?.archivedAt).not.toBeNull();
    expect(state.archivedThreads).toContain("thread-card-1");
  });
});
