import { describe, expect, it } from "@effect/vitest";

import { relativeTo } from "./modelEvidence.ts";

/**
 * Nearly all spend on this box is plan quota, so routes are compared as a ratio
 * rather than a bill. The dollars are only the yardstick behind it.
 */
describe("relativeTo", () => {
  const rows = [{ usdPerTask: 0.4 }, { usdPerTask: 0.92 }, { usdPerTask: null }];

  it("makes the cheapest measured route 1 and scales the rest to it", () => {
    expect(relativeTo(rows, 0.4)).toBe(1);
    expect(relativeTo(rows, 0.92)).toBe(2.3);
  });

  it("is null with nothing to compare against", () => {
    expect(relativeTo(rows, null)).toBeNull();
    expect(relativeTo([{ usdPerTask: 0.4 }], 0.4)).toBeNull();
    expect(relativeTo([{ usdPerTask: null }, { usdPerTask: null }], null)).toBeNull();
  });

  it("ignores a zero-cost row rather than dividing by it", () => {
    expect(relativeTo([{ usdPerTask: 0 }, { usdPerTask: 0.4 }, { usdPerTask: 0.8 }], 0.8)).toBe(2);
  });
});
