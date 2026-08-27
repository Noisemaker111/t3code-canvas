// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Size gates on the text the loop bills for.
 *
 * The agent contract has had one of these since it was six-to-one against the
 * task it shipped with. Everything else the loop sends grew without one, and
 * the same thing happened: standing explanation restated in every turn,
 * justifications argued at a model once and then paid for forever.
 *
 * Two prices, and they are not the same. The system prompt is a cached prefix —
 * paid about once. Every block a turn carries is new tokens on every tick, and
 * a per-card line is new tokens times the cards. So the per-turn budgets here
 * are tight and the system-prompt budget is loose: standing instruction belongs
 * in the prefix, not in the turn.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  buildHermesSystemPrompt,
  buildHermesSnapshotBlock,
  type HermesSnapshot,
} from "./prompt.ts";
import { judgmentQueue, formatJudgmentQueue } from "./judgment.ts";

const card = (over: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    title: "Make the theme blue",
    body: "Mission\n- make the theme blue",
    at: "prompts",
    position: 1,
    threadId: null,
    prUrl: null,
    projectId: null,
    modelSelection: null,
    prepStatus: "untouched",
    baseBranch: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as never;

const settings = {
  hermesStuckPrepMs: 120_000,
  hermesBrainMaxNudges: 3,
  hermesAutoStructureDrafts: true,
  hermesAutoLaunchPrompts: true,
  columnRules: [],
} as never;

const thread = (over: Record<string, unknown> = {}) => ({
  cardId: "c1",
  threadId: "t1",
  exists: true,
  turnState: "idle",
  idleForMs: 600_000,
  messageCount: 12,
  lastLine: "assistant: done with phase 1",
  tail: ["assistant: done with phase 1"],
  ...over,
});

const reviewLine = (over: Record<string, unknown>, reviews: number): string => {
  const snapshot = {
    cards: [card({ at: "active", threadId: "t1", projectId: "proj-1" })],
    projects: [],
    models: [],
    pendingInputs: [],
    policy: {},
    reports: [],
    threads: [thread(over)],
  } as unknown as HermesSnapshot;
  return formatJudgmentQueue(
    judgmentQueue({ snapshot, settings, reviewsByCardId: new Map([["c1", reviews]]) }),
  );
};

/** Everything a quiet board still sends: block headers with nothing under them. */
const emptyBlockOverhead = (): number => {
  const snapshot = {
    cards: [],
    projects: [],
    models: [],
    pendingInputs: [],
    policy: {},
    reports: [],
    threads: [],
    judgment: [],
    ruleLog: [],
    papercuts: [
      { tool: "t", scope: "harness", summary: "s", count: 1, threads: 1, workaround: null },
    ],
    knowledge: [],
    canvasMessages: [],
  } as unknown as HermesSnapshot;
  return buildHermesSnapshotBlock(snapshot).length;
};

describe("prompt budgets", () => {
  it("keeps the cached system prompt under its ceiling", () => {
    expect(buildHermesSystemPrompt().length).toBeLessThan(13_000);
  });

  it("keeps a near-empty turn cheap — headers are labels, not lectures", () => {
    expect(emptyBlockOverhead()).toBeLessThan(700);
  });

  it("keeps a stopped-thread queue line short", () => {
    expect(reviewLine({}, 0).length).toBeLessThan(200);
  });

  it("keeps the question queue line short", () => {
    const line = reviewLine(
      { tail: ["assistant: phase 1 landed — should phase 2 reuse that store or get its own?"] },
      0,
    );
    expect(line.length).toBeLessThan(320);
  });

  it("keeps the stall escalation short", () => {
    expect(reviewLine({}, 3).length).toBeLessThan(400);
  });
});
