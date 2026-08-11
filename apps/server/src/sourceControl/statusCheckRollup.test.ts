import { describe, expect, it } from "@effect/vitest";

import { parseStatusCheckRollup } from "./statusCheckRollup.ts";

const rollup = (entries: ReadonlyArray<Record<string, unknown>>) =>
  JSON.stringify({ statusCheckRollup: entries });

describe("parseStatusCheckRollup", () => {
  it("reads a completed successful check run as passing", () => {
    const checks = parseStatusCheckRollup(
      rollup([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]),
    );
    expect(checks.state).toBe("passing");
    expect(checks.failing).toEqual([]);
  });

  it("reads a failure and keeps the name and link to it", () => {
    const checks = parseStatusCheckRollup(
      rollup([
        {
          name: "t3 server tests",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.test/run/1",
        },
      ]),
    );
    expect(checks.state).toBe("failing");
    expect(checks.failing).toEqual([{ name: "t3 server tests", url: "https://github.test/run/1" }]);
  });

  it("never reads a running check as a pass", () => {
    const checks = parseStatusCheckRollup(
      rollup([{ name: "ci", status: "IN_PROGRESS", conclusion: null }]),
    );
    expect(checks.state).toBe("pending");
  });

  it("reports red even while siblings are still running", () => {
    const checks = parseStatusCheckRollup(
      rollup([
        { name: "slow", status: "IN_PROGRESS" },
        { name: "fast", status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    );
    expect(checks.state).toBe("failing");
    expect(checks.failing.map((entry) => entry.name)).toEqual(["fast"]);
  });

  it("keeps only the latest rerun of the same workflow check", () => {
    const checks = parseStatusCheckRollup(
      rollup([
        {
          name: "quick",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "CANCELLED",
          startedAt: "2026-07-31T04:23:18Z",
          completedAt: "2026-07-31T04:23:55Z",
        },
        {
          name: "quick",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2026-07-31T04:24:06Z",
          completedAt: "2026-07-31T04:24:42Z",
        },
        {
          context: "Vercel",
          state: "FAILURE",
          startedAt: "2026-07-31T04:24:24Z",
          targetUrl: "https://vercel.test/failure",
        },
      ]),
    );

    expect(checks.state).toBe("failing");
    expect(checks.counts).toEqual({ total: 2, passing: 1, failing: 1, pending: 0 });
    expect(checks.failing).toEqual([{ name: "Vercel", url: "https://vercel.test/failure" }]);
  });

  it("understands the legacy status-context shape", () => {
    expect(
      parseStatusCheckRollup(
        rollup([{ context: "legacy/build", state: "FAILURE", targetUrl: "https://ci.test/7" }]),
      ),
    ).toEqual({
      state: "failing",
      failing: [{ name: "legacy/build", url: "https://ci.test/7" }],
      counts: { total: 1, passing: 0, failing: 1, pending: 0 },
      openedAtMs: null,
    });
    expect(parseStatusCheckRollup(rollup([{ context: "legacy", state: "PENDING" }])).state).toBe(
      "pending",
    );
  });

  it("treats a cancelled or timed-out run as failing, not as noise", () => {
    expect(
      parseStatusCheckRollup(rollup([{ name: "ci", status: "COMPLETED", conclusion: "TIMED_OUT" }]))
        .state,
    ).toBe("failing");
  });

  it("says unknown — never passing — when there is nothing to read", () => {
    expect(parseStatusCheckRollup(rollup([])).state).toBe("unknown");
    expect(parseStatusCheckRollup("not json").state).toBe("unknown");
    expect(parseStatusCheckRollup("{}").state).toBe("unknown");
  });

  it("separates a repo with no checks from a read that did not answer", () => {
    expect(parseStatusCheckRollup(rollup([])).unknownReason).toBe("no_checks");
    expect(parseStatusCheckRollup("not json").unknownReason).toBe("unavailable");
    expect(parseStatusCheckRollup("{}").unknownReason).toBe("unavailable");
    expect(parseStatusCheckRollup(JSON.stringify({ statusCheckRollup: null })).unknownReason).toBe(
      "unavailable",
    );
  });

  it("carries when the pull request was opened, so a grace window can be measured", () => {
    const raw = JSON.stringify({ statusCheckRollup: [], createdAt: "2026-07-31T00:00:00.000Z" });
    expect(parseStatusCheckRollup(raw).openedAtMs).toBe(Date.parse("2026-07-31T00:00:00.000Z"));
    expect(parseStatusCheckRollup(rollup([])).openedAtMs).toBeNull();
  });

  it("carries the pull request state in the same forge read", () => {
    expect(
      parseStatusCheckRollup(
        JSON.stringify({
          statusCheckRollup: [],
          state: "MERGED",
          mergedAt: "2026-08-11T01:57:48Z",
        }),
      ).changeRequestState,
    ).toBe("merged");
    expect(
      parseStatusCheckRollup(
        JSON.stringify({ statusCheckRollup: [], state: "OPEN", mergedAt: null }),
      ).changeRequestState,
    ).toBe("open");
  });

  it("ignores a neutral or skipped conclusion rather than blocking the merge", () => {
    expect(
      parseStatusCheckRollup(
        rollup([{ name: "optional", status: "COMPLETED", conclusion: "SKIPPED" }]),
      ).state,
    ).toBe("passing");
  });
});

describe("parseStatusCheckRollup counts", () => {
  it("counts each verdict so the board can render progress", () => {
    const checks = parseStatusCheckRollup(
      rollup([
        { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "b", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "c", status: "IN_PROGRESS" },
      ]),
    );
    expect(checks.state).toBe("pending");
    expect(checks.counts).toEqual({ total: 3, passing: 2, failing: 0, pending: 1 });
  });
});
