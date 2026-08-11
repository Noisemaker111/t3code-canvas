import { describe, expect, it } from "@effect/vitest";

import {
  describeBoardTurn,
  describeHermesTurn,
  hermesChatTurns,
  hermesRuleChatTurn,
} from "./chatFeed.ts";

const at = "2026-01-01T00:00:00.000Z";

const delta = [
  "## BOARD CHANGES (since your last turn)",
  "- changed: c1 fix login (draft)",
  "- appeared: c2 ship docs (prompts)",
  "",
  "## NEEDS A DECISION",
  "- [structure] c1 — draft has no mission",
  "",
  "## CANVAS MESSAGES",
  "- from human: what are you doing",
].join("\n");

describe("describeBoardTurn", () => {
  it("counts what the turn carried", () => {
    expect(describeBoardTurn(delta)).toBe("2 board changes · 1 decision · 1 message");
  });

  it("calls a block with no change section what it is", () => {
    expect(describeBoardTurn("## NEEDS A DECISION\n- [launch] c1 — prompt is ready")).toBe(
      "full board snapshot · 1 decision",
    );
  });

  it("says so when a delta carried nothing", () => {
    expect(describeBoardTurn("## BOARD CHANGES (since your last turn)\n(no card changes)")).toBe(
      "nothing changed",
    );
  });
});

describe("describeHermesTurn", () => {
  it("prefers the model's own note", () => {
    expect(
      describeHermesTurn({
        note: "structured c1 and sent it to prompts",
        calls: [{ method: "updateCard", args: { id: "c1" } }],
        error: null,
      }),
    ).toBe("structured c1 and sent it to prompts");
  });

  it("counts writes when the model left no note", () => {
    expect(
      describeHermesTurn({
        note: null,
        calls: [
          { method: "updateCard", args: { id: "c1" } },
          { method: "listCards", args: {} },
          { method: "mergePr", args: { id: "c2" }, error: "not mergeable" },
        ],
        error: null,
      }),
    ).toBe("1 action · 1 call failed");
  });

  it("leads with the failure when the tick failed", () => {
    expect(describeHermesTurn({ note: "ignored", calls: [], error: "no tier answered" })).toBe(
      "failed: no tier answered",
    );
  });

  it("a refused merge counts as a failed call, not an action", () => {
    expect(
      describeHermesTurn({
        note: null,
        calls: [
          {
            method: "mergePr",
            args: { id: "c1" },
            result: { merged: false, reason: "not mergeable" },
          },
        ],
        error: null,
      }),
    ).toBe("0 actions · 1 call failed");
  });
});

describe("hermesChatTurns", () => {
  it("writes the turn Hermes got and the answer it acted on", () => {
    const turns = hermesChatTurns({
      at,
      tickId: "tick-4",
      tier: "openrouter",
      delta,
      note: "sent c1 to prompts",
      program: "await board.updateCard({ id: 'c1' })",
      calls: [{ method: "updateCard", args: { id: "c1" } }],
      logs: ["moved 1 card"],
      error: null,
    });

    expect(turns.map((turn) => turn.kind)).toEqual(["board", "hermes"]);
    expect(turns[0]?.text).toBe(delta);
    expect(turns[1]?.summary).toBe("sent c1 to prompts");
    expect(turns[1]?.text).toContain('- updateCard {"id":"c1"} → ok');
    expect(turns[1]?.text).toContain("note: moved 1 card");
    expect(turns[1]?.tier).toBe("openrouter");
  });

  it("keeps a failed tick, which is the one worth reading", () => {
    const turns = hermesChatTurns({
      at,
      tickId: "tick-5",
      tier: null,
      delta: null,
      note: null,
      program: null,
      calls: [],
      logs: [],
      error: "every tier refused",
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.error).toBe("every tier refused");
  });

  it("says nothing when a tick neither read a block nor ran a call", () => {
    expect(
      hermesChatTurns({
        at,
        tickId: "tick-6",
        tier: null,
        delta: null,
        note: null,
        program: null,
        calls: [{ method: "updateCard", args: { id: "c1" }, skipped: true }],
        logs: [],
        error: null,
      }),
    ).toEqual([]);
  });
});

describe("hermesChatTurns replies", () => {
  it("lands a reply in the feed at full length", () => {
    const answer =
      `I routed it to vps-code because ${"the path matched deploy/apply.sh. ".repeat(40)}`.trim();
    const turns = hermesChatTurns({
      at,
      tickId: "tick-9",
      tier: "grok",
      delta: null,
      note: null,
      replies: [answer],
      program: "await board.reply({ text: 'x' })",
      calls: [{ method: "reply", args: { text: answer } }],
      logs: [],
      error: null,
    });

    const reply = turns.find((turn) => turn.kind === "reply");
    expect(reply?.summary).toBe(answer);
    expect(reply?.summary.length).toBeGreaterThan(1_000);
  });

  it("keeps a tick that only answered, since the answer is the whole point", () => {
    const turns = hermesChatTurns({
      at,
      tickId: "tick-10",
      tier: "grok",
      delta: null,
      note: null,
      replies: ["  nothing is running right now.  "],
      program: null,
      calls: [],
      logs: [],
      error: null,
    });

    expect(turns.map((turn) => turn.kind)).toEqual(["hermes", "reply"]);
    expect(turns[1]?.summary).toBe("nothing is running right now.");
  });
});

describe("hermesRuleChatTurn", () => {
  it("logs a rules-only tick that moved something", () => {
    const turns = hermesRuleChatTurn({
      at,
      tickId: "tick-7",
      calls: [{ method: "updateCard", args: { id: "c1", at: "prompts" } }],
      logs: [],
      actions: 1,
    });
    expect(turns[0]?.summary).toBe("1 rule action · no model needed");
  });

  it("stays quiet when the rules did nothing", () => {
    expect(hermesRuleChatTurn({ at, tickId: "tick-8", calls: [], logs: [], actions: 0 })).toEqual(
      [],
    );
  });
});
