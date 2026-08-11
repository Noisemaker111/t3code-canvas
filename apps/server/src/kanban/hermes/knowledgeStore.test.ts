// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CANDIDATE_STALE_MS,
  LESSON_STALE_MS,
  activeLessons,
  bindKnowledgeLog,
  expireStaleLessons,
  lessonsForProject,
  listLessons,
  noteLessonsTaught,
  normalizeLesson,
  recordLesson,
  restoreKnowledgeLog,
  retireLesson,
  unbindKnowledgeLog,
} from "./knowledgeStore.ts";

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knowledge-"));
  try {
    bindKnowledgeLog(baseDir);
    return use(baseDir);
  } finally {
    unbindKnowledgeLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe("knowledgeStore", () => {
  it("teaches a stated lesson at once and counts a restatement", () => {
    withTempBase(() => {
      const first = recordLesson({
        lesson: "Theme tokens live in tokens.css — never hardcode a hex value.",
        projectId: "project-1",
        source: "user",
      });
      const again = recordLesson({
        lesson: "theme tokens live in tokens.css; never hardcode a hex value",
        projectId: "project-1",
        source: "hermes",
      });
      expect(first?.status).toBe("active");
      expect(again?.id).toBe(first?.id);
      expect(again?.learnedCount).toBe(2);
      expect(listLessons()).toHaveLength(1);
    });
  });

  it("holds an inferred lesson as a candidate until it happens twice", () => {
    withTempBase(() => {
      const once = recordLesson({
        lesson: "Run vp lint before you call a change finished.",
        projectId: "project-1",
        source: "hermes",
        confirmAfter: 2,
      });
      expect(once?.status).toBe("candidate");
      expect(activeLessons()).toHaveLength(0);

      const twice = recordLesson({
        lesson: "run vp lint before you call a change finished",
        projectId: "project-1",
        source: "hermes",
        confirmAfter: 2,
      });
      expect(twice?.status).toBe("active");
      expect(activeLessons()).toHaveLength(1);
    });
  });

  it("refuses a phrase", () => {
    withTempBase(() => {
      expect(recordLesson({ lesson: "be careful", source: "user" })).toBeNull();
    });
  });

  it("puts the project's own lessons before the ones true everywhere", () => {
    withTempBase(() => {
      recordLesson({ lesson: "This box has no docker daemon.", projectId: null, source: "user" });
      recordLesson({
        lesson: "The server package is typechecked with tsgo, not tsc.",
        projectId: "project-1",
        source: "user",
      });
      recordLesson({
        lesson: "Mobile styles live in one file.",
        projectId: "project-2",
        source: "user",
      });

      const carried = lessonsForProject({ projectId: "project-1" });
      expect(carried.map((entry) => entry.projectId)).toEqual(["project-1", null]);
    });
  });

  it("ranks a repeated lesson above a merely recent one", () => {
    withTempBase(() => {
      recordLesson({ lesson: "Always run the migration test.", projectId: "p", source: "user" });
      recordLesson({ lesson: "always run the migration test", projectId: "p", source: "user" });
      recordLesson({
        lesson: "Prefer the shared button component.",
        projectId: "p",
        source: "user",
      });

      expect(lessonsForProject({ projectId: "p" })[0]?.lesson).toBe(
        "Always run the migration test.",
      );
    });
  });

  it("counts the launches that carried a lesson", () => {
    withTempBase(() => {
      const lesson = recordLesson({ lesson: "Use pnpm, not npm.", projectId: "p", source: "user" });
      noteLessonsTaught([lesson?.id ?? ""]);
      noteLessonsTaught([lesson?.id ?? ""]);
      expect(listLessons()[0]?.taughtCount).toBe(2);
    });
  });

  it("retires a lesson with its reason and stops teaching it", () => {
    withTempBase(() => {
      const lesson = recordLesson({
        lesson: "The API base is /api/v1.",
        projectId: "p",
        source: "user",
      });
      const retired = retireLesson(lesson?.id ?? "", "v2 shipped");
      expect(retired?.retiredReason).toBe("v2 shipped");
      expect(lessonsForProject({ projectId: "p" })).toHaveLength(0);
      expect(retireLesson(lesson?.id ?? "", "again")).toBeNull();
    });
  });

  it("expires what nothing re-learned, candidates sooner than lessons", () => {
    withTempBase(() => {
      recordLesson({
        lesson: "An old fact about a file that no longer exists.",
        projectId: "p",
        source: "user",
        at: daysAgo(LESSON_STALE_MS / 86_400_000 + 1),
      });
      recordLesson({
        lesson: "A correction that only ever fitted one card.",
        projectId: "p",
        source: "hermes",
        confirmAfter: 2,
        at: daysAgo(CANDIDATE_STALE_MS / 86_400_000 + 1),
      });
      recordLesson({ lesson: "Something learned this morning.", projectId: "p", source: "user" });

      expect(expireStaleLessons()).toHaveLength(2);
      expect(activeLessons().map((entry) => entry.lesson)).toEqual([
        "Something learned this morning.",
      ]);
    });
  });

  it("brings a retired lesson back when someone has to say it again", () => {
    withTempBase(() => {
      const lesson = recordLesson({
        lesson: "Do not edit generated files.",
        projectId: "p",
        source: "user",
      });
      retireLesson(lesson?.id ?? "", "thought it was obsolete");
      const relearned = recordLesson({
        lesson: "do not edit generated files",
        projectId: "p",
        source: "user",
      });
      expect(relearned?.status).toBe("active");
      expect(relearned?.retiredReason).toBeNull();
    });
  });

  it("survives a restart", () => {
    withTempBase((baseDir) => {
      recordLesson({
        lesson: "Deploys run from the box, not from CI.",
        projectId: "p",
        source: "user",
      });
      bindKnowledgeLog(baseDir);
      expect(activeLessons()).toHaveLength(0);
      restoreKnowledgeLog();
      expect(activeLessons()[0]?.lesson).toBe("Deploys run from the box, not from CI.");
    });
  });

  it("collapses wording so one fact is one lesson", () => {
    expect(normalizeLesson("Always use the shared Button component!")).toBe(
      normalizeLesson("use  the shared `Button` component"),
    );
  });
});
