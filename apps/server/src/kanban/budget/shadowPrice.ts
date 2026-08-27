/**
 * Shadow price of a subscription harness: what spending its quota *now* is
 * worth giving up, on a 0..1 scale. 0 = the quota would evaporate unused at
 * the next reset, so the model is effectively free; 1 = the cap is binding.
 *
 * Subscription quota does not roll over. Near a reset with headroom, even the
 * most expensive model on the plan costs nothing real — that is the whole
 * reason this number exists. Pure; time and rates come from the caller.
 *
 * @module kanban/budget/shadowPrice
 */
import type { UsageProvider, UsageResource } from "../../usage/UsageService.ts";

export type QuotaWindow = {
  readonly id: string;
  readonly utilization: number;
  readonly resetsAt: string | null;
};

/** Nominal window lengths, for scaling risk when no burn rate is measured. */
const WINDOW_HOURS: Readonly<Record<string, number>> = {
  session: 5,
  daily: 24,
  weekly: 168,
  weeklyOpus: 168,
  monthly: 720,
};

/** Windows that meter only a plan's top-tier models, keyed by model-slug test. */
const TOP_TIER_MODEL = /\b(opus|fable)\b/i;

/**
 * The consumption windows that bind this model. A top-tier bucket
 * (`weeklyOpus`) binds only top-tier models; every other limited window binds
 * everything on the family.
 */
export function quotaWindowsForModel(
  provider: Pick<UsageProvider, "resources"> | undefined,
  model: string,
): ReadonlyArray<QuotaWindow> {
  if (!provider) return [];
  const windows: QuotaWindow[] = [];
  for (const [id, resource] of Object.entries(provider.resources)) {
    if (!isLimitedWindow(resource)) continue;
    if (id === "weeklyOpus" && !TOP_TIER_MODEL.test(model)) continue;
    windows.push({
      id,
      utilization: resource.utilization as number,
      resetsAt: resource.resetsAt ?? null,
    });
  }
  return windows;
}

// Uncapped spend counters (list-price USD) carry no utilization, so requiring
// one keeps meters out and caps in.
function isLimitedWindow(resource: UsageResource): boolean {
  return (
    resource.kind === "consumption" &&
    typeof resource.utilization === "number" &&
    Number.isFinite(resource.utilization)
  );
}

export type ShadowPrice = {
  /** 0..1 — 0 free (quota strands at reset), 1 cap-binding. */
  readonly price: number;
  /** Which window bound and why, for plan basis lines. */
  readonly detail: string;
};

/**
 * Price one model's quota spend. Per window:
 * - burn rate known: spending is free while the projected utilization at reset
 *   stays under 1 — the unspent remainder would strand. Price rises with how
 *   much of the remaining headroom the burn will actually consume.
 * - burn rate unknown: scale utilization by the fraction of the window left,
 *   from its nominal length.
 * - no reset clock: the utilization stands as the price.
 * The binding window (max price) wins. Null when nothing is measured.
 */
export function shadowPrice(input: {
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly nowMs: number;
  readonly burnRatePerHour?: (windowId: string) => number | null;
}): ShadowPrice | null {
  let binding: ShadowPrice | null = null;
  for (const window of input.windows) {
    const utilization = Math.max(0, Math.min(1, window.utilization));
    const hoursToReset = hoursUntil(window.resetsAt, input.nowMs);
    const burn = input.burnRatePerHour?.(window.id) ?? null;

    let price: number;
    let why: string;
    if (hoursToReset === null) {
      price = utilization;
      why = `${window.id} ${percent(utilization)} (no reset clock)`;
    } else if (burn !== null && burn > 0) {
      const headroom = 1 - utilization;
      const projectedSpend = burn * hoursToReset;
      price = headroom <= 0 ? 1 : utilization * Math.min(1, projectedSpend / headroom);
      why = `${window.id} ${percent(utilization)}, burn ${percent(burn)}/h, resets ${hours(hoursToReset)}`;
    } else {
      const nominal = WINDOW_HOURS[window.id] ?? 168;
      price = utilization * Math.min(1, hoursToReset / nominal);
      why = `${window.id} ${percent(utilization)}, resets ${hours(hoursToReset)} (burn unmeasured)`;
    }
    if (!binding || price > binding.price) binding = { price, detail: why };
  }
  return binding;
}

function hoursUntil(resetsAt: string | null, nowMs: number): number | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, (target - nowMs) / 3_600_000);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function hours(value: number): string {
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}m`;
  if (value < 48) return `${Math.round(value)}h`;
  return `${Math.round(value / 24)}d`;
}
