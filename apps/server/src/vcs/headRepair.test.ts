import { assert, describe, it } from "@effect/vitest";

import { isCorruptHeadGitStderr, parseReflogTargets } from "./headRepair.ts";

describe("isCorruptHeadGitStderr", () => {
  it("matches the errors a missing HEAD object produces", () => {
    assert.equal(isCorruptHeadGitStderr("fatal: bad object HEAD"), true);
    assert.equal(isCorruptHeadGitStderr("fatal: bad object refs/heads/main"), true);
    assert.equal(isCorruptHeadGitStderr("error: refs/heads/main: reference broken"), true);
  });

  it("does not match an ordinary git failure", () => {
    assert.equal(isCorruptHeadGitStderr("fatal: not a git repository"), false);
    assert.equal(isCorruptHeadGitStderr("error: cannot lock ref refs/heads/main"), false);
  });
});

describe("parseReflogTargets", () => {
  it("returns each entry's new sha, newest first, without the zero sha", () => {
    const zero = "0".repeat(40);
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const reflog = [
      `${zero} ${first} T3 <t3@localhost> 1 +0000\tcommit (initial): one`,
      `${first} ${second} T3 <t3@localhost> 2 +0000\tcommit: two`,
      `${second} ${first} T3 <t3@localhost> 3 +0000\treset: moving to HEAD~1`,
      "",
    ].join("\n");

    assert.deepStrictEqual(parseReflogTargets(reflog), [first, second]);
  });

  it("ignores lines that are not reflog entries", () => {
    assert.deepStrictEqual(parseReflogTargets("garbage\n\n"), []);
  });
});
