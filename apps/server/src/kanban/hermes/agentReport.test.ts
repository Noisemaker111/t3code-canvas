import { describe, expect, it } from "@effect/vitest";

import { closingQuestion, parseAgentReport } from "./agentReport.ts";
import { withAgentContract } from "./agentContract.ts";

describe("parseAgentReport", () => {
  it("parses the contract shape", () => {
    const report = parseAgentReport(
      [
        "```",
        "DONE:",
        "- Added apps/server/src/kanban/hermes/tick.ts",
        "- Wired the route in apps/server/src/http.ts",
        "REMAINING:",
        "- Tests for the merge-conflict retry",
        "```",
      ].join("\n"),
    );

    expect(report.done).toHaveLength(2);
    expect(report.remaining).toEqual(["Tests for the merge-conflict retry"]);
    expect(report.complete).toBe(false);
  });

  it("treats 'none' as nothing remaining", () => {
    const report = parseAgentReport("DONE:\n- shipped it\nREMAINING:\n- none");

    expect(report.remaining).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("reads 'none' through the bold the agent wrapped it in", () => {
    for (const raw of [
      "**DONE:** the parser\n\n**REMAINING:** none",
      "DONE: the parser\nREMAINING: **none**",
      "**REMAINING:**\n- *none*",
    ]) {
      const report = parseAgentReport(raw);
      expect(report.remaining).toEqual([]);
      expect(report.complete).toBe(true);
    }
  });

  it("keeps a bolded remaining item, delimiters gone", () => {
    const report = parseAgentReport("**REMAINING:** **the migration for user_settings.ts**");

    expect(report.remaining).toEqual(["the migration for user_settings.ts"]);
    expect(report.complete).toBe(false);
  });

  it("handles markdown headings instead of the fence", () => {
    const report = parseAgentReport(
      ["## What I did", "- refactored the parser", "## Still to do", "* wire the panel"].join("\n"),
    );

    expect(report.remaining).toEqual(["wire the panel"]);
    expect(report.complete).toBe(false);
  });

  it("handles inline colon phrasing on one line", () => {
    const report = parseAgentReport(
      "Done: fixed the toast timer.\nRemaining: nothing, the card is finished.",
    );

    expect(report.done).toEqual(["fixed the toast timer."]);
    expect(report.remaining).toEqual(["nothing, the card is finished."]);
  });

  it("picks up a blocker", () => {
    const report = parseAgentReport(
      "DONE:\n- nothing yet\nBLOCKED:\n- needs the OPENROUTER key to be set on the box",
    );

    expect(report.blocked).toMatch(/OPENROUTER key/);
    expect(report.complete).toBe(false);
  });

  it("reads a prose closer with no sections at all", () => {
    const report = parseAgentReport(
      "I refactored the launcher and everything is done — nothing else is left.",
    );

    expect(report.complete).toBe(true);
  });

  it("does not call an unstructured ramble complete", () => {
    const report = parseAgentReport("I poked around at the launcher a bit and then stopped.");

    expect(report.complete).toBe(false);
  });

  it("handles an empty or missing report", () => {
    expect(parseAgentReport(null).complete).toBe(false);
    expect(parseAgentReport("   ").remaining).toEqual([]);
  });

  it("treats 'none' with a qualifier or aside as nothing remaining", () => {
    for (const line of [
      "- none for this task. (Note: apps/web has pre-existing, unrelated typecheck errors independent of this work.)",
      "- none. (PR not opened: kanban_open_pr is not available in this session; the board owns that step.)",
      "- none for now",
      "- nothing left at this point.",
    ]) {
      const report = parseAgentReport(`DONE:\n- shipped it\nREMAINING:\n${line}`);
      expect(report.remaining, line).toEqual([]);
      expect(report.complete, line).toBe(true);
    }
  });

  it("keeps a real remaining item that merely starts with a negation", () => {
    const report = parseAgentReport(
      "DONE:\n- shipped it\nREMAINING:\n- none of the tests pass on web yet",
    );

    expect(report.remaining).toEqual(["none of the tests pass on web yet"]);
    expect(report.complete).toBe(false);
  });

  it("survives numbered lists and bold headings", () => {
    const report = parseAgentReport(
      ["**Done**", "1. wrote the executor", "**Next steps**", "2) hook up the panel"].join("\n"),
    );

    expect(report.done).toEqual(["wrote the executor"]);
    expect(report.remaining).toEqual(["hook up the panel"]);
  });
});

describe("closingQuestion", () => {
  it("takes the question a closing ends on", () => {
    expect(
      closingQuestion("Phase 1 is in.\n\nShould phase 2 reuse that store or get its own?"),
    ).toBe("Should phase 2 reuse that store or get its own?");
  });

  it("takes a decision fork with no question mark", () => {
    expect(closingQuestion("Both work. Let me know which one you want.")).toContain("Let me know");
  });

  it("reads the whole closing, however long, not a window at the end of it", () => {
    // An agent's last word is a page. A fork stated up front and then argued
    // for twenty lines is still the fork it stopped on.
    const closing = [
      "Phase 1 is in. Before phase 2: should the hotbar reuse the inventory store, or get its own?",
      ...Array.from({ length: 20 }, (_, index) => `- considered option ${index}`),
      "Either works. I have not touched phase 2.",
    ].join("\n");

    expect(closingQuestion(closing)).toContain("reuse the inventory store");
  });

  it("says nothing about a plain closing", () => {
    expect(closingQuestion("Changed the parser and stopped.")).toBeNull();
    expect(closingQuestion("")).toBeNull();
    expect(closingQuestion(null)).toBeNull();
  });

  it("clips the label, because the message is carried elsewhere in full", () => {
    const label = closingQuestion(`Should we ${"x".repeat(400)}?`);
    expect(label?.length).toBeLessThanOrEqual(201);
    expect(label?.endsWith("…")).toBe(true);
  });
});

describe("withAgentContract", () => {
  it("appends the contract once", () => {
    const once = withAgentContract("Do the thing.");
    expect(once).toContain("Don't branch, commit, push, or open a pull request");
    expect(withAgentContract(once)).toBe(once);
  });

  it("does not stack a second copy on a thread launched under an older heading", () => {
    const old = "Mission: fix the toast\n\n---\n\n## Working with the board\n\nDo not branch.";
    expect(withAgentContract(old)).toBe(old);
  });

  it("keeps the original prompt intact", () => {
    expect(withAgentContract("Mission: fix the toast")).toMatch(/^Mission: fix the toast/);
  });

  it("asks for the closing content the loop branches on, without pinning a format", () => {
    const contract = withAgentContract("Do the thing.");
    // What is left drives continue-active; a question falls through to the
    // model. An agent that writes neither costs a turn.
    expect(contract).toContain("what is left");
    expect(contract).toContain("anything\nyou need me to decide");
    expect(contract).toContain("Asking\nis fine");
    // A template is what breaks in long contexts — asking for content is not one.
    expect(contract).toContain("No format required");
    expect(contract).not.toMatch(/\b(DONE|REMAINING|BLOCKED):/);
  });

  it("talks to the agent as a colleague, not about the machinery around it", () => {
    const contract = withAgentContract("Do the thing.");
    // A thread cannot act on any of this, and it ships on every launch.
    expect(contract).not.toMatch(/\bthe board\b/i);
    expect(contract).not.toMatch(/\b(card|column|kanban loop|pull request is opened)\b/i);
  });

  it("stays short enough not to swamp a one-line task", () => {
    // It shipped at 1817 chars, six times the body of a short card.
    expect(withAgentContract("").trim().length).toBeLessThan(900);
  });

  it("points at the repo's own commands rather than naming any", () => {
    const contract = withAgentContract("Do the thing.");
    expect(contract).toContain("Before you change code");
    expect(contract).toContain("`package.json` scripts first");
    // Naming a command here would ship one repo's gate to every project.
    expect(contract).not.toMatch(/\b(pnpm|npm|yarn|bun) (run |test|exec)/);
  });
});
