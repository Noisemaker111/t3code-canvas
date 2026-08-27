/**
 * A ceiling on what the board brain may spend on itself.
 *
 * The budget slider decides *which* model a task gets; nothing decided how much
 * Hermes may spend in total, so a loop that re-reads the same board every
 * minute had no upper bound but the month's bill.
 *
 * Over the cap, the model half of a tick stops and the rule pass keeps running:
 * merges, requeues and stuck-prep resets are deterministic and free, so the
 * board still moves while the spending stops.
 *
 * @module kanban/hermes/spendCap
 */
import { readHermesUsageLog } from "./usageLogStore.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** The window only needs the recent tail; the log itself holds weeks. */
const SCAN_ROWS = 5_000;

export interface SpendCapState {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly blocked: boolean;
  /** Rendered verbatim as the tick's skip reason. */
  readonly reason: string | null;
}

export function spendInWindowUsd(
  rows: ReadonlyArray<{ readonly ranAt: string; readonly usd: number | null }>,
  nowMs: number,
  windowMs: number = WINDOW_MS,
): number {
  const floor = nowMs - windowMs;
  let total = 0;
  for (const row of rows) {
    const at = Date.parse(row.ranAt);
    if (!Number.isFinite(at) || at < floor) continue;
    if (typeof row.usd === "number" && Number.isFinite(row.usd)) total += row.usd;
  }
  return total;
}

export function evaluateSpendCap(input: {
  readonly capUsd: number;
  readonly nowMs: number;
  readonly rows?: ReadonlyArray<{ readonly ranAt: string; readonly usd: number | null }>;
  readonly windowMs?: number;
}): SpendCapState {
  const capUsd = Number.isFinite(input.capUsd) ? Math.max(0, input.capUsd) : 0;
  if (capUsd <= 0) {
    return { capUsd: 0, spentUsd: 0, blocked: false, reason: null };
  }
  const rows = input.rows ?? readHermesUsageLog(SCAN_ROWS);
  const spentUsd = spendInWindowUsd(rows, input.nowMs, input.windowMs ?? WINDOW_MS);
  if (spentUsd < capUsd) {
    return { capUsd, spentUsd, blocked: false, reason: null };
  }
  return {
    capUsd,
    spentUsd,
    blocked: true,
    reason:
      `daily spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} in the last 24h — ` +
      "rules still run, the model does not until the window rolls off or the cap is raised",
  };
}
