import { describe, expect, it } from "@effect/vitest";

import {
  clearSessionErrorWhenReady,
  liveCardThreadIds,
  orphanedThreadIds,
} from "./threadHygiene.ts";

describe("thread hygiene", () => {
  it("archives missing worktrees only when no live Active or PR card holds the thread", () => {
    const heldThreadIds = liveCardThreadIds([
      { column: "active", threadId: "held-active", archivedAt: null },
      { column: "pr", threadId: "held-pr", archivedAt: null },
      { column: "done", threadId: "not-held", archivedAt: null },
      { column: "active", threadId: "archived", archivedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(
      orphanedThreadIds({
        threads: [
          { threadId: "orphan", worktreePath: "/tmp/thread-orphan", worktreeExists: false },
          { threadId: "held-active", worktreePath: "/tmp/thread-held", worktreeExists: false },
          { threadId: "held-pr", worktreePath: "/tmp/thread-pr", worktreeExists: false },
          { threadId: "not-held", worktreePath: "/tmp/thread-done", worktreeExists: false },
          { threadId: "archived", worktreePath: "/tmp/thread-archived", worktreeExists: false },
          { threadId: "live", worktreePath: "/tmp/thread-live", worktreeExists: true },
        ],
        heldThreadIds,
      }),
    ).toEqual(["orphan", "not-held", "archived"]);
  });

  it("never pairs ready with a stale session error", () => {
    expect(clearSessionErrorWhenReady({ status: "ready", lastError: "old failure" })).toEqual({
      status: "ready",
      lastError: null,
    });
    expect(clearSessionErrorWhenReady({ status: "error", lastError: "current failure" })).toEqual({
      status: "error",
      lastError: "current failure",
    });
  });
});
