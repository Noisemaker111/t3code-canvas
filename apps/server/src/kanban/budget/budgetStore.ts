/**
 * Durable measured table — `<baseDir>/hermes/budget.json`.
 *
 * Samples survive a restart because a floor measured yesterday is still the
 * floor today, and re-measuring costs real tokens. Drift samples live here too
 * so the predicted-vs-actual history outlives the process that made it.
 *
 * @module kanban/budget/budgetStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HermesBudgetDriftSample } from "@t3tools/contracts";

import type { TurnSample } from "./measurements.ts";

const MAX_SAMPLES = 600;
const MAX_DRIFT = 100;

export type BudgetStoreFile = {
  readonly updatedAt: string | null;
  readonly samples: ReadonlyArray<TurnSample>;
  readonly drift: ReadonlyArray<HermesBudgetDriftSample>;
};

const EMPTY: BudgetStoreFile = { updatedAt: null, samples: [], drift: [] };

let filePath: string | null = null;
let cache: BudgetStoreFile = EMPTY;

export function hermesBudgetTablePath(): string | null {
  return filePath;
}

export function bindHermesBudgetStore(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    filePath = NodePath.join(dir, "budget.json");
  } catch {
    filePath = null;
  }
  cache = read();
  return filePath ?? "";
}

/** Test seam and teardown: stop reading and writing a bound path. */
export function unbindHermesBudgetStore(): void {
  filePath = null;
  cache = EMPTY;
}

function read(): BudgetStoreFile {
  if (!filePath) return EMPTY;
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Partial<BudgetStoreFile>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      drift: Array.isArray(parsed.drift) ? parsed.drift : [],
    };
  } catch {
    return EMPTY;
  }
}

export function readBudgetStore(): BudgetStoreFile {
  return cache;
}

function write(next: BudgetStoreFile): void {
  cache = next;
  if (!filePath) return;
  try {
    NodeFS.writeFileSync(filePath, `${JSON.stringify(next)}\n`, "utf8");
  } catch {
    // Persistence is housekeeping; losing it must never break a tick.
  }
}

export function putSamples(samples: ReadonlyArray<TurnSample>, at: string): void {
  write({
    updatedAt: at,
    samples: samples.slice(-MAX_SAMPLES),
    drift: cache.drift,
  });
}

export function appendDriftSample(sample: HermesBudgetDriftSample): void {
  write({
    updatedAt: cache.updatedAt,
    samples: cache.samples,
    drift: [...cache.drift, sample].slice(-MAX_DRIFT),
  });
}

export const BUDGET_SAMPLE_LIMIT = MAX_SAMPLES;
