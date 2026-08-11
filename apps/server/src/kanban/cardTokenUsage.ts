/**
 * Roll a thread's `context-window.updated` snapshots up into the one number a
 * card carries: what this card cost to work.
 *
 * @module kanban/cardTokenUsage
 */
import type { KanbanCardTokenUsage, ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type CardUsageSnapshotRow = {
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
};

const decodeInstant = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString);

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function snapshotOf(payload: unknown): Partial<ThreadTokenUsageSnapshot> | null {
  return payload !== null && typeof payload === "object"
    ? (payload as Partial<ThreadTokenUsageSnapshot>)
    : null;
}

/**
 * A streaming turn emits several snapshots; only the last one for a turn is a
 * complete account of it. Snapshots with no turn id each stand alone, matching
 * how the budget collector reads the same rows.
 */
function newestPerTurn(
  rows: ReadonlyArray<CardUsageSnapshotRow>,
): ReadonlyArray<CardUsageSnapshotRow> {
  const byTurn = new Map<string, CardUsageSnapshotRow>();
  let anonymous = 0;
  for (const row of rows) {
    const key = row.turnId ?? `anon:${(anonymous += 1)}`;
    const held = byTurn.get(key);
    if (!held || held.createdAt.localeCompare(row.createdAt) <= 0) byTurn.set(key, row);
  }
  return [...byTurn.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Providers report either per-turn deltas (`last*`) or a running cumulative
 * total. Summing a cumulative field across turns would multiply it, so the two
 * shapes are read differently: deltas add up, cumulative is read off the newest
 * snapshot alone.
 */
export function rollUpCardTokenUsage(
  rows: ReadonlyArray<CardUsageSnapshotRow>,
): KanbanCardTokenUsage | null {
  const turns = newestPerTurn(rows);
  if (turns.length === 0) return null;

  let input = 0;
  let cached = 0;
  let output = 0;
  let sawDelta = false;
  for (const turn of turns) {
    const usage = snapshotOf(turn.payload);
    if (!usage) continue;
    const turnInput = num(usage.lastInputTokens);
    const turnCached = num(usage.lastCachedInputTokens);
    const turnOutput = num(usage.lastOutputTokens);
    if (turnInput === null && turnCached === null && turnOutput === null) continue;
    sawDelta = true;
    input += turnInput ?? 0;
    cached += turnCached ?? 0;
    output += turnOutput ?? 0;
  }

  const newest = turns[turns.length - 1];
  if (!sawDelta) {
    const usage = snapshotOf(newest?.payload);
    input = num(usage?.inputTokens) ?? 0;
    cached = num(usage?.cachedInputTokens) ?? 0;
    output = num(usage?.outputTokens) ?? 0;
    if (input === 0 && output === 0) {
      const processed = num(usage?.totalProcessedTokens) ?? num(usage?.usedTokens);
      if (processed === null) return null;
      input = processed;
    }
  }

  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
    turns: turns.length,
    updatedAt: newest ? decodeInstant(newest.createdAt) : null,
  };
}
