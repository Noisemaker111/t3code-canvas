/**
 * API list-price (non-subsidized) spend estimates from local CLI session logs.
 * Mirrors OpenUsage: token counts × public list rates — not the subscription bill.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

export type ListCostTotals = {
  readonly todayUsd: number;
  readonly weekUsd: number;
};

type TokenBuckets = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
};

type RateSheet = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

const ANTHROPIC_RATES: Record<string, RateSheet> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

const OPENAI_RATES: Record<string, RateSheet> = {
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  o4: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  default: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
};

const MAX_FILES = 48;
const MAX_SCAN_MS = 1_500;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function estimateUsd(model: string, tokens: TokenBuckets, family: "anthropic" | "openai"): number {
  const lower = model.toLowerCase();
  let rates: RateSheet;
  if (family === "anthropic") {
    const key =
      (["opus", "haiku", "sonnet"] as const).find((name) => lower.includes(name)) ?? "sonnet";
    rates = ANTHROPIC_RATES[key]!;
  } else {
    const key =
      (Object.keys(OPENAI_RATES) as Array<keyof typeof OPENAI_RATES>).find(
        (name) => name !== "default" && lower.includes(name),
      ) ?? "default";
    rates = OPENAI_RATES[key]!;
  }
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite +
      tokens.reasoning * rates.output) /
    1_000_000
  );
}

async function listRecentJsonlFiles(
  roots: ReadonlyArray<string>,
  sinceMs: number,
): Promise<ReadonlyArray<string>> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    await walkJsonl(root, sinceMs, found).catch(() => undefined);
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_FILES).map((entry) => entry.path);
}

async function walkJsonl(
  dir: string,
  sinceMs: number,
  out: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, sinceMs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stat = await NodeFSP.stat(full).catch(() => undefined);
    if (!stat || stat.mtimeMs < sinceMs) continue;
    out.push({ path: full, mtimeMs: stat.mtimeMs });
  }
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sum Claude Code assistant turns from ~/.claude/projects JSONL at list rates. */
export async function sumClaudeListCost(input: {
  readonly homeDir: string;
  readonly nowMs: number;
}): Promise<ListCostTotals | null> {
  const weekAgo = input.nowMs - 7 * 86_400_000;
  const today = dayKey(input.nowMs);
  const roots = [
    NodePath.join(input.homeDir, ".claude", "projects"),
    NodePath.join(input.homeDir, ".config", "claude", "projects"),
  ];
  const files = await listRecentJsonlFiles(roots, weekAgo);
  if (files.length === 0) return null;

  const started = Date.now();
  let todayUsd = 0;
  let weekUsd = 0;
  const seen = new Set<string>();

  for (const file of files) {
    if (Date.now() - started > MAX_SCAN_MS) break;
    const stream = NodeFS.createReadStream(file, { encoding: "utf8" });
    const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line || line[0] !== "{") continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry.type !== "assistant") continue;
        const message = asObject(entry.message);
        if (!message) continue;
        const usage = asObject(message.usage);
        if (!usage) continue;
        const ts = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
        if (!Number.isFinite(ts) || ts < weekAgo) continue;
        const messageId = typeof message.id === "string" ? message.id : "";
        const requestId = typeof entry.requestId === "string" ? entry.requestId : "";
        const dedupe = messageId && requestId ? `${messageId}:${requestId}` : "";
        if (dedupe) {
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
        }
        const model = typeof message.model === "string" ? message.model : "sonnet";
        if (model === "<synthetic>") continue;
        const recorded =
          typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD)
            ? entry.costUSD
            : undefined;
        const cost =
          recorded ??
          estimateUsd(
            model,
            {
              input: num(usage.input_tokens),
              output: num(usage.output_tokens),
              cacheRead: num(usage.cache_read_input_tokens),
              cacheWrite: num(usage.cache_creation_input_tokens),
              reasoning: num(usage.reasoning_tokens),
            },
            "anthropic",
          );
        if (!(cost > 0)) continue;
        weekUsd += cost;
        if (dayKey(ts) === today) todayUsd += cost;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  if (todayUsd <= 0 && weekUsd <= 0) return null;
  return { todayUsd: round2(todayUsd), weekUsd: round2(weekUsd) };
}

function tokenBucketsFromUsage(usage: Record<string, unknown>): TokenBuckets & { total: number } {
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cached_input_tokens),
    cacheWrite: 0,
    reasoning: num(usage.reasoning_output_tokens),
    total: num(usage.total_tokens),
  };
}

function usageDelta(
  total: TokenBuckets & { total: number },
  previous: TokenBuckets & { total: number },
): TokenBuckets & { total: number } {
  return {
    input: Math.max(0, total.input - previous.input),
    output: Math.max(0, total.output - previous.output),
    cacheRead: Math.max(0, total.cacheRead - previous.cacheRead),
    cacheWrite: 0,
    reasoning: Math.max(0, total.reasoning - previous.reasoning),
    total: Math.max(0, total.total - previous.total),
  };
}

/** Sum Codex session token_count deltas from ~/.codex/sessions at list rates. */
export async function sumCodexListCost(input: {
  readonly homeDir: string;
  readonly nowMs: number;
}): Promise<ListCostTotals | null> {
  const weekAgo = input.nowMs - 7 * 86_400_000;
  const today = dayKey(input.nowMs);
  const roots = [
    NodePath.join(input.homeDir, ".codex", "sessions"),
    NodePath.join(input.homeDir, ".config", "codex", "sessions"),
  ];
  const files = await listRecentJsonlFiles(roots, weekAgo);
  if (files.length === 0) return null;

  const started = Date.now();
  let todayUsd = 0;
  let weekUsd = 0;

  for (const file of files) {
    if (Date.now() - started > MAX_SCAN_MS) break;
    const stream = NodeFS.createReadStream(file, { encoding: "utf8" });
    const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
    let sessionModel = "gpt-5";
    let previous: (TokenBuckets & { total: number }) | undefined;
    try {
      for await (const line of lines) {
        if (!line || line[0] !== "{") continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const entryType = typeof entry.type === "string" ? entry.type : "";
        if (entryType === "session_meta") {
          const metaModel =
            stringField(entry, "model") ??
            stringField(entry, "model_id") ??
            stringField(asObject(entry.payload) ?? {}, "model") ??
            stringField(asObject(entry.payload) ?? {}, "model_id");
          if (metaModel) sessionModel = metaModel;
          continue;
        }
        if (entryType === "turn_context") {
          const turnModel =
            stringField(entry, "model") ??
            stringField(entry, "model_id") ??
            stringField(asObject(entry.payload) ?? {}, "model");
          if (turnModel) sessionModel = turnModel;
          continue;
        }
        if (entryType !== "event_msg") continue;
        const payload = asObject(entry.payload);
        if (!payload || payload.type !== "token_count") continue;
        const info = asObject(payload.info);
        const totalUsage = asObject(info?.total_token_usage);
        if (!totalUsage) continue;
        const total = tokenBucketsFromUsage(totalUsage);
        const delta = previous ? usageDelta(total, previous) : total;
        previous = total;
        // Reset / corrupt counters: fall back to absolute totals.
        const pricedBuckets = delta.total > 0 ? delta : total;
        if (pricedBuckets.total <= 0) continue;
        const model =
          stringField(payload, "model") ?? stringField(payload, "model_id") ?? sessionModel;
        const ts = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
        if (!Number.isFinite(ts) || ts < weekAgo) continue;
        const cost = estimateUsd(model, pricedBuckets, "openai");
        if (!(cost > 0)) continue;
        weekUsd += cost;
        if (dayKey(ts) === today) todayUsd += cost;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  if (todayUsd <= 0 && weekUsd <= 0) return null;
  return { todayUsd: round2(todayUsd), weekUsd: round2(weekUsd) };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Attach list-cost resources when totals are available. */
export function listCostResources(totals: ListCostTotals | null): Record<
  string,
  {
    readonly kind: "consumption";
    readonly unit: "USD";
    readonly used: number;
  }
> {
  if (!totals) return {};
  const resources: Record<string, { kind: "consumption"; unit: "USD"; used: number }> = {};
  if (totals.todayUsd > 0) {
    resources.listToday = { kind: "consumption", unit: "USD", used: totals.todayUsd };
  }
  if (totals.weekUsd > 0) {
    resources.listWeek = { kind: "consumption", unit: "USD", used: totals.weekUsd };
  }
  return resources;
}
