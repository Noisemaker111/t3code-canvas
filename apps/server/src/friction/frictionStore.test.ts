import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  bindFrictionLog,
  clearFriction,
  frictionDueForCard,
  frictionFingerprint,
  listFriction,
  normalizeSignature,
  recordFriction,
  restoreFrictionLog,
  setFrictionStatus,
  unbindFrictionLog,
  type FrictionInput,
} from "./frictionStore.ts";

const papercut = (over: Partial<FrictionInput> = {}): FrictionInput => ({
  source: "agent",
  scope: "harness",
  tool: "apply_patch",
  summary: "apply_patch fails against a rift worktree",
  evidence: "apply_patch: failed to apply hunk at line 42",
  workaround: "switched to scripted file edits",
  threadId: "thread-1",
  ...over,
});

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "friction-"));
  try {
    bindFrictionLog(baseDir);
    return use(baseDir);
  } finally {
    unbindFrictionLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

describe("friction fingerprint", () => {
  it("collapses line numbers, paths and hashes", () => {
    expect(normalizeSignature("failed at /root/projects/foo/bar.ts line 42")).toBe(
      normalizeSignature("failed at /var/lib/other/baz.ts line 913"),
    );
  });

  it("keeps genuinely different failures apart", () => {
    const a = frictionFingerprint({
      scope: "harness",
      tool: "apply_patch",
      signature: "no such hunk",
    });
    const b = frictionFingerprint({
      scope: "harness",
      tool: "apply_patch",
      signature: "permission denied",
    });
    expect(a).not.toBe(b);
  });

  it("separates the same error under different scopes", () => {
    const a = frictionFingerprint({
      scope: "harness",
      tool: "x",
      signature: "boom",
    });
    const b = frictionFingerprint({
      scope: "upstream",
      tool: "x",
      signature: "boom",
    });
    expect(a).not.toBe(b);
  });
});

describe("friction store", () => {
  it("dedups recurrences into one entry with a count", () => {
    withTempBase(() => {
      recordFriction(papercut());
      recordFriction(papercut({ evidence: "apply_patch: failed to apply hunk at line 91" }));
      const all = listFriction();
      expect(all).toHaveLength(1);
      expect(all[0]?.count).toBe(2);
    });
  });

  it("widens the thread set across threads", () => {
    withTempBase(() => {
      recordFriction(papercut({ threadId: "thread-1" }));
      recordFriction(papercut({ threadId: "thread-2" }));
      expect(listFriction()[0]?.threadIds).toEqual(["thread-1", "thread-2"]);
    });
  });

  it("keeps the first workaround when a later sighting has none", () => {
    withTempBase(() => {
      recordFriction(papercut());
      recordFriction(papercut({ workaround: null }));
      expect(listFriction()[0]?.workaround).toBe("switched to scripted file edits");
    });
  });

  it("survives a restart instead of re-counting from zero", () => {
    withTempBase((baseDir) => {
      recordFriction(papercut());
      recordFriction(papercut());
      bindFrictionLog(baseDir);
      restoreFrictionLog();
      expect(listFriction()[0]?.count).toBe(2);
    });
  });

  /** A guess from the text matcher: no reporter, no observed workaround. */
  const guessed = (over: Partial<FrictionInput> = {}): FrictionInput =>
    papercut({ source: "detector", workaround: null, ...over });

  it("cards a guessed failure on the first sighting", () => {
    withTempBase(() => {
      recordFriction(guessed());
      expect(frictionDueForCard()).toHaveLength(1);
    });
  });

  it("keeps sightings from different threads as one due entry", () => {
    withTempBase(() => {
      recordFriction(guessed({ threadId: "thread-1" }));
      recordFriction(guessed({ threadId: "thread-2" }));
      expect(frictionDueForCard()).toHaveLength(1);
    });
  });

  it("cards an agent's own report on the first sighting", () => {
    withTempBase(() => {
      recordFriction(papercut({ source: "agent", workaround: null }));
      expect(frictionDueForCard()).toHaveLength(1);
    });
  });

  it("cards an observed workaround on the first sighting", () => {
    withTempBase(() => {
      recordFriction(guessed({ workaround: "cd vendor/t3code && vp lint" }));
      expect(frictionDueForCard()).toHaveLength(1);
    });
  });

  it("stops offering an entry once it is carded", () => {
    withTempBase(() => {
      recordFriction(papercut({ threadId: "a" }));
      const entry = recordFriction(papercut({ threadId: "b" }));
      setFrictionStatus(entry.fingerprint, "carded", "card-9");
      expect(frictionDueForCard()).toHaveLength(0);
      expect(listFriction()[0]?.fixCardId).toBe("card-9");
    });
  });

  it("reopens a fixed entry that comes back", () => {
    withTempBase(() => {
      const entry = recordFriction(papercut());
      setFrictionStatus(entry.fingerprint, "fixed");
      expect(recordFriction(papercut()).status).toBe("open");
    });
  });

  it("clears a fingerprint when the operation succeeds again", () => {
    withTempBase(() => {
      const entry = recordFriction(papercut({ source: "board", tool: "openPr" }));
      clearFriction(entry.fingerprint);
      expect(listFriction()).toHaveLength(0);
    });
  });

  it("records nothing to disk when the log is unbound", () => {
    unbindFrictionLog();
    expect(() => recordFriction(papercut())).not.toThrow();
    expect(listFriction()).toHaveLength(1);
  });
});
