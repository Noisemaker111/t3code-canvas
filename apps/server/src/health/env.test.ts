import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HEALTH_CHECKS } from "./checks.ts";
import { healthPathsFromEnvironment, makeHealthEnv } from "./env.ts";
import { runHealthChecks } from "./runner.ts";

const withTempDir = async <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "health-env-"));
  try {
    return await use(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("makeHealthEnv", () => {
  it("reads real free space and writability", async () => {
    await withTempDir(async (dir) => {
      const env = makeHealthEnv({
        stateDir: dir,
        worktreeRoot: null,
        releaseRoot: null,
        repoRoot: null,
      });
      const space = await env.fs.diskSpace(dir);
      expect(space?.totalBytes).toBeGreaterThan(0);
      expect(await env.fs.isWritable(dir)).toBe(true);
      expect(await env.fs.exists(NodePath.join(dir, "nope"))).toBe(false);
    });
  });

  it("leaves no probe file behind", async () => {
    await withTempDir(async (dir) => {
      const env = makeHealthEnv({
        stateDir: dir,
        worktreeRoot: null,
        releaseRoot: null,
        repoRoot: null,
      });
      await env.fs.isWritable(dir);
      expect(NodeFS.readdirSync(dir)).toEqual([]);
    });
  });

  it("reports a missing directory as neither existing nor writable", async () => {
    const env = makeHealthEnv({
      stateDir: "/nope/not/here",
      worktreeRoot: null,
      releaseRoot: null,
      repoRoot: null,
    });
    expect(await env.fs.exists("/nope/not/here")).toBe(false);
    expect(await env.fs.isWritable("/nope/not/here")).toBe(false);
    expect(await env.fs.diskSpace("/nope/not/here")).toBeNull();
  });

  it("runs the real registry against this filesystem without a network probe", async () => {
    await withTempDir(async (dir) => {
      const env = {
        ...makeHealthEnv({ stateDir: dir, worktreeRoot: null, releaseRoot: null, repoRoot: null }),
        reachable: async () => true,
      };
      const report = await runHealthChecks(HEALTH_CHECKS, env, {
        only: ["disk.headroom", "state.writable", "store.writable", "worktree.deps"],
      });
      expect(report.checks.map((outcome) => outcome.status)).not.toContain("fail");
    });
  });
});

describe("healthPathsFromEnvironment", () => {
  it("reads the worktree root and release root the service unit sets", () => {
    const previousWorktree = process.env["T3CODE_WORKTREE_ROOT"];
    const previousRelease = process.env["T3CODE_RELEASE_CURRENT"];
    try {
      process.env["T3CODE_WORKTREE_ROOT"] = "/root/projects/.worktrees";
      process.env["T3CODE_RELEASE_CURRENT"] = "/opt/t3j/current";
      const paths = healthPathsFromEnvironment("/var/lib/t3j/userdata");
      expect(paths.worktreeRoot).toBe("/root/projects/.worktrees");
      expect(paths.releaseRoot).toBe("/opt/t3j/current");
    } finally {
      if (previousWorktree === undefined) delete process.env["T3CODE_WORKTREE_ROOT"];
      else process.env["T3CODE_WORKTREE_ROOT"] = previousWorktree;
      if (previousRelease === undefined) delete process.env["T3CODE_RELEASE_CURRENT"];
      else process.env["T3CODE_RELEASE_CURRENT"] = previousRelease;
    }
  });

  it("treats an unset worktree root as absent, not as an empty path", () => {
    const previous = process.env["T3CODE_WORKTREE_ROOT"];
    try {
      process.env["T3CODE_WORKTREE_ROOT"] = "  ";
      expect(healthPathsFromEnvironment("/state").worktreeRoot).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["T3CODE_WORKTREE_ROOT"];
      else process.env["T3CODE_WORKTREE_ROOT"] = previous;
    }
  });
});
