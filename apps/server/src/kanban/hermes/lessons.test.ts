// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AGENT_REPORT_CONTRACT, withAgentContract } from "./agentContract.ts";
import { buildHermesSystemPrompt } from "./prompt.ts";
import {
  activeLessons,
  bindKnowledgeLog,
  lessonsForProject,
  listLessons as listLessonsForTest,
  recordLesson,
  unbindKnowledgeLog,
  type Lesson,
} from "./knowledgeStore.ts";
import {
  formatKnowledgeBlock,
  formatLaunchLessons,
  learnFromCorrection,
  learnFromTickNudges,
} from "./lessons.ts";

const withTempBase = <A>(use: () => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lessons-"));
  try {
    bindKnowledgeLog(baseDir);
    return use();
  } finally {
    unbindKnowledgeLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: "p:0000",
  projectId: "p",
  topic: "theming",
  lesson: "Theme tokens live in tokens.css — never hardcode a hex value.",
  evidence: null,
  source: "user",
  learnedCount: 1,
  taughtCount: 0,
  cardIds: [],
  status: "active",
  retiredReason: null,
  firstLearnedAt: "2026-01-01T00:00:00.000Z",
  lastLearnedAt: "2026-01-01T00:00:00.000Z",
  lastTaughtAt: null,
  ...over,
});

describe("launch lessons", () => {
  it("states the facts and nothing about where they came from", () => {
    const block = formatLaunchLessons([lesson()]) ?? "";
    expect(block).toContain("Theme tokens live in tokens.css");
    expect(block).not.toContain("p:0000");
    expect(block).not.toContain("learned");
  });

  it("is nothing at all when the box has learned nothing", () => {
    expect(formatLaunchLessons([])).toBeNull();
  });

  it("stops before it can dwarf the task", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      lesson({
        id: `p:${index}`,
        lesson: `Fact number ${index} about this repo, stated at length.`,
      }),
    );
    const block = formatLaunchLessons(many) ?? "";
    expect(block.length).toBeLessThan(1600);
  });

  it("rides on a launch prompt once, after the contract", () => {
    const prompt = withAgentContract("Make the theme blue.", [], [lesson()]);
    expect(prompt).toContain(AGENT_REPORT_CONTRACT);
    expect(prompt).toContain("Theme tokens live in tokens.css");
    expect(withAgentContract(prompt, [], [lesson()])).toBe(prompt);
  });
});

describe("knowledge block", () => {
  it("carries the id, so Hermes can take a lesson back", () => {
    const block = formatKnowledgeBlock([lesson({ taughtCount: 3 })]) ?? "";
    expect(block).toContain("p:0000");
    expect(block).toContain("taught 3×");
  });

  it("says nothing a turn has to re-read — the rule is in the cached prefix", () => {
    const block = formatKnowledgeBlock([lesson()]) ?? "";
    expect(block.split("\n")).toHaveLength(1);
    expect(buildHermesSystemPrompt()).toContain("forget()");
  });
});

describe("learnFromCorrection", () => {
  it("keeps the first correction to itself and teaches the second", () => {
    withTempBase(() => {
      const first = learnFromCorrection({
        text: "The theme tokens live in tokens.css — do not hardcode hex values.",
        projectId: "p",
        cardId: "card-1",
      });
      expect(first?.status).toBe("candidate");
      expect(lessonsForProject({ projectId: "p" })).toHaveLength(0);

      const second = learnFromCorrection({
        text: "theme tokens live in tokens.css, do not hardcode hex values",
        projectId: "p",
        cardId: "card-2",
      });
      expect(second?.status).toBe("active");
      expect(lessonsForProject({ projectId: "p" })).toHaveLength(1);
      expect(second?.cardIds).toEqual(["card-1", "card-2"]);
    });
  });

  it("leaves a card-specific nudge as a candidate", () => {
    withTempBase(() => {
      learnFromCorrection({
        text: "Finish the remaining item in src/foo/Bar.tsx.",
        projectId: "p",
      });
      learnFromCorrection({
        text: "Finish the remaining item in src/baz/Qux.tsx.",
        projectId: "p",
      });
      expect(activeLessons()).toHaveLength(0);
    });
  });

  it("ignores a nudge too short to be a fact", () => {
    withTempBase(() => {
      expect(learnFromCorrection({ text: "keep going", projectId: "p" })).toBeNull();
    });
  });

  it("scopes a correction to the project it was typed in", () => {
    withTempBase(() => {
      learnFromCorrection({ text: "Run the migration test before finishing.", projectId: "a" });
      learnFromCorrection({ text: "Run the migration test before finishing.", projectId: "b" });
      expect(activeLessons()).toHaveLength(0);
      expect(
        recordLesson({
          lesson: "Run the migration test before finishing.",
          projectId: "a",
          source: "hermes",
          confirmAfter: 2,
        })?.status,
      ).toBe("active");
    });
  });
});

describe("learnFromTickNudges", () => {
  const cards = [
    { id: "c1", threadId: "t1", projectId: "proj-1" },
    { id: "c2", threadId: "t2", projectId: "proj-1" },
  ];
  const nudge = (threadId: string, text: string) => ({
    method: "nudgeThread",
    args: { threadId, text } as unknown,
  });

  it("turns a correction typed into a second thread into a lesson", () => {
    withTempBase(() => {
      learnFromTickNudges({
        calls: [nudge("t1", "Theme tokens live in tokens.css — do not hardcode hex values.")],
        cards,
      });
      expect(lessonsForProject({ projectId: "proj-1" })).toHaveLength(0);

      learnFromTickNudges({
        calls: [nudge("t2", "theme tokens live in tokens.css, do not hardcode hex values")],
        cards,
      });
      const carried = lessonsForProject({ projectId: "proj-1" });
      expect(carried).toHaveLength(1);
      expect(carried[0]?.cardIds).toEqual(["c1", "c2"]);
    });
  });

  it("reads only the nudges, and only the ones that ran", () => {
    withTempBase(() => {
      learnFromTickNudges({
        calls: [
          { method: "finishCard", args: { id: "c1" } as unknown },
          { ...nudge("t1", "A correction long enough to count as one."), skipped: true },
        ],
        cards,
      });
      expect(listLessonsForTest()).toHaveLength(0);
    });
  });
});
