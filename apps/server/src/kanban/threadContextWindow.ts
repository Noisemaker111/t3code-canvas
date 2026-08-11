/**
 * Latest context-window snapshot for a thread (server-side routing / fresh-thread policy).
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export type ThreadContextWindow = {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalProcessedTokens: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function deriveContextWindowFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadContextWindow | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") continue;
    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) continue;
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      maxTokens,
      usedPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
    };
  }
  return null;
}

export function readThreadContextWindow(
  projection: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  threadId: string,
): Effect.Effect<ThreadContextWindow | null, never> {
  return projection.getThreadDetailById(ThreadId.make(threadId)).pipe(
    Effect.map((option) => {
      if (Option.isNone(option)) return null;
      return deriveContextWindowFromActivities(option.value.activities);
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}
