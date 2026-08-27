/**
 * Turn a thread's recorded `context-window.updated` activities into turn
 * samples. This is the only place the measured table gets its numbers.
 *
 * @module kanban/budget/collector
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

import { estimateTokensFromText, type TurnSample } from "./measurements.ts";

export type ThreadUsageActivity = {
  readonly kind: string;
  readonly createdAt: string;
  readonly turnId: string | null;
  readonly payload: unknown;
};

export type ThreadUsageInput = {
  readonly threadId: string;
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly providerVersion: string | null;
  /** The text of the first user message — what rode along with the floor. */
  readonly firstUserText: string | null;
  readonly activities: ReadonlyArray<ThreadUsageActivity>;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshotOf(payload: unknown): Partial<ThreadTokenUsageSnapshot> | null {
  return payload !== null && typeof payload === "object"
    ? (payload as Partial<ThreadTokenUsageSnapshot>)
    : null;
}

export function turnSamplesFromThread(input: ThreadUsageInput): ReadonlyArray<TurnSample> {
  if (!input.instanceId || !input.model) return [];
  // A streaming turn emits several snapshots; the last one for a turn is the
  // only complete account of it.
  const byTurn = new Map<string, ThreadUsageActivity>();
  let anonymous = 0;
  for (const activity of input.activities) {
    if (activity.kind !== "context-window.updated") continue;
    const key = activity.turnId ?? `anon:${(anonymous += 1)}`;
    byTurn.set(key, activity);
  }
  const ordered = [...byTurn.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const samples: TurnSample[] = [];
  let previousAtMs: number | null = null;
  ordered.forEach((activity, turnIndex) => {
    const usage = snapshotOf(activity.payload);
    if (!usage) return;
    const atMs = Date.parse(activity.createdAt);
    const gapMs =
      previousAtMs !== null && Number.isFinite(atMs) ? Math.max(0, atMs - previousAtMs) : null;
    if (Number.isFinite(atMs)) previousAtMs = atMs;
    samples.push({
      harness: input.instanceId as string,
      model: input.model as string,
      threadId: input.threadId,
      at: activity.createdAt,
      turnIndex,
      gapMs,
      inputTokens: num(usage.lastInputTokens) ?? num(usage.inputTokens),
      cachedInputTokens: num(usage.lastCachedInputTokens) ?? num(usage.cachedInputTokens),
      outputTokens: num(usage.lastOutputTokens) ?? num(usage.outputTokens),
      usedTokens: num(usage.usedTokens),
      maxTokens: num(usage.maxTokens),
      toolUses: num(usage.toolUses),
      durationMs: num(usage.durationMs),
      promptTokens:
        turnIndex === 0 && input.firstUserText ? estimateTokensFromText(input.firstUserText) : null,
      providerVersion: input.providerVersion,
    });
  });
  return samples;
}

/** Newest sample per (thread, turn) wins, so re-reading a thread is idempotent. */
export function mergeTurnSamples(
  existing: ReadonlyArray<TurnSample>,
  incoming: ReadonlyArray<TurnSample>,
  limit: number,
): ReadonlyArray<TurnSample> {
  const key = (sample: TurnSample) => `${sample.threadId}:${sample.turnIndex}`;
  const merged = new Map<string, TurnSample>();
  for (const sample of existing) merged.set(key(sample), sample);
  for (const sample of incoming) merged.set(key(sample), sample);
  return [...merged.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
}
