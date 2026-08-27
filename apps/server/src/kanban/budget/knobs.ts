/**
 * The budget slider, expanded into knobs the router can act on.
 *
 * These are policy, not measurement: the slider says how the user wants the
 * measured numbers spent. Every knob is concrete and testable — a slider that
 * maps to a vibe cannot show its own consequence.
 *
 * @module kanban/budget/knobs
 */
import type { HermesBudgetKnobs } from "@t3tools/contracts";

export function clampBudgetPosition(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function lerp(position: number, atZero: number, atHundred: number): number {
  return Math.round(atZero + ((atHundred - atZero) * position) / 100);
}

export function resolveBudgetKnobs(rawPosition: number): HermesBudgetKnobs {
  const position = clampBudgetPosition(rawPosition);
  return {
    position,
    maxCostTier: position <= 20 ? 1 : position <= 50 ? 2 : position <= 80 ? 3 : 4,
    preferFastVariant: position >= 60,
    // Splitting buys parallelism and pays one session floor per task, so the
    // cheap end merges and the fast end separates.
    splitEagerness: position / 100,
    // Same-topic segments batch into one task at any position — the cheap end
    // just needs less overlap to call two segments the same topic.
    clusterOverlapFloor: lerp(position, 25, 45) / 100,
    reuseOverlapFloor: 0.18,
    heavyFloorTokens: 10_000,
    reuseContextCeilingPercent: lerp(position, 70, 25),
    hardFreshCeilingPercent: lerp(position, 90, 60),
    payHeavySessionFloor: position >= 35,
  };
}
