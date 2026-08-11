/** Client for `/api/hermes/budget` — measured table, the slider, and dry-run plans. */
import type { HermesBudgetPlan, HermesBudgetStatus } from "@t3tools/contracts";

async function json<A>(input: string, init?: RequestInit): Promise<A> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${input} failed (${response.status})`);
  }
  return (await response.json()) as A;
}

export const fetchHermesBudgetStatus = (): Promise<HermesBudgetStatus> =>
  json<HermesBudgetStatus>("/api/hermes/budget");

export const configureHermesBudget = (payload: {
  enabled?: boolean;
  position?: number;
}): Promise<HermesBudgetStatus> =>
  json<HermesBudgetStatus>("/api/hermes/budget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

/** Re-read live threads into the measured table. Writes no board state. */
export const measureHermesBudget = (): Promise<{
  threads: number;
  samples: number;
  status: HermesBudgetStatus;
}> => json("/api/hermes/budget/measure", { method: "POST" });

/** Dry run: what this text would cost, split and placed. Writes nothing. */
export const planHermesBudget = (text: string): Promise<HermesBudgetPlan> =>
  json<HermesBudgetPlan>("/api/hermes/budget/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

export function formatBudgetTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < 1000) return `${Math.round(value)}`;
  return `${Math.round(value / 100) / 10}k`;
}

export function formatBudgetUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function budgetPositionLabel(position: number): string {
  if (position <= 20) return "Cheapest";
  if (position <= 45) return "Lean";
  if (position <= 60) return "Balanced";
  if (position <= 80) return "Quick";
  return "Fastest";
}
