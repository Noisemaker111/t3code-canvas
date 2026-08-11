import { describe, expect, it } from "@effect/vitest";

import {
  ghPrArgs,
  githubRepoFromPrReference,
  isAlreadyMergedGhOutput,
  isMergedPrState,
} from "./ghPullRequestArgs.ts";

describe("githubRepoFromPrReference", () => {
  it("parses a full pull request URL", () => {
    expect(githubRepoFromPrReference("https://github.com/Noisemaker111/vps-code/pull/328")).toBe(
      "Noisemaker111/vps-code",
    );
  });

  it("returns null for a bare number", () => {
    expect(githubRepoFromPrReference("328")).toBeNull();
  });
});

describe("ghPrArgs", () => {
  it("adds --repo when the reference is a github PR URL", () => {
    expect(ghPrArgs("merge", "https://github.com/o/r/pull/7", ["--squash"])).toEqual([
      "pr",
      "merge",
      "https://github.com/o/r/pull/7",
      "--repo",
      "o/r",
      "--squash",
    ]);
  });

  it("leaves a bare reference alone so existing cwd-based flows still work", () => {
    expect(ghPrArgs("merge", "164", ["--squash", "--delete-branch"])).toEqual([
      "pr",
      "merge",
      "164",
      "--squash",
      "--delete-branch",
    ]);
  });
});

describe("isAlreadyMergedGhOutput", () => {
  it("detects gh's already-merged message", () => {
    expect(
      isAlreadyMergedGhOutput("! Pull request Noisemaker111/vps-code#328 was already merged"),
    ).toBe(true);
  });

  it("does not treat a dirty merge as already merged", () => {
    expect(
      isAlreadyMergedGhOutput(
        "Pull request is not mergeable: the merge commit cannot be cleanly created",
      ),
    ).toBe(false);
  });
});

describe("isMergedPrState", () => {
  it("accepts MERGED case-insensitively", () => {
    expect(isMergedPrState("MERGED")).toBe(true);
    expect(isMergedPrState("merged")).toBe(true);
  });

  it("rejects open", () => {
    expect(isMergedPrState("OPEN")).toBe(false);
    expect(isMergedPrState(null)).toBe(false);
  });
});
