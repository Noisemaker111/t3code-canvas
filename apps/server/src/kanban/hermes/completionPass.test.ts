import { describe, expect, it } from "@effect/vitest";

import type { BoardSettings } from "@t3tools/contracts";

import type { BoardThreadTranscript } from "./boardApi.ts";
import {
  COMPLETION_MARKER,
  REVIEW_MARKER,
  completionCheckText,
  completionStage,
  continueText,
  prRefusedText,
} from "./completionPass.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { runRulePass } from "./rulePass.ts";

type Entry = BoardThreadTranscript["entries"][number];

const say = (role: string, text: string): Entry => ({ at: "2026-01-01T00:00:00.000Z", role, text });

const transcript = (entries: ReadonlyArray<Entry>): BoardThreadTranscript => ({
  threadId: "t1",
  title: "thread t1",
  exists: true,
  archived: false,
  turnState: "completed",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  idleForMs: 120_000,
  messageCount: entries.length,
  entries,
});

const stageOf = (entries: ReadonlyArray<Entry>, reviewPassEnabled = false, maxChecks = 3) =>
  completionStage({ transcript: transcript(entries), reviewPassEnabled, maxChecks });

const asked = say(
  "user",
  completionCheckText({ title: "Ship it", body: "Ship the parser fix" }, 1, 3),
);
const reviewAsk = say("user", `${REVIEW_MARKER}\n\nreview it`);

describe("completionStage", () => {
  it("asks first, then waits for the thread's own answer", () => {
    expect(stageOf([say("assistant", "I changed the parser and stopped.")])).toMatchObject({
      kind: "ask",
    });
    expect(stageOf([say("assistant", "done-ish"), asked])).toMatchObject({
      kind: "waiting",
      marker: COMPLETION_MARKER,
    });
  });

  it("sends work back when the agent's answer still lists it", () => {
    const stage = stageOf([
      asked,
      say("assistant", "DONE:\n- parser fix\n\nREMAINING:\n- the tests\n- the docs"),
    ]);
    expect(stage).toMatchObject({ kind: "continue", check: 2 });
    if (stage.kind === "continue") expect(stage.remaining).toEqual(["the tests", "the docs"]);
  });

  it("reads only the answer to the newest ask, so a send-back is another ask", () => {
    const first = [asked, say("assistant", "REMAINING:\n- the tests")];
    const second = [
      say("user", continueText(["the tests"], 2, 3)),
      say("assistant", "DONE:\n- the tests\n\nREMAINING:\n- none"),
    ];
    // The first answer's "REMAINING: the tests" must not survive into the next read.
    expect(stageOf([...first, ...second])).toMatchObject({ kind: "finish" });
  });

  it("finishes on a clean answer", () => {
    expect(
      stageOf([asked, say("assistant", "DONE:\n- all of it\n\nREMAINING:\n- none")]),
    ).toMatchObject({ kind: "finish" });
  });

  it("finishes when the agent bolds its report, rather than asking forever", () => {
    // `**REMAINING:** none` — the closing delimiter used to read as an item.
    expect(
      stageOf([asked, say("assistant", "**DONE:** the parser\n\n**REMAINING:** none")]),
    ).toMatchObject({ kind: "finish" });
  });

  it("asks again instead of handing back an answer with nothing in it", () => {
    const stage = stageOf([asked, say("assistant", "yep, had a look")]);
    expect(stage).toMatchObject({ kind: "ask", check: 2 });
  });

  it("reads an answer split across several messages", () => {
    expect(
      stageOf([
        asked,
        say("assistant", "DONE:\n- the parser"),
        say("assistant", "REMAINING:\n- the migration"),
      ]),
    ).toMatchObject({ kind: "continue" });
  });

  it("hands a thread that stopped to ask to the model instead of the template", () => {
    const stage = stageOf([
      say(
        "assistant",
        "Phase 1 landed: the hotbar reads from the store.\n\nShould phase 2 reuse that store or get its own?",
      ),
    ]);
    expect(stage).toMatchObject({ kind: "asking" });
    if (stage.kind === "asking") expect(stage.question).toContain("reuse that store");
  });

  it("reads a decision fork with no question mark as an ask", () => {
    expect(
      stageOf([say("assistant", "Both work. Let me know which one you want before I keep going.")]),
    ).toMatchObject({ kind: "asking" });
  });

  it("sends the agent's own list back rather than answering a question around it", () => {
    // A closing that names outstanding work is not a fork: its own items are
    // the better next step, so `continue` still wins.
    expect(
      stageOf([
        asked,
        say("assistant", "REMAINING:\n- the tests\n\nShould I also update the docs?"),
      ]),
    ).toMatchObject({ kind: "continue" });
  });

  it("does not read a finished report as an ask", () => {
    // A closing question is only a stop when there is something left to decide.
    expect(
      stageOf([
        asked,
        say("assistant", "Everything is done. Anything else you want in this card?"),
      ]),
    ).toMatchObject({ kind: "finish" });
  });

  it("reads only what the agent said, not what was said to it", () => {
    // A question someone else typed is theirs. Only the closing after it counts.
    expect(
      stageOf([
        say("assistant", "Parser fix is in."),
        say("user", "should this handle the empty case too?"),
        say("assistant", "Yes, added it."),
      ]),
    ).toMatchObject({ kind: "ask", check: 1 });
  });

  it("takes a question in the answer to an ask", () => {
    expect(
      stageOf([asked, say("assistant", "Not yet — do you want the migration in this card?")]),
    ).toMatchObject({ kind: "asking" });
  });

  it("leaves a blocked answer to the model", () => {
    expect(stageOf([asked, say("assistant", "BLOCKED: the API key is missing")])).toMatchObject({
      kind: "blocked",
      reason: "the API key is missing",
    });
  });

  it("stops asking at the cap and hands the card over", () => {
    const stuck = (check: number) => [
      say("user", continueText(["still the tests"], check, 3)),
      say("assistant", "REMAINING:\n- still the tests"),
    ];
    expect(stageOf([asked, ...stuck(2), ...stuck(3)])).toMatchObject({
      kind: "exhausted",
      checks: 3,
    });
    // The cap is a setting: the same thread with room left keeps going.
    expect(stageOf([asked, ...stuck(2), ...stuck(3)], false, 10)).toMatchObject({
      kind: "continue",
      check: 4,
    });
  });

  it("keeps the cap when the early asks have scrolled out of the window", () => {
    // Only the newest ask is visible; its tally is what stops the loop.
    expect(
      stageOf([
        say("user", continueText(["still the tests"], 3, 3)),
        say("assistant", "REMAINING:\n- still the tests"),
      ]),
    ).toMatchObject({ kind: "exhausted", checks: 3 });
  });

  it("runs the review turn between a clean answer and the PR, only when it is on", () => {
    const clean = [asked, say("assistant", "DONE:\n- it\n\nREMAINING:\n- none")];
    expect(stageOf(clean, true)).toMatchObject({ kind: "review" });
    expect(stageOf([...clean, reviewAsk], true)).toMatchObject({ kind: "waiting" });
    expect(
      stageOf(
        [...clean, reviewAsk, say("assistant", "DONE:\n- reviewed\n\nREMAINING:\n- none")],
        true,
      ),
    ).toMatchObject({ kind: "finish" });
  });

  it("sends the card back when the review turns up work", () => {
    const stage = stageOf(
      [
        asked,
        say("assistant", "DONE:\n- it\n\nREMAINING:\n- none"),
        reviewAsk,
        say("assistant", "REMAINING:\n- the null case is unhandled"),
      ],
      true,
    );
    expect(stage).toMatchObject({ kind: "continue" });
  });

  it("counts a refused pull request as another ask, not a retry forever", () => {
    expect(
      stageOf([
        asked,
        say("assistant", "DONE:\n- it\n\nREMAINING:\n- none"),
        say("user", prRefusedText("The worktree has no changes to propose.", 2, 3)),
      ]),
    ).toMatchObject({ kind: "waiting" });
  });

  it("asks the same question every time — no round wording in the turn", () => {
    const text = continueText(["the tests"], 4, 10);
    expect(text).not.toMatch(/round/i);
    expect(text).toContain("(check 4 of 10)");
  });
});

const settings = (patch: Partial<BoardSettings> = {}) =>
  ({
    hermesAutoMovePromptsToActive: false,
    hermesStuckPrepMs: 120_000,
    hermesAutoFinishActive: true,
    hermesAutoMergeWhenGreen: true,
    hermesReviewPassEnabled: false,
    hermesReviewPrompt: "review it",
    hermesBrainMaxNudges: 3,
    hermesCompletionMaxChecks: 10,
    ...patch,
  }) as unknown as BoardSettings;

const activeCard = () =>
  makeFakeCard({ id: "a1", at: "active", threadId: "t1", body: "Ship the parser fix" });

describe("runRulePass — Active completion", () => {
  it("asks a quiet thread whether the goal is done", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [activeCard()],
      transcripts: { t1: transcript([say("assistant", "Changed the parser.")]) },
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions.map((action) => action.rule)).toEqual(["completion-check"]);
    expect(state.nudges[0]?.text).toContain(COMPLETION_MARKER);
    expect(state.nudges[0]?.text).toContain("Ship the parser fix");
    expect(state.cards[0]?.at).toBe("active");
  });

  it("writes nothing to a thread that stopped to ask, and says so", async () => {
    // Its own thread id: the completion counts are process-local, so a thread
    // an earlier test already asked would read as waiting rather than fresh.
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({ id: "a2", at: "active", threadId: "t2", body: "Ship the hotbar" }),
      ],
      transcripts: {
        t2: {
          ...transcript([
            say("assistant", "Phase 1 is in. Should phase 2 reuse that store or get its own?"),
          ]),
          threadId: "t2",
        },
      },
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions).toEqual([]);
    expect(state.nudges).toEqual([]);
    expect(rules.logs.join("\n")).toContain("stopped to ask");
  });

  it("opens the pull request once the thread says the goal is done", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [activeCard()],
      transcripts: {
        t1: transcript([asked, say("assistant", "DONE:\n- the parser\n\nREMAINING:\n- none")]),
      },
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions.map((action) => action.rule)).toEqual(["finish-active"]);
    expect(state.cards[0]?.at).toBe("pr");
  });

  it("does not touch Active at all when auto-finish is off", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [activeCard()],
      transcripts: { t1: transcript([say("assistant", "Changed the parser.")]) },
    });

    const rules = await runRulePass({ api, settings: settings({ hermesAutoFinishActive: false }) });

    expect(rules.actions).toEqual([]);
    expect(state.nudges).toEqual([]);
  });

  it("leaves a running turn alone", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [activeCard()],
      transcripts: {
        t1: { ...transcript([say("assistant", "working")]), turnState: "running" },
      },
    });

    await runRulePass({ api, settings: settings() });

    expect(state.nudges).toEqual([]);
  });

  it("tells the thread why a refused pull request did not open", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [activeCard()],
      transcripts: {
        t1: transcript([asked, say("assistant", "DONE:\n- it\n\nREMAINING:\n- none")]),
      },
      openPrFailures: { a1: "The worktree has no changes to propose." },
    });

    const rules = await runRulePass({ api, settings: settings() });

    expect(rules.actions[0]).toMatchObject({ rule: "finish-active", ok: false });
    expect(state.cards[0]?.at).toBe("active");
    expect(state.nudges[0]?.text).toContain("no changes to propose");
    expect(state.nudges[0]?.text).toContain(COMPLETION_MARKER);
  });
});
