import { describe, expect, it } from "@effect/vitest";

import { isHuskStoreEntry, isReclaimableHusk, isThreadWorktreePath } from "./worktreeStorePaths.ts";

describe("isThreadWorktreePath", () => {
  it("matches project/thread-* under the store root", () => {
    expect(
      isThreadWorktreePath(
        "/root/projects/.worktrees",
        "/root/projects/.worktrees/vps-code/thread-abc",
      ),
    ).toBe(true);
  });

  it("rejects top-level husks", () => {
    expect(
      isThreadWorktreePath(
        "/root/projects/.worktrees",
        "/root/projects/.worktrees/t3code-git-manager-x",
      ),
    ).toBe(false);
  });
});

describe("isReclaimableHusk", () => {
  it("reclaims git-manager leftovers with no .git and no threads", () => {
    expect(
      isReclaimableHusk({
        name: "t3code-git-manager-abc",
        hasGit: false,
        isDirectory: true,
        childNames: [".trash"],
      }),
    ).toBe(true);
  });

  it("keeps a project nest that still has thread worktrees", () => {
    expect(
      isReclaimableHusk({
        name: "vps-code",
        hasGit: false,
        isDirectory: true,
        childNames: ["thread-abc", ".trash"],
      }),
    ).toBe(false);
  });

  it("does not reclaim a real git worktree", () => {
    expect(
      isReclaimableHusk({
        name: "feature-pr-worktree",
        hasGit: true,
        isDirectory: true,
        childNames: [],
      }),
    ).toBe(false);
  });
});

describe("isHuskStoreEntry", () => {
  it("skips dotdirs", () => {
    expect(isHuskStoreEntry({ name: ".trash", hasGit: false, isDirectory: true })).toBe(false);
  });
});
