// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runHermesProgram } from "./executor.ts";
import { makeFakeBoardApi } from "./fakeBoardApi.ts";
import {
  activeLessons,
  bindKnowledgeLog,
  listLessons,
  unbindKnowledgeLog,
} from "./knowledgeStore.ts";

const policy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "review it" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

const withTempBase = async (use: () => Promise<void>): Promise<void> => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knowledge-program-"));
  try {
    bindKnowledgeLog(baseDir);
    await use();
  } finally {
    unbindKnowledgeLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

const program = (body: string): string => ["```js", body, "```"].join("\n");

describe("board.learn", () => {
  it("writes a lesson a later launch will carry", async () => {
    await withTempBase(async () => {
      const { api } = makeFakeBoardApi({ cards: [] });
      const result = await runHermesProgram({
        api,
        policy,
        source: program(
          "await board.learn({ lesson: 'Theme tokens live in tokens.css — never hardcode a hex value.', projectId: 'proj-1', topic: 'theming' });",
        ),
      });

      expect(result.error).toBeNull();
      expect(activeLessons()[0]?.lesson).toBe(
        "Theme tokens live in tokens.css — never hardcode a hex value.",
      );
      expect(activeLessons()[0]?.projectId).toBe("proj-1");
    });
  });

  it("refuses a phrase and an unknown project", async () => {
    await withTempBase(async () => {
      const { api } = makeFakeBoardApi({ cards: [] });
      const result = await runHermesProgram({
        api,
        policy,
        source: program(
          [
            "const short = await board.learn({ lesson: 'be careful' });",
            "const nowhere = await board.learn({ lesson: 'A perfectly good lesson line.', projectId: 'nope' });",
            "console.log(JSON.stringify([short.ok, nowhere.ok]));",
          ].join("\n"),
        ),
      });

      expect(result.logs.join("")).toContain("[false,false]");
      expect(listLessons()).toHaveLength(0);
    });
  });

  it("writes nothing on a dry run", async () => {
    await withTempBase(async () => {
      const { api } = makeFakeBoardApi({ cards: [] });
      await runHermesProgram({
        api,
        policy,
        recordOnly: true,
        source: program("await board.learn({ lesson: 'A fact worth keeping about this repo.' });"),
      });
      expect(listLessons()).toHaveLength(0);
    });
  });
});

describe("board.forget", () => {
  it("retires a lesson, and needs a reason to do it", async () => {
    await withTempBase(async () => {
      const { api } = makeFakeBoardApi({ cards: [] });
      const result = await runHermesProgram({
        api,
        policy,
        source: program(
          [
            "const learned = await board.learn({ lesson: 'The API base path is /api/v1.' });",
            "const silent = await board.forget({ id: learned.lessonId, reason: '' });",
            "const done = await board.forget({ id: learned.lessonId, reason: 'v2 shipped' });",
            "console.log(JSON.stringify([silent.ok, done.ok]));",
          ].join("\n"),
        ),
      });

      expect(result.error).toBeNull();
      expect(result.logs.join("")).toContain("[false,true]");
      expect(activeLessons()).toHaveLength(0);
      expect(listLessons()[0]?.retiredReason).toBe("v2 shipped");
    });
  });
});
