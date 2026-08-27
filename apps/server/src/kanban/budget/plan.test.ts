import { describe, expect, it } from "@effect/vitest";

import { resolveBudgetKnobs } from "./knobs.ts";
import { buildBudgetPlan } from "./plan.ts";

describe("retired deterministic budget planner", () => {
  it("never splits prose or chooses execution", () => {
    const result = buildBudgetPlan({
      text: "Fix auth. Also update CSS. Finally investigate the migration.",
      knobs: resolveBudgetKnobs(50),
      threads: [],
      harnesses: [],
      samples: [],
      now: "2026-08-02T00:00:00.000Z",
    });

    expect(result.tasks).toEqual([]);
    expect(result.totals.chargedInputTokens).toBeNull();
    expect(result.summary).toMatch(/Hermes/i);
  });
});
