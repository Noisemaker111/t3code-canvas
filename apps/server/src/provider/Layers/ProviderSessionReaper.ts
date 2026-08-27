import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { recordStuckTurn } from "../../health/incidentLog.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How long a turn may show no sign of life before it is treated as wedged.
 * Deliberately generous: a long build or test run is silent, and killing real
 * work is worse than a stuck thread. Measured against the newest of every
 * signal there is, so it only fires when *nothing* has moved.
 */
const DEFAULT_STUCK_TURN_THRESHOLD_MS = 45 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly stuckTurnThresholdMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const stuckTurnThresholdMs = Math.max(
      1,
      options?.stuckTurnThresholdMs ?? DEFAULT_STUCK_TURN_THRESHOLD_MS,
    );

    /**
     * The newest sign of life for a thread: the session binding, the session
     * record, and every message and activity on it. A turn is only wedged when
     * all of them are old.
     */
    const lastSignOfLifeMs = (
      bindingLastSeenMs: number,
      sessionUpdatedAt: string | null | undefined,
      threadDetail: Option.Option<{
        readonly messages: ReadonlyArray<{ readonly createdAt: unknown }>;
        readonly activities: ReadonlyArray<{ readonly createdAt: unknown }>;
      }>,
    ): number => {
      const stamps = [bindingLastSeenMs, Date.parse(String(sessionUpdatedAt ?? ""))];
      const detail = Option.getOrUndefined(threadDetail);
      for (const entry of [...(detail?.messages ?? []), ...(detail?.activities ?? [])]) {
        stamps.push(Date.parse(String(entry.createdAt)));
      }
      const finite = stamps.filter((value) => Number.isFinite(value));
      return finite.length > 0 ? Math.max(...finite) : bindingLastSeenMs;
    };

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          // An active turn is never reaped for inactivity — but nothing else
          // settles one that wedged, either: the startup sweep only runs at
          // boot, so a provider that died mid-turn leaves the thread
          // "Working for…" forever, holding its slot and its budget.
          const session = thread.session;
          const detail = yield* projectionSnapshotQuery
            .getThreadDetailById(binding.threadId)
            .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
          const silentForMs = now - lastSignOfLifeMs(lastSeenMs, session.updatedAt, detail);

          if (silentForMs < stuckTurnThresholdMs) {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId: session.activeTurnId,
              idleDurationMs,
              silentForMs,
            });
            continue;
          }

          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const minutes = Math.round(silentForMs / 60_000);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`reaper:stuck-turn:${yield* crypto.randomUUIDv4}`),
            threadId: binding.threadId,
            session: {
              ...session,
              status: "interrupted",
              activeTurnId: null,
              lastError: `The turn showed no sign of life for ${minutes} minutes and was stopped.`,
              updatedAt: nowIso,
            },
            createdAt: nowIso,
          });
          yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.stuck-stop-failed", {
                threadId: binding.threadId,
                cause,
              }),
            ),
          );
          recordStuckTurn({
            at: nowIso,
            threadId: String(binding.threadId),
            silentForMs,
          });
          yield* Effect.logWarning("provider.session.turn.stuck", {
            threadId: binding.threadId,
            activeTurnId: session.activeTurnId,
            silentForMs,
            thresholdMs: stuckTurnThresholdMs,
          });
          reapedCount += 1;
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
