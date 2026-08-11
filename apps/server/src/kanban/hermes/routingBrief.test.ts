import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { makeFakeCard } from "./fakeBoardApi.ts";
import { buildRoutingBrief, type RoutingModelFacts } from "./routingBrief.ts";

const route = {
  routeId: "codex/gpt-5.6",
  selection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "medium" }],
  },
  usable: true,
  note: "Use when quality justifies capacity.",
  options: "reasoningEffort=medium",
  optionChoices: [{ id: "reasoningEffort", values: ["low", "medium", "high"] }],
  capability: {
    coding: 94,
    it: null,
    design: null,
    planning: null,
    effectiveContextTokens: 200_000,
    source: "measured",
  },
  speed: { medianTurnMs: 8_000, sampleCount: 10, tokensPerSecond: 96.5, throughputSamples: 10 },
  capacity: {
    id: "codex",
    billing: "subscription" as const,
    remainingPercent: 60,
    resetsAt: null,
    balanceUsd: null,
    confidence: "measured" as const,
    detail: "weekly allowance",
  },
  usage: {
    lowPercent: 1,
    likelyPercent: 2,
    highPercent: 4,
    confidence: "learned" as const,
    basis: "10 similar tasks",
  },
  meteredPrice: null,
  taskCost: {
    relative: null,
    usdPerTask: null,
    msPerTask: null,
    basis: "unknown" as const,
    taskCount: 0,
    detail: "",
  },
} satisfies RoutingModelFacts;

const project = { id: "p1", name: "vps-code", workspaceRoot: "/vps", repo: "owner/vps" };

describe("RoutingBrief authority", () => {
  it("does not turn a Hermes-resolved project into a human pin", () => {
    const brief = buildRoutingBrief({
      card: makeFakeCard({
        id: "c1",
        projectId: "p1",
        projectRouteProvenance: {
          source: "hermes",
          skill: "resolve-project",
          at: "2026-08-02T00:00:00.000Z",
        },
      }),
      projects: [project],
      models: [route],
      threads: [],
    });
    expect(brief.policy.pinnedProjectId).toBeNull();
  });

  it("enforces an explicit human project pin", () => {
    const brief = buildRoutingBrief({
      card: makeFakeCard({
        id: "c1",
        projectId: "p1",
        projectRouteProvenance: {
          source: "human",
          skill: null,
          at: "2026-08-02T00:00:00.000Z",
        },
      }),
      projects: [project],
      models: [route],
      threads: [],
    });
    expect(brief.policy.pinnedProjectId).toBe("p1");
  });

  it("preserves exact options on a human model pin", () => {
    const card = makeFakeCard({
      id: "c1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      modelRouteProvenance: {
        source: "human",
        skill: null,
        at: "2026-08-02T00:00:00.000Z",
      },
    });
    const brief = buildRoutingBrief({
      card,
      projects: [project],
      models: [route],
      threads: [],
    });
    expect(brief.routes[0]?.selection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(brief.routes[0]?.optionChoices).toEqual([]);
  });

  it("carries clear project streak evidence into the brief", () => {
    const brief = buildRoutingBrief({
      card: makeFakeCard({ id: "current", body: "continue the fix" }),
      projects: [project],
      models: [route],
      threads: [],
      cards: [
        makeFakeCard({ id: "recent-1", projectId: "p1", updatedAt: "2026-08-02T12:00:00.000Z" }),
        makeFakeCard({ id: "recent-2", projectId: "p1", updatedAt: "2026-08-02T11:00:00.000Z" }),
        makeFakeCard({ id: "active", projectId: "p1", at: "active", threadId: "t1" }),
      ],
    });
    expect(brief.projects[0]?.evidence).toEqual([
      "3 recent same-project cards",
      "1 active same-project thread",
    ]);
  });

  it("keeps competing streaks visible so resolve-project remains ambiguous", () => {
    const brief = buildRoutingBrief({
      card: makeFakeCard({ id: "current", body: "continue the fix" }),
      projects: [project, { ...project, id: "p2", name: "other" }],
      models: [route],
      threads: [],
      cards: [
        makeFakeCard({ id: "p1-a", projectId: "p1", at: "active", threadId: "t1" }),
        makeFakeCard({ id: "p1-b", projectId: "p1" }),
        makeFakeCard({ id: "p2-a", projectId: "p2", at: "active", threadId: "t2" }),
        makeFakeCard({ id: "p2-b", projectId: "p2" }),
      ],
    });
    expect(brief.projects.map((entry) => entry.evidence.length)).toEqual([2, 2]);
  });

  it("uses a successful human route as one streak signal, never by itself", () => {
    const humanRoute = makeFakeCard({
      id: "human-route",
      projectId: "p1",
      at: "done",
      projectRouteProvenance: { source: "human", skill: null, at: "2026-08-02T00:00:00.000Z" },
    });
    const alone = buildRoutingBrief({
      card: makeFakeCard({ id: "current", body: "continue the fix" }),
      projects: [project],
      models: [route],
      threads: [],
      cards: [humanRoute],
    });
    expect(alone.projects[0]?.evidence).toEqual([]);

    const brief = buildRoutingBrief({
      card: makeFakeCard({ id: "current", body: "continue the fix" }),
      projects: [project],
      models: [route],
      threads: [],
      cards: [makeFakeCard({ id: "recent", projectId: "p1" }), humanRoute],
    });
    expect(brief.projects[0]?.evidence).toEqual([
      "2 recent same-project cards",
      "a last successful human-routed card",
    ]);
  });
});
