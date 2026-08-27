import { describe, expect, it } from "@effect/vitest";
import type { BoardRuleRow } from "@t3tools/contracts";
import { DEFAULT_BOARD_SETTINGS } from "@t3tools/contracts";

import {
  ACTION_LABELS,
  defaultRules,
  RULE_ID_BY_ROW,
  TRIGGER_LABELS,
  boardRulePolicy,
  cardRendererFor,
  ruleEnabled,
  ruleTarget,
  rulesFor,
  rulesPatch,
  effectiveRules,
  hermesPipelinePatch,
  ruleIdForRow,
  unsupportedRuleRows,
  isKnownRule,
  resolveArrival,
  sanitizeRules,
} from "./boardRules.ts";

const withRules = (
  rules: Record<string, ReadonlyArray<{ when: string; then: string; arg: string }>>,
) => ({
  rules: rules,
});

describe("rules", () => {
  it("runs the built-in defaults when nothing is stored", () => {
    expect(rulesFor(withRules({}), "active")).toEqual(defaultRules("active"));
  });

  it("a stored entry replaces the defaults wholesale, even empty", () => {
    expect(rulesFor(withRules({ active: [] }), "active")).toEqual([]);
  });
});

describe("resolveArrival", () => {
  it("expresses exactly what the board always did", () => {
    expect(resolveArrival(withRules({}), "prompts")).toEqual({ kind: "move", at: "prompts" });
    expect(resolveArrival(withRules({}), "active")).toEqual({
      kind: "startThread",
      at: "active",
    });
    expect(resolveArrival(withRules({}), "pr")).toEqual({ kind: "openPr", at: "pr" });
    expect(resolveArrival(withRules({}), "done")).toEqual({ kind: "mergePr", at: "done" });
  });

  it("a rewired column stops launching", () => {
    expect(
      resolveArrival(
        withRules({ active: [{ when: "cardArrives", then: "moveHere", arg: "" }] }),
        "active",
      ),
    ).toEqual({ kind: "move", at: "active" });
  });

  it("follows a moveTo redirect into the target's own rule", () => {
    expect(
      resolveArrival(
        withRules({ prompts: [{ when: "cardArrives", then: "moveTo", arg: "active" }] }),
        "prompts",
      ),
    ).toEqual({ kind: "startThread", at: "active" });
  });

  it("degrades a redirect cycle to a plain move instead of looping", () => {
    expect(
      resolveArrival(
        withRules({
          prompts: [{ when: "cardArrives", then: "moveTo", arg: "pr" }],
          pr: [{ when: "cardArrives", then: "moveTo", arg: "prompts" }],
        }),
        "prompts",
      ),
    ).toEqual({ kind: "move", at: "pr" });
  });

  it("skips a rule verb this build does not know", () => {
    expect(
      resolveArrival(
        withRules({ done: [{ when: "cardArrives", then: "summonHermes", arg: "" }] }),
        "done",
      ),
    ).toEqual({ kind: "move", at: "done" });
  });

  it("adopts a card that already has a PR and no thread: openPr degrades to a move", () => {
    expect(
      resolveArrival(withRules({}), "pr", { prUrl: "https://x/pr/1", threadId: null }),
    ).toEqual({ kind: "move", at: "pr" });
  });

  it("a card with a thread keeps openPr — arriving pushes the thread's work", () => {
    expect(
      resolveArrival(withRules({}), "pr", { prUrl: "https://x/pr/1", threadId: "t-1" }),
    ).toEqual({ kind: "openPr", at: "pr" });
    expect(resolveArrival(withRules({}), "pr", { prUrl: null, threadId: "t-1" })).toEqual({
      kind: "openPr",
      at: "pr",
    });
  });

  it("a display row is presentation, so it never answers the drop", () => {
    expect(
      resolveArrival(
        withRules({
          active: [
            { when: "cardArrives", then: "display", arg: "compact" },
            { when: "cardArrives", then: "startThread", arg: "" },
          ],
        }),
        "active",
      ),
    ).toEqual({ kind: "startThread", at: "active" });
  });
});

describe("cardRendererFor", () => {
  it("a column with no display row draws the board tile", () => {
    expect(cardRendererFor(withRules({}), "active")).toBe("default");
    expect(cardRendererFor(withRules({ pr: [] }), "pr")).toBe("default");
  });

  it("reads the face off the column's own display row", () => {
    const settings = withRules({
      pr: [
        { when: "cardArrives", then: "openPr", arg: "" },
        { when: "cardArrives", then: "display", arg: "compact" },
      ],
      done: [{ when: "cardArrives", then: "display", arg: "detailed" }],
    });
    expect(cardRendererFor(settings, "pr")).toBe("compact");
    expect(cardRendererFor(settings, "done")).toBe("detailed");
    expect(cardRendererFor(settings, "active")).toBe("default");
  });

  // Whether this build has the face is the registry's question, asked where the
  // faces are. Here the row is simply read back as written — a name this build
  // does not know is still the name the row asked for, and it survives a save.
  it("reads back a face this build does not have", () => {
    expect(
      cardRendererFor(
        withRules({ done: [{ when: "cardArrives", then: "display", arg: "hologram" }] }),
        "done",
      ),
    ).toBe("hologram");
  });
});

describe("rulesPatch", () => {
  it("writes the rows and nothing else — the flags are read, never written", () => {
    const patch = rulesPatch(DEFAULT_BOARD_SETTINGS, "active", [
      { when: "cardArrives", then: "startThread", arg: "" },
    ]);
    expect(Object.keys(patch)).toEqual(["rules"]);
    expect(patch.rules?.active).toEqual([{ when: "cardArrives", then: "startThread", arg: "" }]);
  });

  it("editing one column leaves the others alone", () => {
    const patch = rulesPatch(DEFAULT_BOARD_SETTINGS, "done", []);
    expect(patch.rules?.done).toEqual([]);
  });

  it("dropping the Hermes rows really turns those policies off", () => {
    const patch = rulesPatch(DEFAULT_BOARD_SETTINGS, "prompts", [
      { when: "cardArrives", then: "moveHere", arg: "" },
      { when: "hermesNextBestTime", then: "moveHere", arg: "" },
      { when: "skillsApplied", then: "moveHere", arg: "" },
    ]);
    const policy = boardRulePolicy({ ...DEFAULT_BOARD_SETTINGS, ...patch });
    expect(policy.structureDrafts).toBe(false);
    expect(policy.launchPrompts).toBe(false);
  });
});

describe("sanitizeRules", () => {
  it("keeps unknown verbs but drops malformed rows", () => {
    const out = sanitizeRules({
      active: [
        { when: "cardArrives", then: "summonHermes" },
        { when: "", then: "moveHere" },
        { nonsense: true },
      ],
      "": [{ when: "a", then: "b" }],
      pr: "not-an-array",
    });
    expect(out).toEqual({ active: [{ when: "cardArrives", then: "summonHermes", arg: "" }] });
    expect(isKnownRule(out.active![0]!)).toBe(false);
  });
});

describe("ruleEnabled", () => {
  const on = (rules: Record<string, ReadonlyArray<BoardRuleRow>>, legacy: boolean) =>
    ruleEnabled({
      settings: { rules },
      at: "pr",
      when: "checksGreen",
      then: "mergePr",
      legacy,
    });

  it("a column that was never saved answers from the flag it was dual-written to", () => {
    expect(on({}, true)).toBe(true);
    expect(on({}, false)).toBe(false);
  });

  it("a stored row wins over the flag, in both directions", () => {
    expect(on({ pr: [{ when: "checksGreen", then: "mergePr", arg: "" }] }, false)).toBe(true);
    expect(on({ pr: [{ when: "checksGreen", then: "moveHere", arg: "" }] }, true)).toBe(false);
  });

  it("a stored set that never mentions the trigger predates it, so the flag answers", () => {
    expect(on({ pr: [{ when: "cardArrives", then: "openPr", arg: "" }] }, true)).toBe(true);
  });
});

describe("boardRulePolicy", () => {
  it("keeps conflict recovery on for a pr column saved before the trigger existed", () => {
    const policy = boardRulePolicy({
      ...DEFAULT_BOARD_SETTINGS,
      rules: { pr: [{ when: "checksGreen", then: "mergePr", arg: "" }] },
    });
    expect(policy.conflictReturn).toBe(true);
    expect(policy.mergeWhenGreen).toBe(true);
  });

  it("honours a deleted conflict row", () => {
    const policy = boardRulePolicy({
      ...DEFAULT_BOARD_SETTINGS,
      rules: { pr: [{ when: "prConflict", then: "moveHere", arg: "" }] },
    });
    expect(policy.conflictReturn).toBe(false);
  });
});

describe("ruleTarget", () => {
  it("reads the row's own column, defaulting to what the board always did", () => {
    expect(ruleTarget({ rules: {} }, "pr", "prConflict")).toBe("active");
    expect(
      ruleTarget(
        { rules: { pr: [{ when: "prConflict", then: "moveTo", arg: "prompts" }] } },
        "pr",
        "prConflict",
      ),
    ).toBe("prompts");
    expect(ruleTarget({ rules: { pr: [] } }, "pr", "prConflict")).toBeNull();
  });
});

describe("unsupportedRuleRows", () => {
  it("names a row with a known trigger the pass cannot run", () => {
    const rows = unsupportedRuleRows(
      { rules: { active: [{ when: "cardStalled", then: "mergePr", arg: "" }] } },
      "active",
      "cardStalled",
      ["moveTo"],
    );
    expect(rows.map((rule) => rule.then)).toEqual(["mergePr"]);
  });
});

describe("hermesPipelinePatch", () => {
  it("writes the row and nothing else — no flag rides along", () => {
    const patch = hermesPipelinePatch(DEFAULT_BOARD_SETTINGS, "mergeWhenGreen", false);
    expect(Object.keys(patch)).toEqual(["rules"]);
    expect(patch.rules?.pr).toEqual(
      defaultRules("pr").filter((rule) => rule.when !== "checksGreen"),
    );
  });

  it("turning a policy back on restores its row exactly once", () => {
    const off = {
      ...DEFAULT_BOARD_SETTINGS,
      ...hermesPipelinePatch(DEFAULT_BOARD_SETTINGS, "mergeWhenGreen", false),
    };
    const patch = hermesPipelinePatch(off, "mergeWhenGreen", true);
    expect(
      patch.rules?.pr?.filter((rule) => rule.when === "checksGreen" && rule.then === "mergePr"),
    ).toHaveLength(1);
    expect(
      boardRulePolicy({ ...off, ...patch } as typeof DEFAULT_BOARD_SETTINGS).mergeWhenGreen,
    ).toBe(true);
  });

  it("turning a policy off removes its row", () => {
    const patch = hermesPipelinePatch(DEFAULT_BOARD_SETTINGS, "launchPrompts", false);
    expect(
      patch.rules?.prompts?.some((rule) => rule.when === "skillsApplied" && rule.then === "moveTo"),
    ).toBe(false);
  });

  it("does not switch a policy back on while turning another one off", () => {
    const settings = { ...DEFAULT_BOARD_SETTINGS, hermesAutoMovePromptsToActive: false };
    const patch = hermesPipelinePatch(settings, "structureDrafts", false);
    expect(
      boardRulePolicy({ ...settings, ...patch } as typeof DEFAULT_BOARD_SETTINGS).launchPrompts,
    ).toBe(false);
  });
});

describe("effectiveRules", () => {
  it("drops the default row a legacy flag says is off", () => {
    expect(
      effectiveRules(
        { ...DEFAULT_BOARD_SETTINGS, hermesAutoMovePromptsToActive: false },
        "prompts",
      ).map((rule) => rule.when),
    ).toEqual(["cardArrives", "hermesNextBestTime"]);
  });
});

describe("ruleIdForRow", () => {
  it("maps each Hermes-run row onto the rule id the tick log uses", () => {
    expect(ruleIdForRow({ when: "checksGreen", then: "mergePr", arg: "" })).toBe("mergeable-pr");
    expect(ruleIdForRow({ when: "prConflict", then: "moveTo", arg: "active" })).toBe(
      "pr-conflicts",
    );
    expect(ruleIdForRow({ when: "cardStalled", then: "moveTo", arg: "pr" })).toBe("card-stalled");
    expect(ruleIdForRow({ when: "cardArrives", then: "moveHere", arg: "" })).toBeNull();
  });
});
