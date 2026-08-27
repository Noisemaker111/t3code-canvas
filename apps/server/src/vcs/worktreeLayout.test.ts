import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  WORKTREE_ROOT_ENV_KEY,
  buildThreadWorktreePath,
  isThreadWorktreePath,
  resolveWorktreeRoot,
  sanitizeWorktreeSegment,
} from "./worktreeLayout.ts";

const path = {
  join: (...segments: ReadonlyArray<string>) => NodePath.join(...segments),
  resolve: (...segments: ReadonlyArray<string>) => NodePath.resolve(...segments),
  dirname: (value: string) => NodePath.dirname(value),
  isAbsolute: (value: string) => NodePath.isAbsolute(value),
};

describe("worktreeLayout", () => {
  it("defaults the workspace root to the .worktrees sibling of the project", () => {
    assert.equal(
      resolveWorktreeRoot({ path, projectCwd: "/root/projects/vps-code", env: {} }),
      "/root/projects/.worktrees",
    );
  });

  it("honours the T3CODE_WORKTREE_ROOT override", () => {
    assert.equal(
      resolveWorktreeRoot({
        path,
        projectCwd: "/root/projects/vps-code",
        env: { [WORKTREE_ROOT_ENV_KEY]: "/mnt/fast/worktrees" },
      }),
      "/mnt/fast/worktrees",
    );
  });

  it("always resolves the workspace root to an absolute path", () => {
    const root = resolveWorktreeRoot({
      path,
      projectCwd: "/root/projects/vps-code",
      env: { [WORKTREE_ROOT_ENV_KEY]: "../elsewhere" },
    });
    assert.isTrue(NodePath.isAbsolute(root));
    assert.equal(root, "/root/projects/elsewhere");
  });

  it("gives two threads on the same base branch two different paths", () => {
    const projectCwd = "/root/projects/vps-code";
    const first = buildThreadWorktreePath({
      path,
      projectCwd,
      threadId: "11111111-1111-4111-8111-111111111111",
      env: {},
    });
    const second = buildThreadWorktreePath({
      path,
      projectCwd,
      threadId: "22222222-2222-4222-8222-222222222222",
      env: {},
    });

    assert.notEqual(first, second);
    assert.equal(NodePath.dirname(first), "/root/projects/.worktrees/vps-code");
    assert.equal(NodePath.dirname(second), "/root/projects/.worktrees/vps-code");
    assert.isTrue(NodePath.isAbsolute(first));
  });

  it("namespaces each project's workspaces under its own directory", () => {
    const ours = buildThreadWorktreePath({
      path,
      projectCwd: "/root/projects/vps-code",
      threadId: "abc",
      env: {},
    });
    const theirs = buildThreadWorktreePath({
      path,
      projectCwd: "/root/projects/jgengine",
      threadId: "abc",
      env: {},
    });

    assert.equal(ours, "/root/projects/.worktrees/vps-code/thread-abc");
    assert.equal(theirs, "/root/projects/.worktrees/jgengine/thread-abc");
    assert.isFalse(
      isThreadWorktreePath({
        path,
        projectCwd: "/root/projects/vps-code",
        candidate: theirs,
        env: {},
      }),
    );
  });

  it("keeps thread ids safe as a single path segment", () => {
    assert.equal(sanitizeWorktreeSegment("feature/some branch"), "feature-some-branch");
    assert.equal(sanitizeWorktreeSegment("../../etc"), "etc");
    assert.equal(sanitizeWorktreeSegment("   "), "workspace");
  });

  it("recognises only direct children of the workspace root as thread worktrees", () => {
    const projectCwd = "/root/projects/vps-code";
    const worktree = buildThreadWorktreePath({ path, projectCwd, threadId: "abc", env: {} });

    assert.isTrue(isThreadWorktreePath({ path, projectCwd, candidate: worktree, env: {} }));
    assert.isFalse(isThreadWorktreePath({ path, projectCwd, candidate: projectCwd, env: {} }));
    assert.isFalse(
      isThreadWorktreePath({ path, projectCwd, candidate: "/root/projects/.worktrees", env: {} }),
    );
    assert.isFalse(
      isThreadWorktreePath({
        path,
        projectCwd,
        candidate: "/root/projects/.worktrees/vps-code",
        env: {},
      }),
    );
    assert.isFalse(
      isThreadWorktreePath({ path, projectCwd, candidate: "/tmp/somewhere-else", env: {} }),
    );
  });
});
