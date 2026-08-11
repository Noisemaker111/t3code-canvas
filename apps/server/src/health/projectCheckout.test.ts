import { describe, expect, it } from "@effect/vitest";

import {
  isDirtyFromStatusSb,
  isProjectCheckoutCandidate,
  parseGitShortBranchLine,
  planCheckoutHeal,
  projectCheckoutFromStatusSb,
  summarizeProjectCheckouts,
} from "./projectCheckout.ts";

describe("parseGitShortBranchLine", () => {
  it("reads an attached branch with upstream", () => {
    expect(parseGitShortBranchLine("## main...origin/main")).toEqual({
      branch: "main",
      detached: false,
    });
  });

  it("reads detached HEAD", () => {
    expect(parseGitShortBranchLine("## HEAD (no branch)")).toEqual({
      branch: null,
      detached: true,
    });
  });

  it("reads a plain local branch", () => {
    expect(parseGitShortBranchLine("## feature/ship")).toEqual({
      branch: "feature/ship",
      detached: false,
    });
  });
});

describe("isDirtyFromStatusSb", () => {
  it("ignores the branch line alone", () => {
    expect(isDirtyFromStatusSb("## main...origin/main\n")).toBe(false);
  });

  it("flags porcelain entries", () => {
    expect(isDirtyFromStatusSb("## main\n M foo.ts\n")).toBe(true);
  });
});

describe("projectCheckoutFromStatusSb + summarize", () => {
  it("marks unreadable status as dirty/unreadable", () => {
    const state = projectCheckoutFromStatusSb({
      path: "/root/projects/vps-code",
      name: "vps-code",
      statusSb: null,
      exitCode: 128,
    });
    expect(state.unreadable).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it("fails when any checkout is detached", () => {
    const detached = projectCheckoutFromStatusSb({
      path: "/p/vps-code",
      name: "vps-code",
      statusSb: "## HEAD (no branch)\n",
      exitCode: 0,
    });
    const ok = projectCheckoutFromStatusSb({
      path: "/p/other",
      name: "other",
      statusSb: "## main\n",
      exitCode: 0,
    });
    const summary = summarizeProjectCheckouts([detached, ok]);
    expect(summary.status).toBe("fail");
    expect(summary.detail).toContain("detached HEAD");
    expect(summary.detail).toContain("vps-code");
  });

  it("warns on dirty attached trees", () => {
    const dirty = projectCheckoutFromStatusSb({
      path: "/p/vps-code",
      name: "vps-code",
      statusSb: "## main\n M x\n",
      exitCode: 0,
    });
    const summary = summarizeProjectCheckouts([dirty]);
    expect(summary.status).toBe("warn");
    expect(summary.detail).toContain("dirty");
  });

  it("passes clean attached trees", () => {
    const clean = projectCheckoutFromStatusSb({
      path: "/p/vps-code",
      name: "vps-code",
      statusSb: "## main...origin/main\n",
      exitCode: 0,
    });
    const summary = summarizeProjectCheckouts([clean]);
    expect(summary.status).toBe("ok");
    expect(summary.detail).toContain("vps-code@main");
  });
});

describe("planCheckoutHeal", () => {
  it("checks out main only when detached and clean", () => {
    const cleanDetached = projectCheckoutFromStatusSb({
      path: "/p/x",
      name: "x",
      statusSb: "## HEAD (no branch)\n",
      exitCode: 0,
    });
    expect(planCheckoutHeal(cleanDetached)).toEqual({ action: "checkout", branch: "main" });
  });

  it("skips dirty detached", () => {
    const dirty = projectCheckoutFromStatusSb({
      path: "/p/x",
      name: "x",
      statusSb: "## HEAD (no branch)\n M a\n",
      exitCode: 0,
    });
    expect(planCheckoutHeal(dirty).action).toBe("skip");
  });

  it("skips already branched", () => {
    const onMain = projectCheckoutFromStatusSb({
      path: "/p/x",
      name: "x",
      statusSb: "## main\n",
      exitCode: 0,
    });
    expect(planCheckoutHeal(onMain).action).toBe("skip");
  });
});

describe("isProjectCheckoutCandidate", () => {
  it("skips worktree nests and dots", () => {
    expect(isProjectCheckoutCandidate(".worktrees")).toBe(false);
    expect(isProjectCheckoutCandidate("vps-code")).toBe(true);
  });
});
