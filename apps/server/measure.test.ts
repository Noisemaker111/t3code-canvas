// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, it } from "@effect/vitest";
import {
  buildHermesSystemPrompt,
  buildHermesSnapshotBlock,
  buildHermesDeltaBlock,
  type HermesSnapshot,
} from "./prompt.ts";
import { judgmentQueue, formatJudgmentQueue } from "./judgment.ts";

const card = (o: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    title: "Make the theme blue",
    body: "Mission\n- blue",
    at: "active",
    position: 1,
    threadId: "t1",
    prUrl: null,
    projectId: "proj-1",
    modelSelection: null,
    prepStatus: "ready",
    baseBranch: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  }) as never;
const settings = {
  hermesStuckPrepMs: 120_000,
  hermesBrainMaxNudges: 3,
  hermesAutoStructureDrafts: true,
  hermesAutoLaunchPrompts: true,
  columnRules: [],
} as never;
const snap = {
  cards: [card()],
  projects: [],
  models: [],
  pendingInputs: [],
  policy: { maxNudgesPerCard: 3 },
  reports: [],
  threads: [
    {
      cardId: "c1",
      threadId: "t1",
      exists: true,
      turnState: "idle",
      idleForMs: 600_000,
      messageCount: 12,
      lastLine: "assistant: done",
      tail: ["assistant: phase 1 landed — should phase 2 reuse that store or get its own?"],
    },
  ],
  ruleLog: ["ready-prompt fired"],
  journal: [
    { cardId: "c1", at: "2026-01-01T00:00:00.000Z", action: "nudgeThread", ok: true, error: null },
  ],
  failures: [{ method: "openPr", cardId: "c1", count: 3, error: "non-zero" }],
  papercuts: [
    {
      tool: "apply_patch",
      scope: "harness",
      summary: "fails",
      count: 3,
      threads: 2,
      workaround: "scripted edits",
    },
  ],
  knowledge: [
    {
      id: "p:1",
      projectId: "proj-1",
      topic: "theming",
      lesson: "Theme tokens live in tokens.css.",
      evidence: null,
      source: "user",
      learnedCount: 2,
      taughtCount: 3,
      cardIds: [],
      status: "active",
      retiredReason: null,
      firstLearnedAt: "x",
      lastLearnedAt: "x",
      lastTaughtAt: null,
    },
  ],
  canvasMessages: [
    {
      id: "m1",
      authorKind: "user",
      authorId: null,
      text: "why did you route that",
      hasImage: false,
    },
  ],
} as unknown as HermesSnapshot;

describe("measure", () => {
  it("prints", () => {
    const q = judgmentQueue({ snapshot: snap, settings, reviewsByCardId: new Map([["c1", 3]]) });
    const asked = { ...snap, judgment: q } as HermesSnapshot;
    console.log(
      JSON.stringify({
        system: buildHermesSystemPrompt().length,
        firstTurn: buildHermesSnapshotBlock(asked).length,
        deltaTurn: buildHermesDeltaBlock(asked, { c1: "old" }).length,
        queue: formatJudgmentQueue(q).length,
      }),
    );
  });
});
