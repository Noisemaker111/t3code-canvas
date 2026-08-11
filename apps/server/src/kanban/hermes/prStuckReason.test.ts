import { describe, expect, it } from "@effect/vitest";

import {
  isPrReconciliationReason,
  PR_NEEDS_RECONCILIATION,
  shouldForceModelForPrStuck,
} from "./prStuckReason.ts";

describe("isPrReconciliationReason", () => {
  it("matches the semantic reason string", () => {
    expect(isPrReconciliationReason(PR_NEEDS_RECONCILIATION)).toBe(true);
    expect(isPrReconciliationReason(`No actionable change. ${PR_NEEDS_RECONCILIATION}`)).toBe(true);
  });

  it("rejects unrelated skips", () => {
    expect(isPrReconciliationReason("A Prompt is ready for launch.")).toBe(false);
  });
});

describe("shouldForceModelForPrStuck", () => {
  it("forces a model when rules settled without clearing PR", () => {
    expect(
      shouldForceModelForPrStuck({
        semanticReason: PR_NEEDS_RECONCILIATION,
        fingerprintUnchanged: true,
        recheckDue: false,
        rulesSettledWithoutClearingPr: true,
      }),
    ).toBe(true);
  });

  it("does not force for non-PR reasons", () => {
    expect(
      shouldForceModelForPrStuck({
        semanticReason: "A Prompt is ready for launch.",
        fingerprintUnchanged: true,
        recheckDue: false,
        rulesSettledWithoutClearingPr: true,
      }),
    ).toBe(false);
  });

  it("forces when recheck is due on unchanged PR fingerprint", () => {
    expect(
      shouldForceModelForPrStuck({
        semanticReason: PR_NEEDS_RECONCILIATION,
        fingerprintUnchanged: true,
        recheckDue: true,
        rulesSettledWithoutClearingPr: false,
      }),
    ).toBe(true);
  });
});
