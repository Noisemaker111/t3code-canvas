import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export interface TurnMetrics {
  /** Output tokens the harness attributed to this turn, if reported. */
  readonly outputTokens: number | null;
  /** Wall-clock duration the harness reported for this turn, if any. */
  readonly durationMs: number | null;
}

/**
 * Build a per-turn metrics map from context-window snapshots so an assistant
 * response can show the tokens and time its turn took. Harnesses emit these
 * snapshots keyed by turn; the latest snapshot for a turn wins (activities are
 * in ascending order). Output tokens prefer the per-turn `last*` field; when a
 * provider only reports cumulative totals, the turn's share is the delta since
 * the previous turn's last snapshot — never the raw cumulative value, and
 * never `usedTokens` (that is context-window size, not this turn's output).
 */
export function deriveTurnMetrics(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, TurnMetrics> {
  const result = new Map<string, TurnMetrics>();
  let lastTurnId: string | null = null;
  let cumulativeOutputAtPreviousTurnEnd: number | null = null;
  let lastCumulativeOutput: number | null = null;
  for (const activity of activities) {
    if (activity.kind !== "context-window.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const cumulativeOutput = asFiniteNumber(payload?.outputTokens);
    if (activity.turnId != null) {
      if (activity.turnId !== lastTurnId) {
        cumulativeOutputAtPreviousTurnEnd = lastCumulativeOutput;
        lastTurnId = activity.turnId;
      }
      const cumulativeDelta =
        cumulativeOutput !== null
          ? cumulativeOutputAtPreviousTurnEnd !== null
            ? cumulativeOutput >= cumulativeOutputAtPreviousTurnEnd
              ? cumulativeOutput - cumulativeOutputAtPreviousTurnEnd
              : null
            : cumulativeOutput
          : null;
      const outputTokens = asFiniteNumber(payload?.lastOutputTokens) ?? cumulativeDelta;
      const durationMs = asFiniteNumber(payload?.durationMs);
      result.set(activity.turnId, { outputTokens, durationMs });
    }
    if (cumulativeOutput !== null) {
      lastCumulativeOutput = cumulativeOutput;
    }
  }
  return result;
}

export interface MessageMetrics {
  /** Tokens in this message's own text, BPE-counted at ingestion. */
  readonly tokens: number;
}

/**
 * Per-message token counts from `message.metrics` activities the server stamps
 * when an assistant message completes — the only source that attributes tokens
 * to an individual message rather than a whole turn.
 */
export function deriveMessageMetrics(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, MessageMetrics> {
  const result = new Map<string, MessageMetrics>();
  for (const activity of activities) {
    if (activity.kind !== "message.metrics") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
    const tokens = asFiniteNumber(payload?.tokens);
    if (messageId && tokens !== null && tokens > 0) {
      result.set(messageId, { tokens });
    }
  }
  return result;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
