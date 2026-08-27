import { describe, expect, it } from "@effect/vitest";

import { formatWorktreeReclaimReport, reclaimWasNoop } from "./worktreeReclaimReport.ts";

describe("formatWorktreeReclaimReport", () => {
  it("names husks removed and dirty left", () => {
    const detail = formatWorktreeReclaimReport({
      husksRemoved: 3,
      husksFailed: 0,
      worktreesBefore: 10,
      worktreesAfter: 6,
      dirtyLeft: 4,
      ranWorktreeReclaim: true,
    });
    expect(detail).toContain("removed 3 husk");
    expect(detail).toContain("reclaimed 4 clean");
    expect(detail).toContain("4 dirty");
  });

  it("states skip when reclaim not run", () => {
    const detail = formatWorktreeReclaimReport({
      husksRemoved: 0,
      husksFailed: 0,
      worktreesBefore: 2,
      worktreesAfter: 2,
      dirtyLeft: 0,
      ranWorktreeReclaim: false,
    });
    expect(detail).toContain("skipped clean-worktree reclaim");
  });
});

describe("reclaimWasNoop", () => {
  it("is true when nothing moved", () => {
    expect(reclaimWasNoop({ husksRemoved: 0, worktreesBefore: 5, worktreesAfter: 5 })).toBe(true);
  });

  it("is false when husks or trees dropped", () => {
    expect(reclaimWasNoop({ husksRemoved: 1, worktreesBefore: 5, worktreesAfter: 5 })).toBe(false);
    expect(reclaimWasNoop({ husksRemoved: 0, worktreesBefore: 5, worktreesAfter: 3 })).toBe(false);
  });
});
