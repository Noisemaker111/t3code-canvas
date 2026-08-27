import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeGitHubIssueListJson } from "./gitHubIssues.ts";

describe("decodeGitHubIssueListJson", () => {
  it("normalizes state and flattens label objects to names", () => {
    const raw = JSON.stringify([
      {
        number: 7,
        title: "composer eats the first keystroke",
        url: "https://github.com/o/r/issues/7",
        state: "OPEN",
        labels: [{ name: "bug" }, { name: "  " }, { name: "size:S" }],
      },
      {
        number: 8,
        title: "closed one",
        url: "https://github.com/o/r/issues/8",
        state: "closed",
        labels: null,
      },
    ]);
    const result = decodeGitHubIssueListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual([
        {
          number: 7,
          title: "composer eats the first keystroke",
          url: "https://github.com/o/r/issues/7",
          state: "open",
          labels: ["bug", "size:S"],
        },
        {
          number: 8,
          title: "closed one",
          url: "https://github.com/o/r/issues/8",
          state: "closed",
          labels: [],
        },
      ]);
    }
  });

  it("skips a malformed entry rather than failing the list", () => {
    const raw = JSON.stringify([
      { number: "nope" },
      { number: 3, title: "fine", url: "https://github.com/o/r/issues/3", state: "OPEN" },
    ]);
    const result = decodeGitHubIssueListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.map((entry) => entry.number)).toEqual([3]);
    }
  });

  it("fails on JSON that is not a list", () => {
    expect(Result.isFailure(decodeGitHubIssueListJson('{"not":"a list"}'))).toBe(true);
  });
});
