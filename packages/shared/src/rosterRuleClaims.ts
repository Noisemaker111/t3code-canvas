/**
 * The roster rule says what a model is for, and how good it is at that. What it
 * may not say is how fast or how expensive it is: this box measures both on
 * every turn, and a typed "Very fast, $$$" is a guess that outranks its own
 * measurements the moment a price or a provider changes.
 *
 * Speed is the worst of the two: it reads as "this finishes sooner", which it
 * never said. A route at 200 tok/s that needs three times the turns lands later
 * and costs more, and only `time/task` and `cost/task` know that.
 *
 * Capability is deliberately *not* stripped. "Amazing at design", "best
 * planner" — a benchmark covers a fraction of the roster on a fraction of the
 * axes, so on everything else the owner's judgment is the only signal there is,
 * and it belongs in the sentence Hermes already reads as the rule. Where a feed
 * does score the model, the bench chip sits on the same row and the two can
 * disagree in the open.
 *
 * The web warns while the owner types; the server strips before Hermes reads,
 * so a rule stored before this existed cannot route either.
 */

export type RuleClaimKind = "speed" | "cost";

/** What already answers each kind, named the way the measured row labels it. */
export const CLAIM_ANSWERED_BY: Record<RuleClaimKind, string> = {
  speed: "tok/s and time/task",
  cost: "cost/task",
};

const CLAIM_PATTERNS: ReadonlyArray<{ kind: RuleClaimKind; pattern: RegExp }> = [
  {
    kind: "speed",
    pattern:
      /\b(?:very\s+|super\s+|really\s+)?(?:fast|fastest|slow|slowest|quick|quickest|speedy|snappy|sluggish|instant|blazing)\b|\btok(?:ens)?\s*\/?\s*s(?:ec|econd)?\b/i,
  },
  {
    kind: "cost",
    pattern:
      /\${1,4}(?!\d)|\b(?:cheap(?:est|er)?|expensive|pricey|costly|budget|premium|burns?\s+quota)\b/i,
  },
];

/** Clause separators an owner actually types between claims. */
const CLAUSE_SPLIT = /\s*[,;·—]\s*|\s+[-–]\s+/;

export type RuleClaim = { readonly kind: RuleClaimKind; readonly text: string };

/**
 * Every clause of the rule that states a fact the box measures, in the order
 * typed. Clause-scoped on purpose: "fast" inside "fast follow-up on review
 * comments" is one clause and goes, while the rest of the sentence survives.
 */
export function measuredClaimsIn(note: string): ReadonlyArray<RuleClaim> {
  return note
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .flatMap((clause) => {
      const hit = CLAIM_PATTERNS.find((claim) => claim.pattern.test(clause));
      return hit ? [{ kind: hit.kind, text: clause }] : [];
    });
}

/**
 * The rule with every measured-fact clause removed. What is left is the part
 * only the owner can know: which work this seat is for, and how good it is at
 * it.
 */
export function stripMeasuredClaims(note: string): string {
  const claims = new Set(measuredClaimsIn(note).map((claim) => claim.text));
  if (claims.size === 0) return note.trim();
  return note
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !claims.has(clause))
    .join(", ");
}
