import { assert, describe, it } from "@effect/vitest";

import {
  abandonedReapEnabled,
  DEFAULT_WORKTREE_RETENTION_HOURS,
  planWorktreeSweep,
  resolveRetentionHours,
  type SweepCandidate,
} from "./worktreeSweep.ts";

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const hoursAgo = (hours: number) => NOW - hours * 3_600_000;

const candidate = (input: Partial<SweepCandidate> & { path: string }): SweepCandidate => ({
  mtimeMs: hoursAgo(1),
  hasWorkingTreeChanges: false,
  ...input,
});

const plan = (input: {
  readonly candidates: ReadonlyArray<SweepCandidate>;
  readonly livePaths?: ReadonlyArray<string>;
  readonly retentionHours?: number;
  readonly reapAbandoned?: boolean;
}) =>
  planWorktreeSweep({
    candidates: input.candidates,
    livePaths: input.livePaths ?? [],
    nowMs: NOW,
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
    ...(input.reapAbandoned === undefined ? {} : { reapAbandoned: input.reapAbandoned }),
  });

describe("planWorktreeSweep", () => {
  it("keeps a workspace a live thread still owns", () => {
    const [decision] = plan({
      candidates: [candidate({ path: "/root/projects/.worktrees/demo/thread-a" })],
      livePaths: ["/root/projects/.worktrees/demo/thread-a"],
    });

    assert.equal(decision?.kind, "keep");
  });

  it("reclaims a claimed workspace once it is clean and past retention", () => {
    const [decision] = plan({
      candidates: [
        candidate({ path: "/root/projects/.worktrees/demo/thread-a", mtimeMs: hoursAgo(100) }),
      ],
      livePaths: ["/root/projects/.worktrees/demo/thread-a"],
    });

    // A thread record outlives its work: without this the board's own project
    // could never free a single workspace, however long ago the work finished.
    assert.equal(decision?.kind, "remove");
    // Nothing uncommitted is at stake, so this never needs force.
    assert.equal(decision?.kind === "remove" ? decision.force : true, false);
  });

  it("never reclaims a claimed workspace that has uncommitted changes", () => {
    const [decision] = plan({
      candidates: [
        candidate({
          path: "/root/projects/.worktrees/demo/thread-a",
          hasWorkingTreeChanges: true,
          mtimeMs: hoursAgo(10_000),
        }),
      ],
      livePaths: ["/root/projects/.worktrees/demo/thread-a"],
      reapAbandoned: true,
    });

    assert.equal(decision?.kind, "keep");
  });

  it("reclaims a clean orphan — the failed-launch and deleted-card leak", () => {
    const [decision] = plan({
      candidates: [candidate({ path: "/root/projects/.worktrees/demo/thread-orphan" })],
    });

    assert.equal(decision?.kind, "remove");
    // Nothing is at risk in a clean tree, so force is still never needed.
    assert.equal(decision?.kind === "remove" ? decision.force : true, false);
  });

  it("keeps a dirty orphan by default, however old it is", () => {
    const [decision] = plan({
      candidates: [
        candidate({
          path: "/root/projects/.worktrees/demo/thread-dirty",
          hasWorkingTreeChanges: true,
          mtimeMs: hoursAgo(1000),
        }),
      ],
    });

    assert.equal(decision?.kind, "keep");
    assert.include(
      decision?.kind === "keep" ? decision.reason : "",
      "T3CODE_WORKTREE_REAP_ABANDONED",
    );
  });

  it("still keeps a recent dirty orphan once the opt-in is set", () => {
    const [decision] = plan({
      candidates: [
        candidate({
          path: "/root/projects/.worktrees/demo/thread-dirty",
          hasWorkingTreeChanges: true,
          mtimeMs: hoursAgo(2),
        }),
      ],
      retentionHours: 72,
      reapAbandoned: true,
    });

    assert.equal(decision?.kind, "keep");
  });

  it("reclaims a dirty orphan only when opted in AND past the retention window", () => {
    const [decision] = plan({
      candidates: [
        candidate({
          path: "/root/projects/.worktrees/demo/thread-dirty",
          hasWorkingTreeChanges: true,
          mtimeMs: hoursAgo(100),
        }),
      ],
      retentionHours: 72,
      reapAbandoned: true,
    });

    assert.equal(decision?.kind, "remove");
    assert.equal(decision?.kind === "remove" ? decision.force : false, true);
  });

  it("treats an unknown mtime as freshly touched rather than abandoned", () => {
    const [decision] = plan({
      candidates: [
        candidate({
          path: "/root/projects/.worktrees/demo/thread-dirty",
          hasWorkingTreeChanges: true,
          mtimeMs: 0,
        }),
      ],
      retentionHours: 72,
      reapAbandoned: true,
    });

    assert.equal(decision?.kind, "keep");
  });

  it("decides each candidate independently", () => {
    const decisions = plan({
      candidates: [
        candidate({ path: "/w/demo/thread-live" }),
        candidate({ path: "/w/demo/thread-clean" }),
        candidate({ path: "/w/demo/thread-dirty", hasWorkingTreeChanges: true }),
      ],
      livePaths: ["/w/demo/thread-live"],
    });

    assert.deepEqual(
      decisions.map((decision) => decision.kind),
      ["keep", "remove", "keep"],
    );
  });
});

describe("worktree sweep settings", () => {
  it("falls back to the default retention on a missing or junk value", () => {
    assert.equal(resolveRetentionHours({}), DEFAULT_WORKTREE_RETENTION_HOURS);
    assert.equal(
      resolveRetentionHours({ T3CODE_WORKTREE_RETENTION_HOURS: "nope" }),
      DEFAULT_WORKTREE_RETENTION_HOURS,
    );
    assert.equal(
      resolveRetentionHours({ T3CODE_WORKTREE_RETENTION_HOURS: "0" }),
      DEFAULT_WORKTREE_RETENTION_HOURS,
    );
    assert.equal(resolveRetentionHours({ T3CODE_WORKTREE_RETENTION_HOURS: "12" }), 12);
  });

  it("keeps removing dirty worktrees off unless explicitly opted in", () => {
    assert.equal(abandonedReapEnabled({}), false);
    assert.equal(abandonedReapEnabled({ T3CODE_WORKTREE_REAP_ABANDONED: "0" }), false);
    assert.equal(abandonedReapEnabled({ T3CODE_WORKTREE_REAP_ABANDONED: "1" }), true);
    assert.equal(abandonedReapEnabled({ T3CODE_WORKTREE_REAP_ABANDONED: "true" }), true);
  });
});
