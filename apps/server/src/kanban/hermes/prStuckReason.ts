/**
 * Pure helpers for Hermes heartbeat when PR cards are stuck after rules.
 */

export const PR_NEEDS_RECONCILIATION = "A pull request card needs reconciliation.";

/** Skip / reason text that means rules left a PR card unresolved. */
export function isPrReconciliationReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.includes("pull request card needs reconciliation");
}

/**
 * When the board still has PR cards after the rule pass settled the same
 * fingerprint, Hermes must not stay model-skipped forever: force a model tick
 * so something can merge, sync, or ask for help.
 */
export function shouldForceModelForPrStuck(input: {
  readonly semanticReason: string | null;
  readonly fingerprintUnchanged: boolean;
  readonly recheckDue: boolean;
  /** True when the deterministic rule pass already ran this beat and made no card progress. */
  readonly rulesSettledWithoutClearingPr: boolean;
}): boolean {
  if (!isPrReconciliationReason(input.semanticReason)) return false;
  if (input.rulesSettledWithoutClearingPr) return true;
  // Unchanged fingerprint past recheck window also escalates.
  return input.fingerprintUnchanged && input.recheckDue;
}
