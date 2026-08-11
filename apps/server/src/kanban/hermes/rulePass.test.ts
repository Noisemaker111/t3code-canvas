import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BoardSettings } from "@t3tools/contracts";

import {
  bindHealthIncidentLog,
  readHealthIncidents,
  unbindHealthIncidentLog,
} from "../../health/incidentLog.ts";
import {
  CHECKS_RED_MARKER,
  checksRedText,
  clearCompletionCheckCounts,
  completionCheckText,
} from "./completionPass.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { finishCard, runRulePass } from "./rulePass.ts";

const settings = {
  hermesAutoMovePromptsToActive: false,
  hermesStuckPrepMs: 120_000,
  hermesAutoMergeWhenGreen: true,
  hermesPrCheckGraceMs: 600_000,
} as unknown as BoardSettings;

/** The red-CI loop needs the Active half of the rules on, not just the PR half. */
const fixSettings = {
  ...settings,
  hermesAutoFinishActive: true,
  hermesReviewPassEnabled: false,
  hermesCompletionMaxChecks: 10,
  hermesBrainMaxNudges: 3,
} as unknown as BoardSettings;

const prCard = () =>
  makeFakeCard({
    id: "card-pr",
    at: "pr",
    prUrl: "https://github.test/pr/1",
    threadId: "thread-1",
    body: "# Goal: ship it",
  });

describe("runRulePass — PR checks", () => {
  it("sends a card with red checks back to Active and tells the thread what broke", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: {
        "card-pr": {
          state: "failing",
          failing: [{ name: "t3 server tests", url: "https://github.test/run/9" }],
        },
      },
    });

    const result = await runRulePass({ api, settings });

    expect(state.cards[0]?.at).toBe("active");
    expect(result.actions.map((action) => action.rule)).toEqual(["pr-checks-red"]);
    expect(state.nudges).toHaveLength(1);
    expect(state.nudges[0]?.text).toContain("t3 server tests");
    expect(state.nudges[0]?.text).toContain("https://github.test/run/9");
    expect(state.nudges[0]?.text).toContain("you do not touch git");
  });

  it("does not attempt a merge while checks are still running", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "pending", failing: [] } },
    });

    const result = await runRulePass({ api, settings });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("pr");
    expect(result.logs.join("\n")).toContain("checks still running");
  });

  it("merges when the checks are green", async () => {
    const { api } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
    });

    const result = await runRulePass({ api, settings });

    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr"]);
  });

  it("never merges a PR whose checks it could not read", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "unknown", failing: [], unknownReason: "unavailable" } },
    });

    const result = await runRulePass({ api, settings });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("pr");
    expect(result.logs.join("\n")).toContain("could not read the PR's checks");
  });

  it("records a degradation when the forge call itself throws, so it is not just a tick log", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [prCard()] });
    const failing = {
      ...api,
      prChecks: async () => {
        throw new Error("gh: rate limited");
      },
    };
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rule-pass-"));
    bindHealthIncidentLog(baseDir);
    try {
      const result = await runRulePass({ api: failing, settings });

      expect(result.actions).toEqual([]);
      expect(state.cards[0]?.at).toBe("pr");
      const incidents = readHealthIncidents(10);
      expect(incidents.map((incident) => incident.id)).toEqual(["degraded.hermes.pr-checks"]);
      expect(incidents[0]?.detail).toContain("gh: rate limited");
    } finally {
      unbindHealthIncidentLog();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("leaves a fresh PR alone while its check runs have not registered yet", async () => {
    const openedAtMs = Date.parse("2026-07-31T12:00:00.000Z");
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: {
        "card-pr": { state: "unknown", failing: [], unknownReason: "no_checks", openedAtMs },
      },
    });

    const result = await runRulePass({ api, settings, now: () => openedAtMs + 60_000 });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("pr");
    expect(result.logs.join("\n")).toContain("no check has registered yet");
  });

  it("merges a checkless repo's PR once the grace window is spent", async () => {
    const openedAtMs = Date.parse("2026-07-31T12:00:00.000Z");
    const { api } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: {
        "card-pr": { state: "unknown", failing: [], unknownReason: "no_checks", openedAtMs },
      },
    });

    const result = await runRulePass({ api, settings, now: () => openedAtMs + 700_000 });

    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr"]);
  });

  it("ages a checkless PR off the card clock when the forge gave no opened-at", async () => {
    // Production reads come back with `openedAtMs: null`, so the grace window
    // is measured from the card. A card read as a wire string parsed to age 0
    // and sat in PR forever.
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ ...prCard(), updatedAt: "2026-07-31T12:00:00.000Z" } as never)],
      prChecks: {
        "card-pr": { state: "unknown", failing: [], unknownReason: "no_checks", openedAtMs: null },
      },
    });

    const result = await runRulePass({
      api,
      settings,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    });

    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr"]);
  });

  it("moves a red card back even when it has no thread left to nudge", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ ...prCard(), threadId: null } as never)],
      prChecks: { "card-pr": { state: "failing", failing: [] } },
    });

    const result = await runRulePass({ api, settings });

    expect(state.cards[0]?.at).toBe("active");
    expect(result.actions[0]?.detail).toContain("a required check");
    expect(state.nudges).toEqual([]);
  });

  it("hands a base-branch conflict back to the thread instead of filing it as a human's", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
      mergeFailures: { "card-pr": "not mergeable" },
      syncConflicts: {
        "card-pr": {
          baseBranch: "main",
          headBranch: "feature/ship-it",
          files: ["apps/server/src/kanban/PrPipeline.ts"],
          baseCommits: ["a27274e verify: add --changed"],
          behindCount: 12,
          worktreePath: "/root/projects/.worktrees/thread-1",
        },
      },
    });

    const result = await runRulePass({ api, settings });

    expect(state.cards[0]?.at).toBe("active");
    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr", "pr-conflicts"]);
    // The card is the thread's problem now, so it is not also a "needs you".
    expect(result.conflicts).toEqual([]);
    const text = state.nudges[0]?.text ?? "";
    expect(text).toContain("out of sync");
    expect(text).toContain("12 commits landed on main");
    expect(text).toContain("apps/server/src/kanban/PrPipeline.ts");
    expect(text).toContain("a27274e verify: add --changed");
    expect(text).toContain("you still do not run git");
  });

  it("stops bouncing a card once the base has collided as many times as the cap allows", async () => {
    const conflict = {
      baseBranch: "main",
      headBranch: "feature/ship-it",
      files: ["apps/server/src/kanban/PrPipeline.ts"],
      baseCommits: [],
      behindCount: 3,
      worktreePath: null,
    };
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
      mergeFailures: { "card-pr": "not mergeable" },
      syncConflicts: { "card-pr": conflict },
      transcripts: {
        "thread-1": {
          threadId: "thread-1",
          title: "ship it",
          exists: true,
          archived: false,
          turnState: "completed",
          lastActivityAt: null,
          idleForMs: 0,
          messageCount: 1,
          entries: [
            {
              at: "2026-07-29T00:00:00Z",
              role: "user",
              text: "Hermes conflict sync — x\n\n(sync 3 of 3)",
            },
          ],
        },
      },
    });

    const result = await runRulePass({ api, settings: { ...settings, hermesBrainMaxNudges: 3 } });

    expect(state.cards[0]?.at).toBe("pr");
    expect(state.nudges).toEqual([]);
    expect(result.conflicts[0]?.reason).toContain("collided with this branch 3 times");
  });

  it("names every failing check and counts the round it is handing back", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: {
        "card-pr": {
          state: "failing",
          failing: [
            { name: "t3 server tests", url: "https://github.test/run/9" },
            { name: "lint", url: null },
          ],
        },
      },
    });

    const result = await runRulePass({ api, settings: { ...settings, hermesBrainMaxNudges: 3 } });

    expect(state.cards[0]?.at).toBe("active");
    expect(result.actions[0]?.detail).toContain("fix 1");
    const text = state.nudges[0]?.text ?? "";
    expect(text).toContain(CHECKS_RED_MARKER);
    expect(text).toContain("t3 server tests");
    expect(text).toContain("https://github.test/run/9");
    expect(text).toContain("lint");
    expect(text).toContain("https://github.test/pr/1");
    expect(text).toContain("(fix 1 of 3)");
  });

  it("stops bouncing a card whose checks have been red as many times as the cap allows", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: {
        "card-pr": { state: "failing", failing: [{ name: "t3 server tests", url: null }] },
      },
      transcripts: {
        "thread-1": {
          threadId: "thread-1",
          title: "ship it",
          exists: true,
          archived: false,
          turnState: "completed",
          lastActivityAt: null,
          idleForMs: 0,
          messageCount: 1,
          entries: [
            {
              at: "2026-07-29T00:00:00Z",
              role: "user",
              text: `${CHECKS_RED_MARKER} — CI went red.\n\n(fix 3 of 3)`,
            },
          ],
        },
      },
    });

    const result = await runRulePass({ api, settings: { ...settings, hermesBrainMaxNudges: 3 } });

    expect(state.cards[0]?.at).toBe("pr");
    expect(state.nudges).toEqual([]);
    expect(result.conflicts[0]?.reason).toContain("CI has gone red 3 times");
    expect(result.conflicts[0]?.reason).toContain("t3 server tests");
  });

  it("pushes the fix back onto the same pull request once the thread says it is done", async () => {
    clearCompletionCheckCounts();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "card-fix",
          at: "active",
          threadId: "thread-fix",
          prUrl: "https://github.test/pr/1",
          body: "# Goal: ship it",
        }),
      ],
      transcripts: {
        "thread-fix": {
          threadId: "thread-fix",
          title: "ship it",
          exists: true,
          archived: false,
          turnState: "completed",
          lastActivityAt: null,
          idleForMs: 0,
          messageCount: 2,
          entries: [
            {
              at: "2026-07-29T00:00:00Z",
              role: "user",
              text: checksRedText(
                { failing: [{ name: "t3 server tests", url: null }], prUrl: null },
                1,
                3,
              ),
            },
            {
              at: "2026-07-29T00:01:00Z",
              role: "assistant",
              text: "DONE:\n- fixed the null case\n\nREMAINING:\n- none",
            },
          ],
        },
      },
    });

    const result = await runRulePass({ api, settings: fixSettings });

    expect(result.actions.map((action) => action.rule)).toEqual(["finish-active"]);
    expect(result.actions[0]?.detail).toContain("pushing it to the open pull request");
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("waits for the thread's answer to the CI brief instead of re-reading an older DONE", async () => {
    clearCompletionCheckCounts();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "card-fix",
          at: "active",
          threadId: "thread-fix",
          prUrl: "https://github.test/pr/1",
          body: "# Goal: ship it",
        }),
      ],
      transcripts: {
        "thread-fix": {
          threadId: "thread-fix",
          title: "ship it",
          exists: true,
          archived: false,
          turnState: "completed",
          lastActivityAt: null,
          idleForMs: 0,
          messageCount: 3,
          entries: [
            {
              at: "2026-07-29T00:00:00Z",
              role: "user",
              text: completionCheckText({ title: "ship it", body: "ship it" }, 1, 10),
            },
            {
              at: "2026-07-29T00:01:00Z",
              role: "assistant",
              text: "DONE:\n- shipped it\n\nREMAINING:\n- none",
            },
            {
              at: "2026-07-29T00:02:00Z",
              role: "user",
              text: checksRedText(
                { failing: [{ name: "t3 server tests", url: null }], prUrl: null },
                1,
                3,
              ),
            },
          ],
        },
      },
    });

    const result = await runRulePass({ api, settings: fixSettings });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("active");
    expect(result.logs.join("\n")).toContain("waiting on the thread");
  });

  it("records the move without writing it in a dry run", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "failing", failing: [{ name: "ci", url: null }] } },
    });

    const result = await runRulePass({ api, settings, recordOnly: true });

    expect(result.actions.map((action) => action.rule)).toEqual(["pr-checks-red"]);
    expect(state.cards[0]?.at).toBe("pr");
    expect(state.nudges).toEqual([]);
  });
});

describe("runRulePass — rules are read off boardSettings.rules", () => {
  it("a stored checksGreen row that does not merge stops merging, flag or not", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
    });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: {
          pr: [
            { when: "cardArrives", then: "openPr", arg: "" },
            { when: "checksGreen", then: "moveHere", arg: "" },
          ],
        },
      } as unknown as BoardSettings,
    });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("pr");
    expect(result.logs.join("\n")).toContain("auto-merge is off");
  });

  it("a stored pr column with the merge row merges even when the legacy flag is off", async () => {
    const { api } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
    });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        hermesAutoMergeWhenGreen: false,
        rules: { pr: [{ when: "checksGreen", then: "mergePr", arg: "" }] },
      } as unknown as BoardSettings,
    });

    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr"]);
  });

  it("a board that never saved a column still answers from the flag it was written to", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
    });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        hermesAutoMergeWhenGreen: false,
        rules: {},
      } as unknown as BoardSettings,
    });

    expect(result.actions).toEqual([]);
    expect(state.cards[0]?.at).toBe("pr");
  });
});

describe("runRulePass — prConflict", () => {
  const conflict = {
    baseBranch: "main",
    headBranch: "feature/ship-it",
    files: ["apps/server/src/kanban/PrPipeline.ts"],
    baseCommits: [],
    behindCount: 3,
    worktreePath: null,
  };
  const conflicted = () =>
    makeFakeBoardApi({
      cards: [prCard()],
      prChecks: { "card-pr": { state: "passing", failing: [] } },
      mergeFailures: { "card-pr": "not mergeable" },
      syncConflicts: { "card-pr": conflict },
    });

  it("a pr column saved before the trigger existed still sends the card back", async () => {
    const { api, state } = conflicted();

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: { pr: [{ when: "checksGreen", then: "mergePr", arg: "" }] },
      } as unknown as BoardSettings,
    });

    expect(state.cards[0]?.at).toBe("active");
    expect(result.actions.map((action) => action.rule)).toEqual(["mergeable-pr", "pr-conflicts"]);
  });

  it("deleting the row makes the conflict a human's, said out loud", async () => {
    const { api, state } = conflicted();

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: {
          pr: [
            { when: "checksGreen", then: "mergePr", arg: "" },
            { when: "prConflict", then: "moveHere", arg: "" },
          ],
        },
      } as unknown as BoardSettings,
    });

    expect(state.cards[0]?.at).toBe("pr");
    expect(state.nudges).toEqual([]);
    const failed = result.actions.find((action) => action.rule === "pr-conflicts");
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain("only moveTo is");
  });

  it("follows the row's own target column", async () => {
    const { api, state } = conflicted();

    await runRulePass({
      api,
      settings: {
        ...settings,
        rules: {
          pr: [
            { when: "checksGreen", then: "mergePr", arg: "" },
            { when: "prConflict", then: "moveTo", arg: "prompts" },
          ],
        },
      } as unknown as BoardSettings,
    });

    expect(state.cards[0]?.at).toBe("prompts");
  });
});

describe("runRulePass — cardStalled", () => {
  const stalledCard = () =>
    makeFakeCard({
      id: "card-still",
      at: "pr",
      prUrl: "https://github.test/pr/1",
      columnEnteredAt: "2026-01-01T00:00:00.000Z",
    });
  const later = Date.parse("2026-01-01T02:00:00.000Z");
  /** Keeps `mergeable-pr` out of the way — this suite is about the stall clock. */
  const stillRunning = { "card-still": { state: "pending" as const, failing: [] } };

  it("does nothing until a column has the row", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [stalledCard()], prChecks: stillRunning });

    const result = await runRulePass({ api, settings, now: () => later });

    expect(result.actions.map((action) => action.rule)).not.toContain("card-stalled");
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("moves a card that has sat in its column past the threshold", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [stalledCard()] });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "prompts" }] },
      } as unknown as BoardSettings,
      now: () => later,
    });

    expect(state.cards[0]?.at).toBe("prompts");
    const fired = result.actions.find((action) => action.rule === "card-stalled");
    expect(fired?.ok).toBe(true);
    expect(fired?.detail).toContain("moved to prompts");
  });

  it("leaves a card whose column clock has not run out", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [stalledCard()] });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "prompts" }] },
      } as unknown as BoardSettings,
      now: () => Date.parse("2026-01-01T00:05:00.000Z"),
    });

    expect(result.actions.map((action) => action.rule)).not.toContain("card-stalled");
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("never moves a card whose thread is mid-turn", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ ...stalledCard(), threadId: "thread-1" } as never)],
      prChecks: stillRunning,
      transcripts: {
        "thread-1": {
          threadId: "thread-1",
          title: "ship it",
          exists: true,
          archived: false,
          turnState: "running",
          lastActivityAt: null,
          idleForMs: 0,
          messageCount: 1,
          entries: [],
        },
      },
    });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "prompts" }] },
      } as unknown as BoardSettings,
      now: () => later,
    });

    expect(result.actions.map((action) => action.rule)).not.toContain("card-stalled");
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("reports a row it cannot run rather than ignoring it", async () => {
    const { api } = makeFakeBoardApi({ cards: [stalledCard()] });

    const result = await runRulePass({
      api,
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "mergePr", arg: "" }] },
      } as unknown as BoardSettings,
      now: () => later,
    });

    const failed = result.actions.find((action) => action.rule === "card-stalled");
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain("only moveTo is");
  });

  it("stamps the rule on the move, so the card can say who moved it", async () => {
    const moves: Array<unknown> = [];
    const { api } = makeFakeBoardApi({ cards: [stalledCard()] });
    const recording = {
      ...api,
      updateCard: async (input: Parameters<typeof api.updateCard>[0]) => {
        moves.push(input);
        return api.updateCard(input);
      },
    };

    await runRulePass({
      api: recording,
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "prompts" }] },
      } as unknown as BoardSettings,
      now: () => later,
    });

    expect(moves).toEqual([{ id: "card-still", at: "prompts", movedBy: "card-stalled" }]);
  });
});

describe("finishCard", () => {
  it("opens the pull request and stops there — merging is the check gate's call", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-1", at: "active", threadId: "thread-1" })],
    });

    const result = await finishCard(api, "card-1");

    expect(result.prUrl).toBe("https://forge.test/pr/card-1");
    expect(result.merged).toBe(false);
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("does not merge a card that is already in PR", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-1", at: "pr", prUrl: "https://forge.test/pr/card-1" })],
    });

    const result = await finishCard(api, "card-1");

    expect(result.merged).toBe(false);
    expect(state.cards[0]?.at).toBe("pr");
  });
});
