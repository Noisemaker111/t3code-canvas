import { describe, expect, it } from "@effect/vitest";

import { HermesBackendError, type HermesBackend } from "./backend.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import type { HermesSnapshot } from "./prompt.ts";
import { runHermesTick } from "./tick.ts";

const policy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "review it" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

const snapshot = (cards: HermesSnapshot["cards"] = []): HermesSnapshot => ({
  cards,
  projects: [{ id: "proj-1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: null }],
  models: [
    {
      routeId: "grok/grok-4.5",
      selection: {
        instanceId: "grok" as HermesSnapshot["models"][number]["selection"]["instanceId"],
        model: "grok-4.5",
      },
      instanceId: "grok",
      model: "grok-4.5",
      costTier: 2,
      usable: true,
      capability: {
        coding: null,
        it: null,
        design: null,
        planning: null,
        effectiveContextTokens: null,
        source: null,
      },
      speed: { medianTurnMs: null, sampleCount: 0, tokensPerSecond: null, throughputSamples: 0 },
      capacity: {
        id: "grok",
        billing: "subscription",
        remainingPercent: null,
        resetsAt: null,
        balanceUsd: null,
        confidence: "unknown",
        detail: "No usage report.",
      },
      usage: {
        lowPercent: null,
        likelyPercent: null,
        highPercent: null,
        confidence: "unknown",
        basis: "No completed observations.",
      },
      meteredPrice: null,
    },
  ],
  pendingInputs: [],
  policy: { autoLaunch: true },
  reports: [],
  threads: [],
});

const scripted = (
  tier: HermesBackend["tier"],
  answers: ReadonlyArray<string>,
): HermesBackend & { prompts: string[] } => {
  const backend = {
    tier,
    prompts: [] as string[],
    available: async () => ({ tier, available: true, detail: "ok" }),
    complete: async (input: { system: string; user: string }) => {
      backend.prompts.push(input.user);
      const answer = answers[backend.prompts.length - 1];
      if (answer === undefined) throw new Error("no scripted answer left");
      return { text: answer };
    },
  };
  return backend;
};

describe("runHermesTick", () => {
  it("runs the program the provider returned and reports which one served", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts", projectId: "proj-1", body: "go" })],
    });
    const backend = scripted("cursor", ["```js\nawait board.advanceCard({ id: 'c1' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot([makeFakeCard({ id: "c1", at: "prompts" })]),
      backends: [backend],
      provider: "cursor",
    });

    expect(result.tier).toBe("cursor");
    expect(result.error).toBeNull();
    expect(state.cards[0]?.at).toBe("active");
    expect(result.summary).toContain("tier cursor");
  });

  it("measures what the tick cost, including the prompt it actually sent", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const backend: HermesBackend = {
      tier: "openrouter",
      available: async () => ({ tier: "openrouter", available: true, detail: "ok" }),
      complete: async () => ({
        text: "```js\nawait board.note({ text: 'x' });\n```",
        usage: { inputTokens: 9_000, cachedInputTokens: 8_000, outputTokens: 120, usd: 0.002 },
      }),
    };

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [backend],
      provider: "openrouter",
    });

    expect(result.cost.modelCalls).toBe(1);
    expect(result.cost.snapshotChars).toBeGreaterThan(0);
    expect(result.cost.promptChars).toBeGreaterThan(result.cost.snapshotChars);
    expect(result.cost.programChars).toBe(result.program?.length);
    expect(result.cost.usage).toMatchObject({ inputTokens: 9_000, usd: 0.002 });
    expect(result.attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("charges a retried tick for both asks", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    let call = 0;
    const backend: HermesBackend = {
      tier: "openrouter",
      available: async () => ({ tier: "openrouter", available: true, detail: "ok" }),
      complete: async () => {
        call += 1;
        return {
          text:
            call === 1
              ? "```js\nawait board.note({ text: 'x'\n```"
              : "```js\nawait board.note({ text: 'x' });\n```",
          usage: { inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 100, usd: 0.002 },
        };
      },
    };

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [backend],
      provider: "openrouter",
    });

    expect(result.error).toBeNull();
    expect(result.cost.modelCalls).toBe(2);
    expect(result.cost.usage).toMatchObject({ inputTokens: 18_000, usd: 0.004 });
  });

  it("writes its own beat and appends the program's note", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const backend = scripted("cursor", [
      "```js\nawait board.note({ text: 'c2 conflicts — needs you' });\n```",
    ]);

    const result = await runHermesTick({
      api,
      policy,
      ruleActions: 2,
      snapshot: snapshot([makeFakeCard({ id: "c1", at: "prompts" })]),
      backends: [backend],
      provider: "cursor",
    });

    expect(result.summary).toBe(
      "p1/a0/pr0 · rules 2 · tier cursor · 0 actions · c2 conflicts — needs you",
    );
  });

  it("retries once on the same tier with the parse error fed back", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const cursor = scripted("cursor", [
      "```js\nawait board.note(\n```",
      "```js\nawait board.note({ text: 'ok' });\n```",
    ]);
    const openrouter = scripted("openrouter", ["```js\nawait board.note({ text: 'ok' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [cursor, openrouter],
      provider: "cursor",
    });

    expect(result.tier).toBe("cursor");
    expect(result.error).toBeNull();
    expect(cursor.prompts).toHaveLength(2);
    expect(cursor.prompts[1]).toContain("YOUR PREVIOUS ANSWER FAILED");
    expect(openrouter.prompts).toHaveLength(0);
  });

  it("gives up for the tick after a second malformed program", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const cursor = scripted("cursor", [
      "```js\nawait board.note(\n```",
      "```js\nstill broken(\n```",
    ]);
    const openrouter = scripted("openrouter", ["```js\nawait board.note({ text: 'x' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [cursor, openrouter],
      provider: "cursor",
    });

    expect(result.error).not.toBeNull();
    expect(result.execution).toBeNull();
    expect(openrouter.prompts).toHaveLength(0);
  });

  it("fails the tick on the chosen provider instead of asking another one", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const cursor: HermesBackend = {
      tier: "cursor",
      available: async () => ({ tier: "cursor", available: false, detail: "missing binary" }),
      complete: async () => {
        throw new HermesBackendError({ tier: "cursor", kind: "unavailable", message: "n/a" });
      },
    };
    const openrouter = scripted("openrouter", ["```js\nawait board.note({ text: 'x' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [cursor, openrouter],
      provider: "cursor",
    });

    expect(result.tier).toBeNull();
    expect(result.error).toMatch(/missing binary/);
    expect(openrouter.prompts).toHaveLength(0);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["unavailable"]);
  });

  it("fails when the chosen provider has no backend on this box", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const openrouter = scripted("openrouter", ["```js\nawait board.note({ text: 'x' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [openrouter],
      provider: "xai",
    });

    expect(result.tier).toBeNull();
    expect(result.error).toMatch(/no xai backend/);
    expect(openrouter.prompts).toHaveLength(0);
  });

  it("reports a dead provider instead of throwing", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const dead: HermesBackend = {
      tier: "cursor",
      available: async () => ({ tier: "cursor", available: false, detail: "missing binary" }),
      complete: async () => ({ text: "" }),
    };

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [dead],
      provider: "cursor",
    });

    expect(result.tier).toBeNull();
    expect(result.error).toMatch(/missing binary/);
    expect(result.summary).toContain("failed");
  });

  it("dry run records intended writes without touching the board", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts", projectId: "proj-1", body: "go" })],
    });
    const backend = scripted("openrouter", ["```js\nawait board.advanceCard({ id: 'c1' });\n```"]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [backend],
      provider: "openrouter",
      recordOnly: true,
    });

    expect(result.recordOnly).toBe(true);
    expect(result.execution?.calls.at(-1)).toMatchObject({ method: "launchActive", skipped: true });
    expect(state.cards[0]?.at).toBe("prompts");
  });

  it("nudges a thread that stopped short, and finishCard opens the PR without merging it", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({ id: "c1", at: "active", threadId: "t1" }),
        makeFakeCard({ id: "c2", at: "active", threadId: "t2" }),
      ],
    });
    const backend = scripted("xai", [
      [
        "```js",
        "await board.nudgeThread({ threadId: 't1', text: 'REMAINING: wire the panel' });",
        "await board.finishCard({ id: 'c2' });",
        "```",
      ].join("\n"),
    ]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [backend],
      provider: "xai",
    });

    expect(result.error).toBeNull();
    expect(state.nudges).toEqual([{ threadId: "t1", text: "REMAINING: wire the panel" }]);
    // The PR is open; the check gate merges it on a later tick, never here.
    expect(state.cards.find((card) => card.id === "c2")?.at).toBe("pr");
    expect(result.execution?.calls.map((call) => call.method)).toEqual([
      "nudgeThread",
      "finishCard",
      "list",
      "openPr",
    ]);
  });

  // Dragging a finished card out of Active reaps its worktree, so the write
  // itself deletes the work openPr was about to commit.
  it("refuses a bare column write that would take a card out of Active", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
    });
    const backend = scripted("xai", [
      "```js\nawait board.updateCard({ id: 'c1', at: 'pr' });\n```",
    ]);

    const result = await runHermesTick({
      api,
      policy,
      snapshot: snapshot(),
      backends: [backend],
      provider: "xai",
    });

    expect(result.execution?.error).toContain("board.finishCard");
    expect(state.cards[0]?.at).toBe("active");
  });
});
