import { describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_BOARD_SETTINGS, ProviderDriverKind, type BoardSettings } from "@t3tools/contracts";

import { type HermesBackend } from "./backend.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import {
  collectCardActivity,
  collectSnapshot,
  hermesBoardStatus,
  hermesBrainStatus,
  hermesTickById,
  lastHermesTick,
  repeatedBoardFailures,
  requestHermesWake,
  resetHermesBrainState,
  setHermesTickWallClockMsForTest,
  trackBoardFailures,
  runHermesHeartbeat,
  runOneTick,
  runRecoveryPass,
  startHermesBrainLoop,
} from "./HermesBrain.ts";
import { judgmentQueue, modelJudgmentQueue } from "./judgment.ts";
import { runRulePass } from "./rulePass.ts";

const settings = (patch: Partial<BoardSettings> = {}): BoardSettings => ({
  ...DEFAULT_BOARD_SETTINGS,
  hermesBrainInstanceId: "cursor",
  ...patch,
});

/** What a fake transport claims, so the board's instance resolves to it. */
const claim = (tier: HermesBackend["tier"]) =>
  tier === "openrouter"
    ? { modelPrefix: "openrouter/" }
    : { driver: ProviderDriverKind.make(tier === "xai" ? "grok" : tier) };

/** A Draft only a model can read: raw text, untouched. */
const rawDraft = (id = "raw") =>
  makeFakeCard({ id, at: "prompts", body: "make the toast stop flashing" });

/** Self-heal files its own Draft when ticks fail, so read the watch by card. */
const watchOf = (cardId: string) =>
  hermesBoardStatus().cardWatch.find((entry) => entry.cardId === cardId);

/** A finished thread, so [review] fires: the model judges transcripts, not reports. */
const stoppedTranscript = (threadId: string, text = "I changed the parser and stopped.") => ({
  threadId,
  title: `thread ${threadId}`,
  exists: true,
  archived: false,
  turnState: "finished",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  idleForMs: 120_000,
  messageCount: 2,
  entries: [{ at: "2026-01-01T00:00:00.000Z", role: "assistant" as const, text }],
});

const answering = (tier: HermesBackend["tier"], program: string): HermesBackend => ({
  tier,
  ...claim(tier),
  available: async () => ({ tier, available: true, detail: "ok" }),
  complete: async () => ({ text: `\`\`\`js\n${program}\n\`\`\`` }),
});

const launchProgram = (id: string): string => `
await board.applyLaunchPlan({
  plan: {
    version: 1,
    status: "ready",
    sourceCardId: "${id}",
    blockedReason: null,
    tasks: [{
      sourceCardId: "${id}",
      title: "card ${id}",
      brief: "Complete the requested work and verify it.",
      projectId: "proj-1",
      placement: { kind: "new", threadId: null },
      execution: {
        routeId: "grok/grok-4.5",
        selection: { instanceId: "grok", model: "grok-4.5" },
        usage: {
          lowPercent: null,
          likelyPercent: null,
          highPercent: null,
          confidence: "unknown",
          basis: "No completed observations."
        }
      },
      expectedWork: {
        investigation: "medium",
        implementation: "medium",
        verification: "medium",
        risk: "medium",
        contextPressure: "medium",
        expectedTurns: [2, 5]
      },
      reason: "The available route fits the requested work.",
      alternativesConsidered: [],
      provenance: {
        source: "hermes",
        skill: "select-execution",
        at: "2026-08-02T00:00:00.000Z"
      }
    }]
  }
});
`;

const refusing = (tier: HermesBackend["tier"]): HermesBackend & { asked: number } => {
  const backend = {
    tier,
    ...claim(tier),
    asked: 0,
    available: async () => ({ tier, available: true, detail: "ok" }),
    complete: async () => {
      backend.asked += 1;
      throw new Error("a tier must not be asked when nothing needs a decision");
    },
  };
  return backend;
};

const recordingModel = (tier: HermesBackend["tier"]) => {
  const seen: string[] = [];
  const backend: HermesBackend = {
    tier,
    ...claim(tier),
    available: async () => ({ tier, available: true, detail: "ok" }),
    complete: async (input) => {
      seen.push(input.model ?? "");
      return { text: "```js\nawait board.note({ text: 'ok' });\n```" };
    },
  };
  return { backend, seen };
};

const missing = (tier: HermesBackend["tier"]): HermesBackend => ({
  tier,
  ...claim(tier),
  available: async () => ({ tier, available: false, detail: "missing binary" }),
  complete: async () => ({ text: "" }),
});

describe("collectSnapshot", () => {
  it("parses each Active thread's report into the snapshot", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
      reports: {
        t1: {
          threadId: "t1",
          text: "DONE:\n- wrote the parser\nREMAINING:\n- wire the panel",
          finishedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const snapshot = await collectSnapshot(api, settings());

    expect(snapshot.reports).toEqual([
      {
        cardId: "c1",
        threadId: "t1",
        done: ["wrote the parser"],
        remaining: ["wire the panel"],
        blocked: null,
        nudges: 0,
      },
    ]);
    expect(snapshot.policy.maxNudgesPerCard).toBe(3);
    expect(snapshot.policy).toMatchObject({
      structureDrafts: true,
      autoLaunch: true,
    });
  });

  it("normalizes the server setting names into the generated BoardPolicy", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi();

    const snapshot = await collectSnapshot(
      api,
      settings({
        hermesAutoApplySkillsToAutoMovedPrompts: false,
        hermesAutoMovePromptsToActive: false,
      }),
    );

    expect(snapshot.policy).toMatchObject({
      structureDrafts: false,
      autoLaunch: false,
    });
  });
});

describe("runHermesHeartbeat", () => {
  it("checks an idle board without calling a model", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });
    let calls = 0;
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        calls += 1;
        return { text: "```js\nawait board.list();\n```" };
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    const result = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    const status = await hermesBrainStatus(deps);

    expect(result).toMatchObject({ ranModel: false, transcript: null });
    expect(result.reason).toContain("No actionable");
    expect(calls).toBe(0);
    expect(status.stats).toMatchObject({ heartbeats: 1, skipped: 1, ticks: 0 });
    expect(status.lastSkipReason).toContain("No actionable");
  });

  it("asks no model while a critical box check is failing, and says which one", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    let calls = 0;
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        calls += 1;
        return { text: "```js\nawait board.list();\n```" };
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
      preflight: {
        check: async () => ({
          checkId: "forge.auth",
          detail: "gh auth status exited 1 — PRs cannot be opened",
        }),
      },
    };

    const result = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    const status = await hermesBrainStatus(deps);

    expect(result).toMatchObject({ ranModel: false, transcript: null });
    expect(result.reason).toContain("forge.auth");
    expect(calls).toBe(0);
    expect(status.preflight).toMatchObject({ ok: false, checkId: "forge.auth" });
  });

  it("runs the model once the box comes back clean", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    const deps = {
      api,
      backends: [answering("cursor", "await board.list();")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
      preflight: { check: async () => null },
    };

    const result = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    const status = await hermesBrainStatus(deps);

    expect(result.ranModel).toBe(true);
    expect(status.preflight).toMatchObject({ ok: true, checkId: null });
  });

  it("calls the model once for changed work and skips the unchanged snapshot", async () => {
    resetHermesBrainState();
    // Pending permission (not a structure Prompt): prep claim would change the
    // fingerprint every tick if we used a raw Draft.
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      pendingInputs: [
        { threadId: "t1", requestId: "r1", question: "run tests?", options: ["yes", "no"] },
      ],
    });
    let calls = 0;
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        calls += 1;
        return { text: "```js\nawait board.list();\n```" };
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    const first = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    const second = await runHermesHeartbeat(deps, new Date("2026-01-01T00:01:00.000Z"));

    expect(first.ranModel).toBe(true);
    expect(second.ranModel).toBe(false);
    expect(second.reason).toContain("No actionable change");
    expect(calls).toBe(1);
  });

  it("rechecks unchanged actionable work after fifteen minutes", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      pendingInputs: [
        { threadId: "t1", requestId: "r1", question: "run tests?", options: ["yes", "no"] },
      ],
    });
    let calls = 0;
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        calls += 1;
        return { text: "```js\nawait board.list();\n```" };
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    await runHermesHeartbeat(deps, new Date("2026-01-01T00:14:00.000Z"));
    await runHermesHeartbeat(deps, new Date("2026-01-01T00:15:00.000Z"));

    expect(calls).toBe(2);
  });

  it("publishes a stopped Active card as watched, and counts the looks that moved nothing", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      transcripts: { t1: stoppedTranscript("t1") },
    });
    const deps = {
      api,
      backends: [answering("cursor", "await board.list();")],
      // The completion rules would act on this card and clear the count; this
      // is about what the watch does when nothing acts.
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesAutoFinishActive: false }),
    };

    await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    expect(watchOf("a1")).toMatchObject({ kind: "review", reviews: 1, stalled: false });

    // The board never changed, so the model is only asked again at the recheck
    // deadline — the one the card badge counts down to.
    expect(hermesBoardStatus().nextModelCheckAt).toBe("2026-01-01T00:15:00.000Z");
    await runHermesHeartbeat(deps, new Date("2026-01-01T00:15:00.000Z"));
    await runHermesHeartbeat(deps, new Date("2026-01-01T00:30:00.000Z"));

    expect(watchOf("a1")).toMatchObject({ reviews: 3, stalled: true });
  });

  it("drops the watch when the card leaves the queue", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      transcripts: { t1: stoppedTranscript("t1") },
    });
    const deps = {
      api,
      backends: [answering("cursor", "await board.list();")],
      // The completion rules would act on this card and clear the count; this
      // is about what the watch does when nothing acts.
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesAutoFinishActive: false }),
    };

    await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    expect(watchOf("a1")).toBeDefined();

    const card = state.cards[0];
    if (card) state.cards[0] = { ...card, at: "done" };
    await runHermesHeartbeat(deps, new Date("2026-01-01T00:16:00.000Z"));

    expect(watchOf("a1")).toBeUndefined();
  });

  it("runs recovery while every semantic pipeline policy is off", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "orphan", at: "active" })],
    });
    let calls = 0;
    const deps = {
      api,
      backends: [
        {
          ...answering("cursor", "await board.list();"),
          complete: async () => {
            calls += 1;
            return { text: "```js\nawait board.list();\n```" };
          },
        },
      ],
      boardSettings: async () =>
        settings({
          hermesBrainEnabled: true,
          hermesAutoApplySkillsToAutoMovedPrompts: false,
          hermesAutoMovePromptsToActive: false,
        }),
    };

    const result = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));

    expect(result.ranModel).toBe(false);
    expect(state.cards[0]?.at).toBe("prompts");
    expect(calls).toBe(0);
  });

  it("rejects a second run while a semantic tick is in flight", async () => {
    resetHermesBrainState();
    // Needs a decision, so the tier is actually asked and the tick is in flight.
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        entered();
        await gate;
        return { text: "```js\nawait board.list();\n```" };
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    const first = runOneTick(deps);
    await started;
    await expect(runHermesHeartbeat(deps)).rejects.toThrow("already running");
    release();
    await first;
  });

  it("wall clock ends the live CLI so an orphaned tick cannot keep app-servers", async () => {
    resetHermesBrainState();
    setHermesTickWallClockMsForTest(40);
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ended = 0;
    const backend: HermesBackend = {
      ...answering("cursor", "await board.list();"),
      complete: async () => {
        await gate;
        return { text: "```js\nawait board.list();\n```" };
      },
      endSession: async () => {
        ended += 1;
      },
    };
    const deps = {
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    const first = runOneTick(deps);
    await expect(first).rejects.toThrow(/wall clock/);
    expect(ended).toBe(1);
    expect(hermesBoardStatus().lastError).toMatch(/wall clock/);
    expect(hermesBoardStatus().busy).toBe(false);

    // Restore the real wall clock before the follow-up tick, or a 40ms cap
    // will abort that one too.
    setHermesTickWallClockMsForTest(null);
    release();

    // Lock is free: a second tick can start without waiting on the orphan.
    // No board.* calls — this only proves the lock released after wall clock.
    let secondAsked = false;
    const second = await runOneTick({
      api,
      backends: [
        {
          ...answering("cursor", "undefined"),
          complete: async () => {
            secondAsked = true;
            return { text: "```js\nundefined;\n```" };
          },
        },
      ],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });
    expect(secondAsked).toBe(true);
    expect(second.id).toMatch(/^tick-/);
    expect(hermesBoardStatus().busy).toBe(false);
  });

  it("fails visibly instead of treating a board read error as an empty board", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });
    const broken = { ...api, list: async () => Promise.reject(new Error("database unavailable")) };
    const deps = {
      api: broken,
      backends: [answering("cursor", "await board.list();")],
      // The completion rules would act on this card and clear the count; this
      // is about what the watch does when nothing acts.
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesAutoFinishActive: false }),
    };

    await expect(runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"))).rejects.toThrow(
      "database unavailable",
    );
    const status = await hermesBrainStatus(deps);

    expect(status.stats).toMatchObject({ heartbeats: 1, failed: 1, ticks: 0 });
    expect(status.lastHeartbeatAt).toBe("2026-01-01T00:00:00.000Z");
    expect(hermesBoardStatus().lastError).toBe("database unavailable");
  });
});

describe("runRulePass", () => {
  it("unsticks a stale prompt prep and requeues an Active card with no thread", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({ id: "stuck", at: "prompts", prepStatus: "processing" }),
        makeFakeCard({ id: "fresh", at: "prompts", prepStatus: "processing" }),
        makeFakeCard({ id: "orphan", at: "active" }),
      ],
    });
    // `fresh` was touched just now, so it is mid-run rather than stuck.
    state.cards[1] = { ...state.cards[1], updatedAt: new Date().toISOString() } as never;

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions.map((action) => `${action.rule}:${action.cardId}`)).toEqual([
      "stuck-prep:stuck",
      "orphaned-active:orphan",
    ]);
    expect(state.cards.find((card) => card.id === "stuck")?.prepStatus).toBe("failed");
    expect(state.cards.find((card) => card.id === "fresh")?.prepStatus).toBe("processing");
    expect(state.cards.find((card) => card.id === "orphan")?.at).toBe("prompts");
  });

  it("leaves ready Prompts for Hermes to plan and launch atomically", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "prepared",
          at: "prompts",
          prepStatus: "ready",
          body: "## Mission",
        }),
        makeFakeCard({
          id: "queued",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "## Mission",
        }),
      ],
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions).toEqual([]);
    expect(state.cards.find((card) => card.id === "prepared")?.at).toBe("prompts");
    expect(state.cards.find((card) => card.id === "queued")?.at).toBe("prompts");
  });

  it("leaves launch alone when the pipeline policy is off", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "prepared",
          at: "prompts",
          prepStatus: "ready",
          body: "## Mission",
        }),
        makeFakeCard({
          id: "queued",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "## Mission",
        }),
      ],
    });

    const rules = await runRulePass({
      api,
      settings: settings({
        hermesAutoMovePromptsToActive: false,
      }),
    });

    expect(rules.actions).toEqual([]);
    expect(state.cards.find((card) => card.id === "prepared")?.at).toBe("prompts");
    expect(state.cards.find((card) => card.id === "queued")?.at).toBe("prompts");
  });

  it("never auto-finishes a stopped Active thread from its closing message", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
      reports: { t1: { threadId: "t1", text: "DONE:\n- shipped it", finishedAt: null } },
    });

    const rules = await runRulePass({ api, settings: settings() });

    // The model reviews the transcript and calls finishCard itself.
    expect(rules.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("active");
  });

  it("merges an open PR, syncing the branch once when it is not mergeable", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "pr", prUrl: "https://forge.test/pr/c1" })],
      mergeFailures: { c1: "not mergeable" },
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.conflicts).toEqual([]);
    expect(state.cards[0]?.at).toBe("done");
  });

  it("hands a PR that stays un-mergeable to the user instead of retrying forever", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "pr", prUrl: "https://forge.test/pr/c1" })],
      mergeFailures: { c1: "conflict in PrPipeline.ts" },
    });
    const stubborn = {
      ...api,
      syncPrBranch: async () => ({ synced: true, reason: null, conflict: null }),
    };

    const rules = await runRulePass({ api: stubborn, settings: settings() });

    expect(rules.conflicts).toEqual([{ cardId: "c1", reason: "conflict in PrPipeline.ts" }]);
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("records what it would do without writing in record-only mode", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "orphan", at: "active" })],
    });

    const rules = await runRulePass({ api, settings: settings(), recordOnly: true });

    expect(rules.logs).toEqual([
      "rule orphaned-active: orphan — Active with no thread, requeued to Prompts",
    ]);
    expect(state.cards[0]?.at).toBe("active");
  });
});

describe("judgmentQueue", () => {
  it("queues a raw Prompt, a ready Prompt with no project, a review and a blocked question", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        rawDraft("d1"),
        makeFakeCard({
          id: "p1",
          at: "prompts",
          prepStatus: "ready",
          body: "already structured",
        }),
        makeFakeCard({ id: "a1", at: "active", threadId: "t1" }),
      ],
      reports: { t1: { threadId: "t1", text: "REMAINING:\n- the rest", finishedAt: null } },
      transcripts: { t1: stoppedTranscript("t1") },
      pendingInputs: [
        { threadId: "t2", requestId: "r1", question: "run tests?", options: ["yes", "no"] },
      ],
    });

    const queue = judgmentQueue({
      snapshot: await collectSnapshot(api, settings()),
      settings: settings(),
    });

    expect(queue.map((item) => `${item.kind}:${item.cardId ?? item.threadId}`)).toEqual([
      "structure:d1",
      "route:p1",
      "review:a1",
      "answer:t2",
    ]);
  });

  it("routes a ready Prompt through Hermes instead of a lifecycle rule", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "p1",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "structured",
        }),
        makeFakeCard({ id: "d1", at: "done", threadId: "t9" }),
      ],
    });

    const queue = judgmentQueue({
      snapshot: await collectSnapshot(api, settings()),
      settings: settings(),
    });

    expect(queue).toEqual([
      {
        kind: "route",
        cardId: "p1",
        threadId: null,
        why: "ready Prompt",
      },
    ]);
  });

  it("keeps reviewing past the escalation point instead of going silent", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      reports: { t1: { threadId: "t1", text: "REMAINING:\n- the rest", finishedAt: null } },
      transcripts: { t1: stoppedTranscript("t1") },
    });
    const snapshot = await collectSnapshot(api, settings());
    const spent = { ...snapshot, reports: snapshot.reports.map((r) => ({ ...r, nudges: 3 })) };

    const queue = judgmentQueue({ snapshot: spent, settings: settings() });
    expect(queue.map((item) => item.kind)).toEqual(["review"]);
    expect(queue[0]?.why).toContain("prefer a decision");
  });

  it("tells the model when it has already judged a card and moved nothing", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1" })],
      transcripts: { t1: stoppedTranscript("t1") },
    });
    const snapshot = await collectSnapshot(api, settings());

    const once = judgmentQueue({
      snapshot,
      settings: settings(),
      reviewsByCardId: new Map([["a1", 1]]),
    });
    expect(once[0]?.why).toContain("looked at 1× with no move");

    const parked = judgmentQueue({
      snapshot,
      settings: settings(),
      reviewsByCardId: new Map([["a1", 4]]),
    });
    expect(parked[0]?.why).toContain("another look will not help");
    expect(modelJudgmentQueue(parked, new Map([["a1", 4]]))).toEqual([]);
  });
});

describe("runOneTick", () => {
  it("asks Hermes for one plan before launching a ready Prompt", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "c1",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "go",
        }),
      ],
    });

    const transcript = await runOneTick({
      api,
      backends: [answering("cursor", launchProgram("c1"))],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(transcript.modelSkipped).toBeUndefined();
    expect(transcript.tier).toBe("cursor");
    expect(transcript.program).toContain("applyLaunchPlan");
    expect(transcript.error).toBeNull();
    expect(transcript.ruleActions).toBe(0);
    expect(transcript.calls.map((call) => call.method)).toContain("applyLaunchPlan");
    expect(state.cards[0]?.at).toBe("active");
  });

  it("asks a tier when a card needs taste, then applies its validated plan", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({ cards: [rawDraft("c1")] });

    const transcript = await runOneTick({
      api,
      backends: [answering("cursor", launchProgram("c1"))],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(transcript.tier).toBe("cursor");
    expect(transcript.modelSkipped).toBeUndefined();
    expect(state.cards[0]).toMatchObject({
      at: "active",
      prepStatus: "ready",
      projectId: "proj-1",
    });
  });

  it("shows the model only what it was asked about", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        rawDraft("c1"),
        makeFakeCard({
          id: "c2",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "already fine",
        }),
      ],
    });
    let asked = "";
    const backend: HermesBackend = {
      tier: "cursor",
      ...claim("cursor"),
      available: async () => ({ tier: "cursor", available: true, detail: "ok" }),
      complete: async (input) => {
        asked = input.user;
        return { text: "```js\nawait board.note({ text: 'ok' });\n```" };
      },
    };

    await runOneTick({
      api,
      backends: [backend],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(asked).toContain("## NEEDS A DECISION");
    expect(asked).toContain("[structure] c1");
    expect(asked).toContain("[route] c2");
    expect(asked).not.toContain("## RULES ALREADY RAN");
  });

  it("dry run records the intended writes and leaves the board alone", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({ cards: [rawDraft("c1")] });

    const transcript = await runOneTick(
      {
        api,
        backends: [answering("openrouter", launchProgram("c1"))],
        boardSettings: async () =>
          settings({
            hermesBrainInstanceId: "opencode",
            hermesBrainModel: "openrouter/x-ai/grok-4.5",
          }),
      },
      { recordOnly: true },
    );

    expect(transcript.recordOnly).toBe(true);
    expect(transcript.calls).toContainEqual(expect.objectContaining({ method: "applyLaunchPlan" }));
    expect(state.cards[0]?.at).toBe("prompts");
  });

  it("plans nothing and measures nothing while budget routing is off", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    let budgetTouched = false;

    const transcript = await runOneTick({
      api,
      backends: [answering("cursor", "await board.note({ text: 'ok' });")],
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesBudgetRoutingEnabled: false }),
      budget: {
        api,
        boardSettings: async () => settings({ hermesBudgetRoutingEnabled: false }),
        listProviders: async () => {
          budgetTouched = true;
          return [];
        },
        readThreadUsage: async () => {
          budgetTouched = true;
          return null;
        },
      },
    });

    expect(transcript.budget).toBeUndefined();
    expect(budgetTouched).toBe(false);
  });

  it("counts nudges across ticks so escalation can be honored", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
      reports: { t1: { threadId: "t1", text: "REMAINING:\n- more", finishedAt: null } },
      transcripts: { t1: stoppedTranscript("t1") },
    });
    const deps = {
      api,
      backends: [answering("xai", "await board.nudgeThread({ threadId: 't1', text: 'more' });")],
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesBrainInstanceId: "grok" }),
    };

    await runOneTick(deps);
    const second = await collectSnapshot(api, settings());

    expect(second.reports[0]?.nudges).toBe(1);
  });

  it("fails the tick on the chosen provider instead of falling through", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });

    const transcript = await runOneTick({
      api,
      backends: [missing("cursor"), answering("openrouter", "await board.note({ text: 'ok' });")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(transcript.tier).toBeNull();
    expect(transcript.error).toMatch(/missing binary/);
    expect(transcript.attempts.map((attempt) => attempt.tier)).toEqual(["cursor"]);
  });

  it("reports a malformed program on the provider that wrote it", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    let openrouterCalls = 0;
    const openrouter: HermesBackend = {
      tier: "openrouter",
      available: async () => ({ tier: "openrouter", available: true, detail: "ok" }),
      complete: async () => {
        openrouterCalls += 1;
        return { text: "```js\nawait board.note({ text: 'ok' });\n```" };
      },
    };

    const transcript = await runOneTick({
      api,
      backends: [answering("cursor", "await board.note("), openrouter],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(transcript.error).not.toBeNull();
    expect(transcript.tier).toBe("cursor");
    expect(openrouterCalls).toBe(0);
  });
});

describe("board status", () => {
  it("names what the tick did to each card so a card can show its own receipt", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [rawDraft("c1"), makeFakeCard({ id: "c2", at: "active", threadId: "t2" })],
      reports: { t2: { threadId: "t2", text: "REMAINING:\n- finish it", finishedAt: null } },
    });

    await runOneTick({
      api,
      backends: [
        answering(
          "cursor",
          [
            launchProgram("c1"),
            "await board.nudgeThread({ threadId: 't2', text: 'finish it' });",
          ].join("\n"),
        ),
      ],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(hermesBoardStatus().cardActivity).toEqual([
      expect.objectContaining({ cardId: "c1", action: "launched", ok: true }),
      expect.objectContaining({ cardId: "c2", action: "nudged the agent", ok: true }),
    ]);
  });

  it("a refused merge is a failed receipt, not a 'Hermes merged' badge", () => {
    const tick = {
      ranAt: "2026-01-01T00:00:00.000Z",
      calls: [
        {
          method: "mergePr",
          args: { id: "c1" },
          result: { merged: false, reason: "Could not merge: Pull request is not mergeable" },
        },
        {
          method: "syncPrBranch",
          args: { id: "c2" },
          result: { synced: false, reason: "merge conflict in src/app.ts" },
        },
        { method: "mergePr", args: { id: "c3" }, result: { merged: true, reason: null } },
      ],
    } as unknown as Parameters<typeof collectCardActivity>[0];

    expect(collectCardActivity(tick, new Map())).toEqual([
      expect.objectContaining({ cardId: "c1", action: "merge the PR", ok: false }),
      expect.objectContaining({ cardId: "c2", action: "sync the PR branch", ok: false }),
      expect.objectContaining({ cardId: "c3", action: "merged", ok: true }),
    ]);
  });

  it("reports a missing routing model instead of silently launching", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "c1",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "go",
        }),
      ],
    });

    await runOneTick({
      api,
      backends: [missing("cursor")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(hermesBoardStatus().consecutiveFailures).toBe(1);
    expect(hermesBoardStatus().lastError).not.toBeNull();
  });

  it("counts failing ticks so the chip can say failing instead of starting", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    const deps = {
      api,
      backends: [missing("cursor")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runOneTick(deps);
    expect(hermesBoardStatus().consecutiveFailures).toBe(1);
    expect(hermesBoardStatus().lastError).not.toBeNull();

    await runOneTick({
      ...deps,
      backends: [answering("cursor", "await board.note({ text: 'ok' });")],
    });
    expect(hermesBoardStatus().consecutiveFailures).toBe(0);
    expect(hermesBoardStatus().lastError).toBeNull();
  });

  it("leaves the board status alone on a dry run", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });

    await runOneTick(
      {
        api,
        backends: [answering("cursor", "await board.structureCard({ id: 'c1', body: 'x' });")],
        boardSettings: async () => settings(),
      },
      { recordOnly: true },
    );

    expect(hermesBoardStatus().cardActivity).toEqual([]);
  });
});

describe("collectSnapshot threads", () => {
  it("reports a threaded card with no agent report so it cannot sit invisible", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
    });
    state.transcripts["t1"] = {
      threadId: "t1",
      title: "old work",
      exists: true,
      archived: false,
      turnState: "completed",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      idleForMs: 7_200_000,
      messageCount: 4,
      entries: [{ at: "2026-01-01T00:00:00.000Z", role: "assistant", text: "shipped it" }],
    };

    const snapshot = await collectSnapshot(api, settings());

    expect(snapshot.reports).toEqual([]);
    expect(snapshot.threads).toEqual([
      {
        cardId: "c1",
        threadId: "t1",
        exists: true,
        turnState: "completed",
        idleForMs: 7_200_000,
        messageCount: 4,
        lastLine: "assistant: shipped it",
        tail: ["assistant: shipped it"],
      },
    ]);
    expect(judgmentQueue({ snapshot, settings: settings() }).map((item) => item.kind)).toEqual([
      "review",
    ]);
  });

  it("leaves archived and done cards out of the snapshot entirely", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        makeFakeCard({ id: "done", at: "done", threadId: "t-done" }),
        makeFakeCard({
          id: "archived",
          at: "active",
          threadId: "t-arch",
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    const snapshot = await collectSnapshot(api, settings());

    expect(snapshot.threads).toEqual([]);
  });
});

describe("hermes tick log", () => {
  it("logs every tick, counts only real ones, and serves transcripts by id", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    const deps = {
      api,
      backends: [answering("cursor", launchProgram("c1"))],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runOneTick(deps, { recordOnly: true });
    const real = await runOneTick(deps);
    const status = await hermesBrainStatus(deps);

    expect(status.log.map((entry) => entry.recordOnly)).toEqual([false, true]);
    expect(status.log[0]?.writeCount).toBeGreaterThanOrEqual(1);
    expect(status.stats.ticks).toBe(1);
    expect(status.stats.writes).toBeGreaterThanOrEqual(1);
    expect(status.stats.servedByTier).toContainEqual({ tier: "cursor", served: 1 });
    expect(hermesTickById(real.id)?.program).toContain("applyLaunchPlan");
    expect(hermesTickById("nope")).toBeNull();
  });

  it("counts semantic launch writes separately from lifecycle rules", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "c1",
          at: "prompts",
          prepStatus: "ready",
          projectId: "proj-1",
          body: "go",
        }),
      ],
    });
    const deps = {
      api,
      backends: [answering("cursor", launchProgram("c1"))],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runOneTick(deps);
    const status = await hermesBrainStatus(deps);

    expect(status.stats.ticks).toBe(1);
    expect(status.stats.modelSkipped).toBe(0);
    expect(status.stats.ruleWrites).toBe(0);
    expect(status.stats.writes).toBeGreaterThanOrEqual(1);
  });

  it("counts lifecycle rule firings without treating semantic launch as a rule", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c2", at: "active", threadId: null })],
    });
    const deps = {
      api,
      backends: [answering("cursor", "await board.note({ text: 'waiting for routing' });")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runOneTick(deps);
    const status = await hermesBrainStatus(deps);

    const fired = new Map(status.stats.rules.map((entry) => [entry.rule, entry.fired]));
    expect(fired.has("ready-prompt")).toBe(false);
    expect(fired.get("orphaned-active")).toBe(1);
    expect(status.stats.rules.every((entry) => typeof entry.lastFiredAt === "string")).toBe(true);
  });

  it("a dry run is not a firing", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: null })],
    });
    const deps = {
      api,
      backends: [refusing("cursor")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runRecoveryPass(deps, settings({ hermesBrainEnabled: true }), { recordOnly: true });

    expect((await hermesBrainStatus(deps)).stats.rules).toEqual([]);
  });
});

describe("hermes model", () => {
  it("asks Cursor for its native model when the brain model is provider-specific", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    const cursor = recordingModel("cursor");

    await runOneTick({
      api,
      backends: [cursor.backend],
      boardSettings: async () =>
        settings({ hermesBrainEnabled: true, hermesBrainModel: "x-ai/grok-5" }),
    });

    expect(cursor.seen).toEqual(["composer-2.5"]);

    const status = await hermesBrainStatus({
      api,
      backends: [cursor.backend],
      boardSettings: async () => settings({ hermesBrainModel: "x-ai/grok-5" }),
    });

    expect(status.model).toBe("x-ai/grok-5");
    expect(status.tiers.find((tier) => tier.tier === "cursor")?.model).toBe("composer-2.5");
  });
});

describe("hermesBrainStatus", () => {
  it("reports native Cursor and Grok tier models when Codex is the luna brain", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });

    const status = await hermesBrainStatus({
      api,
      backends: [answering("cursor", ""), answering("xai", ""), answering("codex", "")],
      boardSettings: async () =>
        settings({ hermesBrainInstanceId: "codex", hermesBrainModel: "gpt-5.6-luna" }),
    });

    expect(status.model).toBe("gpt-5.6-luna");
    expect(status.tiers.find((tier) => tier.tier === "cursor")?.model).toBe("composer-2.5");
    expect(status.tiers.find((tier) => tier.tier === "xai")?.model).toBe("grok-4.5");
    expect(status.tiers.find((tier) => tier.tier === "codex")?.model).toBe("gpt-5.6-luna");
    expect(status.tiers.find((tier) => tier.tier === "cursor")?.model).not.toBe(status.model);
    expect(status.tiers.find((tier) => tier.tier === "xai")?.model).not.toBe(status.model);
  });

  it("is on by default, pipeline included, and reports every provider's availability", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });

    const status = await hermesBrainStatus({
      api,
      backends: [missing("cursor"), answering("openrouter", "")],
      boardSettings: async () => settings(),
    });

    expect(status.enabled).toBe(true);
    expect(DEFAULT_BOARD_SETTINGS.hermesAutoApplySkillsToAutoMovedPrompts).toBe(true);
    expect(DEFAULT_BOARD_SETTINGS.hermesAutoMovePromptsToActive).toBe(true);
    expect(status.model).toBe("x-ai/grok-4.5");
    expect(status.provider).toBe("cursor");
    expect(status.instanceId).toBe("cursor");
    expect(status.tiers).toEqual([
      {
        tier: "cursor",
        enabled: true,
        available: false,
        detail: "missing binary",
        model: "composer-2.5",
      },
      { tier: "xai", enabled: false, available: false, detail: "no backend", model: "grok-4.5" },
      {
        tier: "codex",
        enabled: false,
        available: false,
        detail: "no backend",
        model: "gpt-5.6-sol",
      },
      {
        tier: "openrouter",
        enabled: false,
        available: true,
        detail: "ok",
        model: "x-ai/grok-4.5",
      },
    ]);
    expect(status.lastTick).toBeNull();
  });

  it("serves the picked instance's transport and still probes the others", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });

    const status = await hermesBrainStatus({
      api,
      backends: [answering("cursor", ""), answering("openrouter", "")],
      boardSettings: async () =>
        settings({
          hermesBrainInstanceId: "opencode",
          hermesBrainModel: "openrouter/x-ai/grok-4.5",
        }),
    });

    expect(status.provider).toBe("openrouter");
    expect(status.tiers.find((tier) => tier.tier === "cursor")).toMatchObject({
      enabled: false,
      available: true,
    });
  });

  it("fails with a reason when no instance is picked — there is no chain head", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [] });

    const status = await hermesBrainStatus({
      api,
      backends: [answering("cursor", ""), answering("openrouter", "")],
      boardSettings: async () => settings({ hermesBrainInstanceId: null }),
    });

    expect(status.provider).toBeNull();
    expect(status.providerError).toContain("no provider instance is picked");
  });

  it("runs the tick on the picked provider and never asks another one", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({ cards: [rawDraft("c1")] });
    const cursor = recordingModel("cursor");

    const tick = await runOneTick({
      api,
      backends: [cursor.backend],
      boardSettings: async () =>
        settings({
          hermesBrainEnabled: true,
          hermesBrainInstanceId: "opencode",
          hermesBrainModel: "openrouter/x-ai/grok-4.5",
        }),
    });

    expect(cursor.seen).toEqual([]);
    expect(tick.tier).toBeNull();
    expect(tick.error).toContain("not a transport Hermes can run");
  });
});

describe("board wake", () => {
  const loopDeps = () => {
    // The heartbeat skips an empty board, so the wake has to have work to find.
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts", body: "wake me" })],
    });
    return {
      state,
      deps: {
        api,
        backends: [answering("cursor", "await board.list();")],
        boardSettings: async () => settings({ hermesBrainEnabled: true }),
      },
    };
  };

  it("ticks on a board event instead of waiting out the interval", async () => {
    resetHermesBrainState();
    vi.useFakeTimers();
    try {
      const { deps } = loopDeps();
      const stop = startHermesBrainLoop(deps, { intervalMs: 600_000 });

      requestHermesWake("card created in draft");
      await vi.advanceTimersByTimeAsync(1_000);
      stop();

      expect(lastHermesTick()).toMatchObject({
        trigger: "wake",
        wakeReason: "card created in draft",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a burst to one tick per minimum gap", async () => {
    resetHermesBrainState();
    vi.useFakeTimers();
    try {
      const { deps } = loopDeps();
      const stop = startHermesBrainLoop(deps, { intervalMs: 600_000 });

      // Heartbeats, not ticks: the gap is a floor on loop firings, and the
      // second firing sees an unchanged board and skips the model by design.
      requestHermesWake("card created in draft");
      requestHermesWake("card moved to prompts");
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await hermesBrainStatus(deps)).stats.heartbeats).toBe(1);

      requestHermesWake("card edited");
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await hermesBrainStatus(deps)).stats.heartbeats).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect((await hermesBrainStatus(deps)).stats.heartbeats).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op once the loop is stopped", async () => {
    resetHermesBrainState();
    vi.useFakeTimers();
    try {
      const { deps } = loopDeps();
      startHermesBrainLoop(deps, { intervalMs: 600_000 })();

      requestHermesWake("card created in draft");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(lastHermesTick()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("self-heal", () => {
  const failingOpenPrBoard = () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
      transcripts: { t1: stoppedTranscript("t1", "All of it is done and verified.") },
    });
    (api as { openPr: unknown }).openPr = async () => {
      throw new Error("Open pull request failed: Git command failed in GitVcsDriver.commit.commit");
    };
    return { api, state };
  };

  // The model reviews the stopped thread, judges it done and calls finishCard;
  // the broken board op underneath is what self-heal must catch.
  const finishing = () => answering("cursor", "await board.finishCard({ id: 'c1' });");

  it("files one fix Prompt after three straight openPr failures", async () => {
    resetHermesBrainState();
    const { api, state } = failingOpenPrBoard();
    const deps = {
      api,
      backends: [finishing()],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    };

    await runOneTick(deps);
    await runOneTick(deps);
    expect(state.cards.some((card) => card.title.startsWith("Fix board loop:"))).toBe(false);

    await runOneTick(deps);
    const fix = state.cards.filter((card) => card.title === "Fix board loop: openPr keeps failing");
    expect(fix).toHaveLength(1);
    expect(fix[0]?.at).toBe("prompts");
    expect(fix[0]?.body).toContain("GitVcsDriver.commit.commit");
  });

  it("does not file a second card while the first is still open", async () => {
    resetHermesBrainState();
    const { api, state } = failingOpenPrBoard();
    const deps = {
      api,
      backends: [finishing()],
      boardSettings: async () =>
        settings({
          hermesBrainEnabled: true,
          // Keep the fix Prompt unready so structuring/launch does not start it.
          hermesAutoApplySkillsToAutoMovedPrompts: false,
        }),
    };

    for (let index = 0; index < 5; index += 1) await runOneTick(deps);
    const fix = state.cards.filter((card) => card.title === "Fix board loop: openPr keeps failing");
    expect(fix).toHaveLength(1);
  });

  it("clears the failure once the same operation succeeds", () => {
    resetHermesBrainState();
    const failing = {
      ranAt: "2026-01-01T00:00:00.000Z",
      error: null,
      recordOnly: false,
      calls: [{ method: "openPr", args: { id: "c1" }, error: "boom" }],
    } as unknown as Parameters<typeof trackBoardFailures>[0];
    trackBoardFailures(failing);
    trackBoardFailures(failing);
    expect(repeatedBoardFailures()).toHaveLength(1);

    const recovered = {
      ranAt: "2026-01-01T00:01:00.000Z",
      error: null,
      recordOnly: false,
      calls: [{ method: "openPr", args: { id: "c1" }, result: { prUrl: "x" } }],
    } as unknown as Parameters<typeof trackBoardFailures>[0];
    trackBoardFailures(recovered);
    expect(repeatedBoardFailures()).toHaveLength(0);
  });
});
