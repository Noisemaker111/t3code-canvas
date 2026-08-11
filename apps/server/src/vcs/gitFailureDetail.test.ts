import { assert, describe, it } from "@effect/vitest";

import { describeGitFailure, redactGitOutput, withGitFailureDetail } from "./gitFailureDetail.ts";

describe("describeGitFailure", () => {
  it("carries git's reason on one line", () => {
    assert.equal(
      describeGitFailure({
        stderr: "fatal: Unable to create '/root/projects/vps-code/.git/index.lock': File exists\n",
      }),
      "fatal: Unable to create '/root/projects/vps-code/.git/index.lock': File exists",
    );
  });

  it("joins multi-line output instead of dropping the tail", () => {
    assert.equal(
      describeGitFailure({ stderr: "error: one\nerror: two\n" }),
      "error: one | error: two",
    );
  });

  it("falls back to stdout when git said nothing on stderr", () => {
    assert.equal(
      describeGitFailure({ stderr: "  ", stdout: "no space left on device" }),
      "no space left on device",
    );
  });

  it("is empty when there is nothing to carry", () => {
    assert.equal(describeGitFailure({ stderr: "", stdout: "" }), "");
  });

  it("bounds the line", () => {
    const long = describeGitFailure({ stderr: "x".repeat(1_000) });
    assert.equal(long.length, 401);
    assert.isTrue(long.endsWith("…"));
  });
});

describe("redactGitOutput", () => {
  it("removes credentials from a remote URL", () => {
    assert.equal(
      redactGitOutput("remote: https://someone:ghp_abcdefghijklmnopqrst@github.com/o/r"),
      "remote: https://***@github.com/o/r",
    );
  });

  it("removes a bare token", () => {
    assert.equal(
      redactGitOutput("bad credentials for github_pat_abcdefghijklmnopqrstuv"),
      "bad credentials for ***",
    );
  });
});

describe("withGitFailureDetail", () => {
  it("appends the reason", () => {
    assert.equal(
      withGitFailureDetail("Git status failed.", { stderr: "no space left on device" }),
      "Git status failed. no space left on device",
    );
  });

  it("leaves the detail alone when git was silent", () => {
    assert.equal(withGitFailureDetail("Git status failed.", { stderr: "" }), "Git status failed.");
  });
});
