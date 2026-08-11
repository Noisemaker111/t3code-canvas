import { describe, expect, it } from "@effect/vitest";

import { check, component, rule, trigger, type CardHandle } from "./component.ts";
import { dispatch, refuseMove, type RoundLedger } from "./engine.ts";

const said: string[] = [];

function card(partial: Partial<CardHandle> = {}): CardHandle {
  const handle: CardHandle = {
    id: partial.id ?? "c1",
    at: partial.at ?? "active",
    title: partial.title ?? "Ship it",
    body: partial.body ?? "details",
    threadId: partial.threadId ?? null,
    prUrl: partial.prUrl ?? null,
    prepStatus: partial.prepStatus ?? "untouched",
    moveTo: async (to) => void said.push(`moveTo:${to}`),
    sendBack: async (to, message) => void said.push(`sendBack:${to}:${message}`),
    needsHuman: async (reason) => void said.push(`needsHuman:${reason}`),
    startThread: async () => void said.push("startThread"),
    nudge: async (message) => void said.push(`nudge:${message}`),
    openPr: async () => {
      said.push("openPr");
      return null;
    },
    mergePr: async () => {
      said.push("mergePr");
      return null;
    },
    releaseWorktree: async () => void said.push("releaseWorktree"),
    restoreWorktree: async () => void said.push("restoreWorktree"),
  };
  return handle;
}

const arrives = trigger({ name: "a card arrives", on: "enter" });
const leaves = trigger({ name: "a card leaves", on: "exit" });
const always = trigger({ name: "every tick", on: "tick" });

const hasThread = check(
  "needs a thread behind it",
  (c): c is CardHandle => typeof c.threadId === "string" && c.threadId.length > 0,
);

function ledger(): RoundLedger & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    roundsSoFar: (cardId, ruleName) => counts.get(`${cardId}:${ruleName}`) ?? 0,
    countRound: (cardId, ruleName) => {
      const key = `${cardId}:${ruleName}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  };
}

describe("dispatch", () => {
  it("runs the rule whose moment matches and no other", async () => {
    const startThread = rule({
      name: "start a coding thread",
      when: arrives,
      do: (c) => c.startThread(),
    });
    const release = rule({
      name: "release the worktree",
      when: leaves,
      do: (c) => c.releaseWorktree(),
    });
    const active = component({ title: "Active", rules: [startThread, release] });

    said.length = 0;
    const result = await dispatch({ card: card(), component: active, moment: "enter" });

    expect(result.fired).toBe("start a coding thread");
    expect(said).toEqual(["startThread"]);
  });

  it("stops at the first match — order is the component's", async () => {
    const first = rule({ name: "first", when: always, do: (c) => c.moveTo("one") });
    const second = rule({ name: "second", when: always, do: (c) => c.moveTo("two") });
    const both = component({ title: "Both", rules: [first, second] });

    said.length = 0;
    const result = await dispatch({ card: card(), component: both, moment: "tick" });

    expect(result.fired).toBe("first");
    expect(said).toEqual(["moveTo:one"]);
  });

  it("skips a rule whose `if` does not hold, and runs the next", async () => {
    const needsThread = rule({
      name: "needs a thread",
      when: always,
      if: hasThread,
      do: (c) => c.openPr(),
    });
    const fallback = rule({ name: "fallback", when: always, do: (c) => c.moveTo("prompts") });
    const both = component({ title: "Both", rules: [needsThread, fallback] });

    said.length = 0;
    const result = await dispatch({
      card: card({ threadId: null }),
      component: both,
      moment: "tick",
    });

    expect(result.fired).toBe("fallback");
    expect(said).toEqual(["moveTo:prompts"]);
  });

  it("skips a rule whose `unless` holds", async () => {
    const openIt = rule({
      name: "open it",
      when: arrives,
      unless: hasThread,
      do: (c) => c.openPr(),
    });
    const pr = component({ title: "PR", rules: [openIt] });

    said.length = 0;
    const result = await dispatch({
      card: card({ threadId: "t1" }),
      component: pr,
      moment: "enter",
    });

    expect(result.fired).toBeNull();
    expect(said).toEqual([]);
  });

  it("hands a trigger's payload to the rule", async () => {
    const checksRed = trigger<{ failing: string[] }>({
      name: "PR checks go red",
      on: "tick",
      detect: () => ({ failing: ["build", "lint"] }),
    });
    const fix = rule({
      name: "send red CI back",
      when: checksRed,
      do: (c, checks) => c.sendBack("active", checks.failing.join(", ")),
    });
    const pr = component({ title: "PR", rules: [fix] });

    said.length = 0;
    await dispatch({ card: card(), component: pr, moment: "tick" });

    expect(said).toEqual(["sendBack:active:build, lint"]);
  });

  it("treats a null detection as a miss and an undefined payload as a fire", async () => {
    const quiet = trigger<{ n: number }>({ name: "quiet", on: "tick", detect: () => null });
    const skipped = rule({ name: "skipped", when: quiet, do: (c) => c.openPr() });
    const lifecycle = rule({ name: "lifecycle", when: always, do: (c) => c.mergePr() });
    const both = component({ title: "Both", rules: [skipped, lifecycle] });

    said.length = 0;
    const result = await dispatch({ card: card(), component: both, moment: "tick" });

    expect(result.fired).toBe("lifecycle");
    expect(said).toEqual(["mergePr"]);
  });

  describe("giveUpAfter", () => {
    it("counts a round each time the rule fires", async () => {
      const bounce = rule({
        name: "send it back",
        when: always,
        giveUpAfter: 3,
        do: (c) => c.sendBack("active", "again"),
      });
      const pr = component({ title: "PR", rules: [bounce] });
      const rounds = ledger();

      said.length = 0;
      await dispatch({ card: card(), component: pr, moment: "tick", rounds });
      await dispatch({ card: card(), component: pr, moment: "tick", rounds });

      expect(rounds.counts.get("c1:send it back")).toBe(2);
      expect(said).toEqual(["sendBack:active:again", "sendBack:active:again"]);
    });

    it("files the card as a human's once the budget is spent", async () => {
      const bounce = rule({
        name: "send it back",
        when: always,
        giveUpAfter: 2,
        do: (c) => c.sendBack("active", "again"),
      });
      const pr = component({ title: "PR", rules: [bounce] });
      const rounds = ledger();

      said.length = 0;
      await dispatch({ card: card(), component: pr, moment: "tick", rounds });
      await dispatch({ card: card(), component: pr, moment: "tick", rounds });
      const third = await dispatch({ card: card(), component: pr, moment: "tick", rounds });

      expect(third.gaveUp).toBe(true);
      expect(said.at(-1)).toBe("needsHuman:send it back — gave up after 2");
    });

    it("leaves a rule with no budget alone", async () => {
      const forever = rule({ name: "forever", when: always, do: (c) => c.nudge("keep going") });
      const active = component({ title: "Active", rules: [forever] });
      const rounds = ledger();

      for (let n = 0; n < 5; n += 1) {
        await dispatch({ card: card(), component: active, moment: "tick", rounds });
      }
      expect(rounds.counts.size).toBe(0);
    });
  });

  it("does nothing for a component with no rules", async () => {
    const view = component({ title: "Running", contains: () => true });
    const result = await dispatch({ card: card(), component: view, moment: "tick" });
    expect(result.fired).toBeNull();
  });
});

describe("refuseMove", () => {
  const pr = component({ title: "PR", accepts: hasThread });

  it("reads the refusal off the check's own name", () => {
    expect(refuseMove({ card: card({ threadId: null }), target: pr, targetId: "pr" })).toBe(
      "PR needs a thread behind it.",
    );
  });

  it("lets a card the check accepts through", () => {
    expect(refuseMove({ card: card({ threadId: "t1" }), target: pr, targetId: "pr" })).toBeNull();
  });

  it("refuses a move onto the column the card is already in", () => {
    const active = component({ title: "Active" });
    expect(
      refuseMove({ card: card({ at: "active" }), target: active, targetId: "active" }),
    ).toMatch(/already/i);
  });

  // A column somebody added is a place to put cards until they give it rules.
  it("takes anything when the component states no `accepts`", () => {
    const research = component({ title: "Research" });
    expect(
      refuseMove({ card: card({ threadId: null }), target: research, targetId: "research" }),
    ).toBeNull();
  });
});
