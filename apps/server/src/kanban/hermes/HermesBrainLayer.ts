/**
 * Boot wiring for the Hermes brain.
 *
 * Built in the same runtime slice as the kanban store so it resolves the same
 * projection and provider registry the WS does. It captures
 * the deps into a module global because the HTTP routes are context-free —
 * same shape as `getHermesStatus` / `reportHermesBeat`.
 *
 * The loop starts only when `boardSettings.hermesBrainEnabled` is true, and
 * stops the moment it is switched back off.
 *
 * @module kanban/hermes/HermesBrainLayer
 */
import type { BoardSettings } from "@t3tools/contracts";
import { boardRulePolicy } from "@t3tools/shared/boardRules";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CanvasStore } from "../../canvas/CanvasStore.ts";
import { KanbanStore } from "../KanbanStore.ts";
import { launchWorktreePreparerOption } from "../launchWorktree.ts";
import { projectSetupScriptRunnerOption } from "../../project/ProjectSetupScriptRunner.ts";
import { makeCursorHermesBackend, makeXaiHermesBackend } from "./acpBackends.ts";
import { endHermesSessions, hermesTransportClaims, type HermesBackend } from "./backend.ts";
import { makeCodexHermesBackend } from "./codexBackend.ts";
import { hermesLegacySelectionPatch } from "./legacySelectionMigration.ts";
import {
  restoreHermesBoardFailures,
  restoreHermesConversation,
  restoreHermesSpend,
  restoreHermesTickLog,
  setHermesBoardConfig,
  startHermesBrainLoop,
  type HermesBrainDeps,
} from "./HermesBrain.ts";
import { PR_WATCH_INTERVAL_MS, reconcileOpenPrs } from "./prWatch.ts";
import { bindHermesChat, restoreHermesChat } from "./chatStore.ts";
import { bindHermesConversation } from "./conversationStore.ts";
import { bindHermesHelpers, restoreHermesHelpers } from "./helperStore.ts";
import { bindHermesTickLog } from "./tickLogStore.ts";
import { bindHermesUsageLog } from "./usageLogStore.ts";
import { sharedLaunchPreflight } from "../../health/preflight.ts";
import { makeLiveBoardApi } from "./liveBoardApi.ts";
import { bindBoardMoments } from "../components/moments.ts";
import { makeBoardMoments } from "../components/live.ts";
import { rulePolicy } from "./rulePass.ts";
import { syncHermesMcpServers } from "./mcpRegistry.ts";
import { makeOpenRouterHermesBackend } from "./openrouterBackend.ts";
import { makeHermesOperationStore } from "./operationStore.ts";
import { bindFrictionSweep } from "../../friction/detector.ts";
import { runFrictionSweep } from "../../friction/sweep.ts";
import { recordDegradation } from "../../health/incidentLog.ts";

/** Cheap enough to run often; the watermark keeps each pass proportional. */
const FRICTION_SWEEP_INTERVAL = "5 minutes";

class OrphanPrWatchError extends Data.TaggedError("OrphanPrWatchError")<{
  readonly cause: unknown;
}> {}
import type { BudgetDeps } from "../budget/BudgetService.ts";
import { bindHermesBudgetStore } from "../budget/budgetStore.ts";
import type { ThreadUsageInput } from "../budget/collector.ts";
import { hermesTickHealth } from "./HermesBrain.ts";

let deps: HermesBrainDeps | null = null;
let budgetDeps: BudgetDeps | null = null;

/** Set by the layer. Null before it builds, or in a boot without Hermes wired. */
let applyHermesSwitch: ((board: BoardSettings) => void) | null = null;

/**
 * Start/stop the loop for these board settings, now, on the caller's fiber.
 * The settings-change watcher calls the same function; both are idempotent, so
 * a route can make the switch take effect before it answers instead of racing
 * the watcher and reporting `running: false` on a loop that is about to start.
 */
export function applyHermesBrainSwitch(board: BoardSettings): void {
  applyHermesSwitch?.(board);
}

/** Null until the layer has built. Routes answer 503-ish rather than crashing. */
export function getHermesBrainDeps(): HermesBrainDeps | null {
  return deps;
}

export function getHermesBudgetDeps(): BudgetDeps | null {
  return budgetDeps;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* KanbanStore;
    const canvas = yield* CanvasStore;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const crypto = yield* Crypto.Crypto;
    const clock = yield* Clock.Clock;
    const fileSystem = yield* FileSystem.FileSystem;
    const worktree = yield* launchWorktreePreparerOption;
    const setupScript = yield* projectSetupScriptRunnerOption;
    const settings = yield* serverSettings.getSettings;
    const operations = yield* makeHermesOperationStore;

    // Runs whether or not the brain is wired below: friction an agent hit is
    // worth recording even on a box where Hermes cannot start.
    const frictionBaseDir = (yield* ServerConfig.ServerConfig).baseDir;
    bindFrictionSweep(frictionBaseDir);
    yield* Effect.forkScoped(
      runFrictionSweep().pipe(
        Effect.catchCause((cause) => Effect.logWarning("friction sweep failed", cause)),
        Effect.repeat(Schedule.spaced(FRICTION_SWEEP_INTERVAL)),
      ),
    );

    // Optional so a runtime slice without git or a provider session (tests,
    // trimmed boots) cannot fail server start — Hermes just stays unwired.
    const gitWorkflow = yield* Effect.serviceOption(GitWorkflowService.GitWorkflowService);
    const sourceControl = yield* Effect.serviceOption(
      SourceControlProviderRegistry.SourceControlProviderRegistry,
    );
    const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
    const providerService = yield* Effect.serviceOption(ProviderService.ProviderService);
    const workspaceEntries = yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries);
    const childProcessSpawner = yield* Effect.serviceOption(
      ChildProcessSpawner.ChildProcessSpawner,
    );
    if (
      Option.isNone(gitWorkflow) ||
      Option.isNone(sourceControl) ||
      Option.isNone(git) ||
      Option.isNone(providerService) ||
      Option.isNone(workspaceEntries) ||
      Option.isNone(childProcessSpawner)
    ) {
      yield* Effect.logInfo("hermes brain not wired: missing git, provider or workspace services");
      return;
    }

    const config = yield* ServerConfig.ServerConfig;
    bindHermesTickLog(config.baseDir);
    bindHermesUsageLog(config.baseDir);
    bindHermesBudgetStore(config.baseDir);
    bindHermesConversation(config.baseDir);
    bindHermesChat(config.baseDir);
    bindHermesHelpers(config.baseDir);
    restoreHermesTickLog();
    restoreHermesChat();
    restoreHermesHelpers();
    restoreHermesSpend();
    restoreHermesBoardFailures();

    // Cards parked on a spent retry budget are the ones a restart is meant to
    // pick back up, so clear it before the first tick reads the board.
    const rearmed = yield* Effect.promise(() => operations.rearmForRetry());
    if (rearmed > 0) {
      yield* Effect.logInfo("hermes rearmed failed board operations for retry", { rearmed });
    }

    const api = makeLiveBoardApi({
      store,
      canvas,
      orchestrationEngine,
      projection,
      serverSettings,
      workspaceEntries: workspaceEntries.value,
      crypto: { randomUUIDv4: crypto.randomUUIDv4.pipe(Effect.orDie) },
      listProviders: providerRegistry.getProviders,
      gitWorkflow: gitWorkflow.value,
      sourceControl: sourceControl.value,
      git: git.value,
      providerService: providerService.value,
      worktree,
      preflight: sharedLaunchPreflight(config.stateDir),
      setupScript,
    });

    // Hermes never edits files; the ACP session's cwd is only where the CLI runs.
    const acpDeps = {
      childProcessSpawner: childProcessSpawner.value,
      crypto,
      cwd: process.cwd(),
      runPromise: <A>(effect: Effect.Effect<A, unknown, never>) =>
        Effect.runPromise(effect as Effect.Effect<A, never, never>),
    };
    const backends: ReadonlyArray<HermesBackend> = [
      makeCursorHermesBackend(acpDeps, settings.providers.cursor),
      makeXaiHermesBackend(acpDeps, settings.providers.grok),
      makeCodexHermesBackend(
        {
          ...acpDeps,
          codexAuthExists: (path: string) => acpDeps.runPromise(fileSystem.exists(path)),
        },
        settings.providers.codex,
      ),
      makeOpenRouterHermesBackend(),
    ];

    // After the backends exist: a restored conversation hands its CLI session
    // id back to the transport that owns it, so a restart reattaches to the
    // agent still holding this history instead of re-sending it.
    restoreHermesConversation(backends);

    const legacyPatch = hermesLegacySelectionPatch({
      instanceId: settings.boardSettings.hermesBrainInstanceId,
      model: settings.boardSettings.hermesBrainModel,
      order: settings.boardSettings.hermesBrainTierOrder,
      disabled: settings.boardSettings.hermesBrainDisabledTiers,
      transports: hermesTransportClaims(backends),
    });
    const boardSettingsAtBoot = legacyPatch
      ? (yield* serverSettings
          .updateSettings({ boardSettings: { ...settings.boardSettings, ...legacyPatch } })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("hermes brain selection migrated off the legacy tier chain", {
                ...legacyPatch,
              }),
            ),
          )).boardSettings
      : settings.boardSettings;

    const readBoardSettings = () =>
      Effect.runPromise(serverSettings.getSettings.pipe(Effect.map((s) => s.boardSettings)));

    // Arrivals and departures run the same rules the tick runs, through the
    // same api, so a drag and a heartbeat cannot disagree about what a
    // component does. `readBoardSettings` above is the reader; a second one
    // here would be a second answer to the same question.
    bindBoardMoments(
      makeBoardMoments({
        api,
        settings: readBoardSettings,
        // `live.ts` runs outside Effect, so the clock crosses the seam here.
        now: () => clock.currentTimeMillisUnsafe(),
        policy: (current) => {
          const resolved = rulePolicy(current);
          return {
            finishActive: resolved.autoFinishActive,
            mergeWhenGreen: resolved.autoMergeWhenGreen,
            conflictReturn: resolved.conflictReturn,
          };
        },
      }),
    );

    const listProviders = () =>
      Effect.runPromise(
        providerRegistry.getProviders.pipe(
          Effect.map((providers) =>
            providers.map((provider) => ({
              instanceId: String(provider.instanceId),
              version: provider.version,
              enabled: provider.enabled,
              installed: provider.installed,
              auth: provider.auth,
              models: provider.models.map((model) => ({ slug: model.slug, name: model.name })),
            })),
          ),
        ),
      );

    // The measuring instrument: a thread's own token snapshots, read from the
    // projection. Nothing is launched to obtain them.
    const readThreadUsage = async (threadId: string): Promise<ThreadUsageInput | null> => {
      const providers = await listProviders().catch(() => []);
      const versions = new Map(
        providers.map((provider) => [provider.instanceId, provider.version]),
      );
      return Effect.runPromise(
        projection.getThreadDetailById(threadId as never).pipe(
          Effect.map((detail) => {
            if (Option.isNone(detail)) return null;
            const thread = detail.value;
            const instanceId = thread.modelSelection
              ? String(thread.modelSelection.instanceId)
              : null;
            const firstUser =
              thread.messages.find((message) => message.role === "user")?.text ?? null;
            return {
              threadId,
              instanceId,
              model: thread.modelSelection?.model ?? null,
              providerVersion: instanceId ? (versions.get(instanceId) ?? null) : null,
              firstUserText: firstUser,
              activities: thread.activities.map((activity) => ({
                kind: activity.kind,
                createdAt: String(activity.createdAt),
                turnId: activity.turnId === null ? null : String(activity.turnId),
                payload: activity.payload,
              })),
            } satisfies ThreadUsageInput;
          }),
          Effect.orElseSucceed(() => null),
        ),
      );
    };

    budgetDeps = {
      api,
      boardSettings: readBoardSettings,
      listProviders,
      readThreadUsage,
      tickHealth: hermesTickHealth,
    };

    deps = {
      api,
      backends,
      boardSettings: readBoardSettings,
      providerDrivers: () =>
        Effect.runPromise(
          serverSettings.getSettings.pipe(
            Effect.map((current) =>
              Object.fromEntries(
                Object.entries(current.providerInstances ?? {}).map(([id, config]) => [
                  id,
                  String(config.driver),
                ]),
              ),
            ),
          ),
        ),
      budget: budgetDeps,
      operations,
      preflight: sharedLaunchPreflight(config.stateDir),
      attachmentsDir: config.attachmentsDir,
    };

    // Forge projection is infrastructure, not model judgment. It runs even
    // while Hermes is disabled so externally opened PRs still reach the board.
    const reconcilePrs = Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        Effect.tryPromise({
          try: () => reconcileOpenPrs(api, nowMs),
          catch: (cause) => new OrphanPrWatchError({ cause }),
        }),
      ),
      Effect.catchTag("OrphanPrWatchError", (error) =>
        Effect.sync(() => {
          recordDegradation({
            id: "kanban.orphan-pr-watch",
            title: "Open PR projection could not refresh",
            detail: error.cause instanceof Error ? error.cause.message : String(error.cause),
          });
        }),
      ),
    );
    yield* reconcilePrs.pipe(
      Effect.repeat(Schedule.spaced(PR_WATCH_INTERVAL_MS)),
      Effect.forkScoped,
    );

    let stop: (() => void) | null = null;
    let runningIntervalMs: number | null = null;
    const applySwitch = (board: BoardSettings) => {
      const { hermesBrainEnabled: enabled, hermesBrainIntervalMs: intervalMs } = board;
      setHermesBoardConfig({
        enabled,
        intervalMs,
        model: board.hermesBrainModel,
        // Every gate off means the loop will tick and move nothing. The chip
        // says so rather than showing a healthy green while nothing happens.
        pipelineIdle: (() => {
          const rules = boardRulePolicy(board);
          return !rules.structureDrafts && !rules.launchPrompts;
        })(),
      });
      if (!enabled) {
        stop?.();
        stop = null;
        runningIntervalMs = null;
        // A brain that is off holds no CLI open waiting for a tick that is
        // never coming.
        void endHermesSessions(backends);
        return;
      }
      // A changed interval has to restart the loop; otherwise the panel shows
      // 30s while the timer is still on the old value.
      if (stop && runningIntervalMs === intervalMs) return;
      stop?.();
      stop = startHermesBrainLoop(deps as HermesBrainDeps, { intervalMs });
      runningIntervalMs = intervalMs;
    };

    applyHermesSwitch = applySwitch;
    applySwitch(boardSettingsAtBoot);

    // Dial the outbound MCP servers before the first tick builds its prompt.
    // Forked: a server that takes its time must not hold up server start, and
    // one that never answers is recorded as an incident, not swallowed.
    const syncMcp = (board: BoardSettings) =>
      Effect.promise(() => syncHermesMcpServers(board.hermesMcpServers));
    yield* Effect.forkScoped(syncMcp(settings.boardSettings));

    // forkScoped, not forkChild: a child fiber is interrupted the moment the
    // layer's build effect returns, which left the switch applied once at boot
    // and never again — toggling Hermes wrote settings.json and started nothing.
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((next) =>
        Effect.sync(() => applySwitch(next.boardSettings)).pipe(
          Effect.andThen(syncMcp(next.boardSettings)),
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("hermes settings watcher stopped", cause)),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stop?.();
        stop = null;
        applyHermesSwitch = null;
      }).pipe(Effect.andThen(Effect.promise(() => endHermesSessions(backends)))),
    );
  }),
);
