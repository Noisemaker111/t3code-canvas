import { describe, expect, it } from "@effect/vitest";
import type { BoardSettings } from "@t3tools/contracts";

import { boardComponentIds, componentFor, describeComponents } from "./seed.ts";

const settings = {
  hermesStuckPrepMs: 120_000,
  hermesBrainMaxNudges: 3,
  hermesCompletionMaxChecks: 10,
  hermesPrCheckGraceMs: 600_000,
  hermesReviewPassEnabled: false,
  hermesReviewPrompt: "review it",
} as unknown as BoardSettings;

const deps = (over: Partial<Parameters<typeof componentFor>[1]["policy"]> = {}) => ({
  settings,
  policy: { finishActive: true, mergeWhenGreen: true, conflictReturn: true, ...over },
});

describe("boardComponentIds", () => {
  it("reads the ids off the cards, seeds first", () => {
    expect(boardComponentIds([{ at: "research" }, { at: "active" }, { at: "research" }])).toEqual([
      "prompts",
      "active",
      "pr",
      "done",
      "research",
    ]);
  });

  it("is the seeds alone on an empty board", () => {
    expect(boardComponentIds([])).toEqual(["prompts", "active", "pr", "done"]);
  });
});

describe("componentFor", () => {
  it("gives a component nobody has written rules for a title and nothing else", () => {
    const research = componentFor("research", deps());
    expect(research.title).toBe("research");
    expect(research.rules).toEqual([]);
    // No `accepts`, so it takes anything — a place to put cards until it has rules.
    expect(research.accepts).toBeUndefined();
  });

  it("leaves the merge rule in the list when merging is off, so it can say so", () => {
    const names = (componentFor("pr", deps({ mergeWhenGreen: false })).rules ?? []).map(
      (entry) => entry.name,
    );
    expect(names).toContain("checks green → merge, then Archived");
  });

  it("drops the completion rules when the board has switched finishing off", () => {
    const names = (kind: boolean) =>
      (componentFor("active", deps({ finishActive: kind })).rules ?? []).map((entry) => entry.name);
    expect(names(true)).toContain("the goal is done → the pull request opens");
    expect(names(false)).not.toContain("the goal is done → the pull request opens");
    // Arrival and departure are not the completion pass and stay either way.
    expect(names(false)).toContain("a card arrives → a coding thread starts");
    expect(names(false)).toContain("a card leaves → its workspace is released");
  });

  it("puts the worktree reap in Active's list, where it can be read", () => {
    const names = (componentFor("active", deps()).rules ?? []).map((entry) => entry.name);
    expect(names).toContain("a card leaves → its workspace is released");
    expect(names).toContain("a card coming back gets its workspace again");
  });

  // No seed component ships a cardStalled row, so it is absent until somebody writes one.
  it("adds the stalled rule only when the component's own rows carry it", () => {
    const bare = (componentFor("pr", deps()).rules ?? []).map((entry) => entry.id);
    expect(bare).not.toContain("card-stalled");

    const withRow = componentFor("pr", {
      ...deps(),
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "prompts" }] },
      } as unknown as BoardSettings,
    });
    expect((withRow.rules ?? []).map((entry) => entry.id)).toContain("card-stalled");
  });

  it("ignores a stalled row pointing back at the component it is on", () => {
    const looping = componentFor("pr", {
      ...deps(),
      settings: {
        ...settings,
        rules: { pr: [{ when: "cardStalled", then: "moveTo", arg: "pr" }] },
      } as unknown as BoardSettings,
    });
    expect((looping.rules ?? []).map((entry) => entry.id)).not.toContain("card-stalled");
  });
});

describe("describeComponents", () => {
  it("says what each component does, one line per rule", () => {
    const lines = describeComponents(["active"], deps());
    expect(lines[0]).toBe("- Active (active)");
    expect(lines).toContain("  - card with no coding thread behind it → requeued to Prompts");
    expect(lines).toContain("  - the goal is done → the pull request opens");
  });

  // The prose this replaced described the shipped pipeline, so a column
  // somebody added did not appear in Hermes's world at all.
  it("includes a component somebody added", () => {
    expect(describeComponents(["research"], deps())).toEqual([
      "- research (research) — holds cards; no rules run here",
    ]);
  });

  // The prose also said PRs had been merged whether or not this board merges.
  it("stops naming a rule the board has switched off", () => {
    const on = describeComponents(["active"], deps());
    const off = describeComponents(["active"], deps({ finishActive: false }));
    expect(on).toContain("  - the goal is done → the pull request opens");
    expect(off).not.toContain("  - the goal is done → the pull request opens");
  });
});
