/**
 * What Hermes spends on itself — `<baseDir>/hermes/usage.jsonl` plus the
 * durable counters in `<baseDir>/hermes/spend.json`.
 *
 * The tick log answers "what did that tick do" and is capped at 30 for that
 * reason. Efficiency is a different question: it needs weeks, not the last
 * half hour. So every tick also writes one small row here — no program, no
 * call payloads — and the file rotates on size instead of on count.
 *
 * @module kanban/hermes/usageLogStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HermesSpend, HermesTickTranscript } from "@t3tools/contracts";

/** Rotate to `usage.jsonl.1` past this; one generation back is kept. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** One tick, flattened. Everything here is a number you can average over. */
export type HermesUsageRow = {
  readonly id: string;
  readonly ranAt: string;
  readonly tier: string | null;
  readonly model: string;
  readonly trigger: string;
  readonly durationMs: number;
  readonly modelMs: number;
  readonly executionMs: number;
  readonly modelCalls: number;
  readonly promptChars: number;
  readonly snapshotChars: number;
  readonly programChars: number;
  readonly calls: number;
  readonly writes: number;
  readonly ruleActions: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usd: number | null;
  readonly provider: string | null;
  readonly failed: boolean;
};

const EMPTY_SPEND: HermesSpend = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  usd: 0,
  measuredCalls: 0,
  unmeasuredCalls: 0,
  modelMs: 0,
};

let usagePath: string | null = null;
let spendPath: string | null = null;

export function hermesUsageLogPath(): string | null {
  return usagePath;
}

export function bindHermesUsageLog(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    usagePath = NodePath.join(dir, "usage.jsonl");
    spendPath = NodePath.join(dir, "spend.json");
  } catch {
    usagePath = null;
    spendPath = null;
  }
  return usagePath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindHermesUsageLog(): void {
  usagePath = null;
  spendPath = null;
}

/** Board-mutating calls that landed. Same rule the tick log counts by. */
function landedWrites(tick: HermesTickTranscript, writeMethods: ReadonlySet<string>): number {
  return tick.calls.filter(
    (call) => writeMethods.has(call.method) && call.error === undefined && call.skipped !== true,
  ).length;
}

export function toUsageRow(
  tick: HermesTickTranscript,
  writeMethods: ReadonlySet<string>,
): HermesUsageRow {
  const cost = tick.cost;
  const usage = cost?.usage;
  return {
    id: tick.id,
    ranAt: tick.ranAt,
    tier: tick.tier,
    model: tick.model,
    trigger: tick.trigger ?? "interval",
    durationMs: tick.durationMs,
    modelMs: cost?.modelMs ?? 0,
    executionMs: cost?.executionMs ?? 0,
    modelCalls: cost?.modelCalls ?? 0,
    promptChars: cost?.promptChars ?? 0,
    snapshotChars: cost?.snapshotChars ?? 0,
    programChars: cost?.programChars ?? 0,
    calls: tick.calls.length,
    writes: landedWrites(tick, writeMethods),
    ruleActions: tick.ruleActions ?? 0,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    usd: usage?.usd ?? null,
    provider: usage?.provider ?? null,
    failed: tick.error !== null,
  };
}

/** The live log and the one rotated generation behind it. */
export function hermesUsageLogPaths(): ReadonlyArray<string> {
  return usagePath === null ? [] : [usagePath, `${usagePath}.1`];
}

/**
 * Drop every usage row, rotation included. Reached only from the Maintenance
 * settings route; `rotate` is the automatic one and it keeps a generation.
 */
export function purgeHermesUsageLog(options?: { readonly dryRun?: boolean }): number {
  let removed = 0;
  for (const path of hermesUsageLogPaths()) {
    try {
      removed += NodeFS.readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    } catch {
      continue;
    }
  }
  if (options?.dryRun === true) return removed;
  if (usagePath) {
    try {
      NodeFS.writeFileSync(usagePath, "", "utf8");
    } catch {
      return removed;
    }
  }
  try {
    NodeFS.rmSync(`${usagePath}.1`, { force: true });
  } catch {
    // A rotation generation that will not unlink is not worth failing the purge.
  }
  return removed;
}

export function appendHermesUsage(row: HermesUsageRow): void {
  if (!usagePath) return;
  try {
    NodeFS.appendFileSync(usagePath, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    return;
  }
  rotate();
}

function rotate(): void {
  if (!usagePath) return;
  try {
    if (NodeFS.statSync(usagePath).size <= MAX_LOG_BYTES) return;
    NodeFS.renameSync(usagePath, `${usagePath}.1`);
  } catch {
    // Rotation is housekeeping; a failure must never break a tick.
  }
}

export function readHermesUsageLog(limit: number): ReadonlyArray<HermesUsageRow> {
  if (!usagePath) return [];
  let raw: string;
  try {
    raw = NodeFS.readFileSync(usagePath, "utf8");
  } catch {
    return [];
  }
  const rows: HermesUsageRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as HermesUsageRow);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
  return rows.slice(-limit);
}

/** Fold one tick's usage into the running totals. */
export function addSpend(spend: HermesSpend, tick: HermesTickTranscript): HermesSpend {
  const cost = tick.cost;
  if (!cost || cost.modelCalls === 0) return spend;
  const usage = cost.usage;
  return {
    inputTokens: spend.inputTokens + (usage?.inputTokens ?? 0),
    cachedInputTokens: spend.cachedInputTokens + (usage?.cachedInputTokens ?? 0),
    outputTokens: spend.outputTokens + (usage?.outputTokens ?? 0),
    usd: spend.usd + (usage?.usd ?? 0),
    measuredCalls: spend.measuredCalls + (usage ? cost.modelCalls : 0),
    unmeasuredCalls: spend.unmeasuredCalls + (usage ? 0 : cost.modelCalls),
    modelMs: spend.modelMs + cost.modelMs,
  };
}

export type HermesSpendFile = {
  readonly since: string;
  readonly spend: HermesSpend;
  readonly counters: Record<string, number>;
  readonly servedByTier: Record<string, number>;
  /** Per-rule fire counts, keyed by tick-log rule id. */
  readonly ruleFires: Record<string, { readonly count: number; readonly lastAt: string }>;
};

export function readHermesSpend(): HermesSpendFile | null {
  if (!spendPath) return null;
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(spendPath, "utf8")) as Partial<HermesSpendFile>;
    if (typeof parsed.since !== "string") return null;
    return {
      since: parsed.since,
      spend: { ...EMPTY_SPEND, ...(parsed.spend ?? {}) },
      counters: parsed.counters ?? {},
      servedByTier: parsed.servedByTier ?? {},
      ruleFires: parsed.ruleFires ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Written after every tick, not on shutdown: the restart worth surviving is
 * the one nobody asked for.
 */
export function writeHermesSpend(file: HermesSpendFile): void {
  if (!spendPath) return;
  try {
    NodeFS.writeFileSync(spendPath, `${JSON.stringify(file)}\n`, "utf8");
  } catch {
    // Losing a counter write must never break a tick.
  }
}

export const emptyHermesSpend = (): HermesSpend => ({ ...EMPTY_SPEND });
