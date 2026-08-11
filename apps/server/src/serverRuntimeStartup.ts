import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as HealthChecks from "./health/checks.ts";
import * as HealthEnv from "./health/env.ts";
import * as HealthIncidentLog from "./health/incidentLog.ts";
import * as FrictionStore from "./friction/frictionStore.ts";
import * as KnowledgeStore from "./kanban/hermes/knowledgeStore.ts";
import * as HealthRunner from "./health/runner.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import * as WorktreeReaper from "./vcs/WorktreeReaper.ts";
import {
  describeUnsafeWorkspaceRoot,
  describeUnusableWorkspaceRoot,
} from "./workspace/workspaceRootSafety.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const getAutoBootstrapDefaultModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

/**
 * Settle provider sessions the previous server process left mid-turn.
 *
 * Provider runtimes are in-memory and do not survive a restart, so a
 * projected session still in "starting"/"running" at boot belongs to a
 * process that no longer exists. Nothing else ever settles it — the session
 * reaper deliberately skips threads with an active turn — so without this
 * sweep the thread shows a forever-growing "Working for ..." indicator and
 * its latest turn never settles. Dispatching the interrupted session also
 * settles the projected running turns (thread.session-set projection).
 */
export const settleStaleSessionsAtStartup = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const shell = yield* projectionSnapshotQuery.getShellSnapshot();
  for (const thread of shell.threads) {
    const session = thread.session;
    if (session === null || (session.status !== "starting" && session.status !== "running")) {
      continue;
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:startup-session-settle:${yield* crypto.randomUUIDv4}`),
      threadId: thread.id,
      session: {
        ...session,
        status: "interrupted",
        activeTurnId: null,
        lastError: "The turn was interrupted by a server restart.",
        updatedAt: nowIso,
      },
      createdAt: nowIso,
    });
    yield* Effect.logInfo("settled a provider session left running by a previous server process", {
      threadId: thread.id,
      previousStatus: session.status,
      previousActiveTurnId: session.activeTurnId,
    });
  }
});

/**
 * Find — and where it is safe, fix — the box conditions that make sessions
 * fail, once per boot.
 *
 * An unplanned restart is exactly when the box is most likely to have come back
 * wrong (a full disk, a read-only store, a worktree root that never got
 * recreated), and until now nothing looked: `selftest.sh` only runs at the tail
 * of a deploy. Forked, never awaited — a reachability probe must not hold up
 * the HTTP listener.
 */
export const runStartupHealthChecks = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  HealthIncidentLog.bindHealthIncidentLog(serverConfig.stateDir);
  HealthEnv.bindHealthStateDir(serverConfig.stateDir);
  const env = HealthEnv.makeHealthEnv(HealthEnv.healthPathsFromEnvironment(serverConfig.stateDir));

  const report = yield* Effect.promise(() =>
    HealthRunner.runHealthChecks(HealthChecks.HEALTH_CHECKS, env, { fix: true }),
  );
  HealthIncidentLog.recordHealthReport(report);

  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  for (const outcome of report.checks) {
    if (outcome.status === "ok") continue;
    const annotations = {
      check: outcome.id,
      detail: outcome.detail,
      ...(outcome.fixed === undefined ? {} : { autofixed: outcome.fixed }),
      seenInLastDay: HealthIncidentLog.countRecent(outcome.id, 24 * 60 * 60 * 1000, nowMs),
    };
    yield* outcome.status === "fail" && outcome.severity === "critical"
      ? Effect.logError("health check failing", annotations)
      : Effect.logWarning("health check not clean", annotations);
  }
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

/**
 * Retire projects whose workspace root can never host a launch — the `/`-rooted
 * project a server started without a working directory used to mint. Soft
 * delete: the rows stay, the board stops offering it as a launch target.
 */
export const quarantineUnusableProjects = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const shell = yield* projection.getShellSnapshot();
  for (const project of shell.projects) {
    const detail = describeUnusableWorkspaceRoot(project.workspaceRoot);
    if (!detail) continue;
    yield* Effect.logError("archiving a project whose workspace root cannot host a launch", {
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      detail,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "project.delete",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        projectId: project.id,
        force: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not archive the unusable project", {
            projectId: project.id,
            cause,
          }),
        ),
      );
  }
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  const unusableCwd = describeUnsafeWorkspaceRoot(serverConfig.cwd);
  if (serverConfig.autoBootstrapProjectFromCwd && unusableCwd) {
    // systemd without a WorkingDirectory starts the server at "/", and the
    // project minted from it persists as a launch target rooted at the whole
    // filesystem.
    yield* Effect.logWarning("skipping auto-bootstrap project: the server cwd cannot host one", {
      cwd: serverConfig.cwd,
      detail: unusableCwd,
    });
  }

  if (serverConfig.autoBootstrapProjectFromCwd && !unusableCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = getAutoBootstrapDefaultModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const createdThreadId = ThreadId.make(yield* randomUUID);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  // Bound before anything can report: the MCP papercut tool and the Hermes
  // board-failure counter both write here, and neither waits for the brain
  // layer or the forked health pass to build.
  FrictionStore.bindFrictionLog(serverConfig.baseDir);
  FrictionStore.restoreFrictionLog();
  // Same reason, one file over: a launch carries the lessons for its project,
  // and a launch can happen before the brain layer is up.
  KnowledgeStore.bindKnowledgeLog(serverConfig.baseDir);
  KnowledgeStore.restoreKnowledgeLog();
  const keybindings = yield* Keybindings.Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
  const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
  const worktreeReaper = yield* Effect.serviceOption(WorktreeReaper.WorktreeReaper);
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            operation: error.operation,
            providerInstanceId: error.providerInstanceId,
            environmentVariable: error.environmentVariable,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );
    yield* Effect.logInfo("server settings ready", {
      settingsPath: serverConfig.settingsPath,
      stateDir: serverConfig.stateDir,
    });

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      Effect.gen(function* () {
        yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
        yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        if (Option.isSome(worktreeReaper)) {
          yield* worktreeReaper.value.start().pipe(Scope.provide(reactorScope));
        }
      }),
    );

    yield* Effect.logDebug("startup phase: settling stale provider sessions");
    yield* runStartupPhase(
      "sessions.settle",
      settleStaleSessionsAtStartup.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to settle stale provider sessions at startup", { cause }),
        ),
      ),
    );

    yield* Effect.logDebug("startup phase: running health checks");
    yield* Effect.forkScoped(
      runStartupPhase(
        "health.check",
        runStartupHealthChecks.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to run startup health checks", { cause }),
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      runStartupPhase(
        "projects.quarantine",
        quarantineUnusableProjects.pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to check projects for unusable workspace roots", { cause }),
          ),
        ),
      ),
    );

    const welcomeBase = yield* resolveWelcomeBase;
    const environment = yield* serverEnvironment.getDescriptor;
    yield* Effect.logDebug("startup phase: preparing welcome payload");
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      environmentId: environment.environmentId,
      cwd: welcomeBase.cwd,
      projectName: welcomeBase.projectName,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          ...welcomeBase,
        },
      }),
    );

    if (serverConfig.autoBootstrapProjectFromCwd) {
      yield* Effect.forkScoped(
        runStartupPhase(
          "welcome.autobootstrap",
          Effect.gen(function* () {
            const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
              return;
            }

            yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
              environmentId: environment.environmentId,
              cwd: welcomeBase.cwd,
              projectName: welcomeBase.projectName,
              bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
              bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
            });
            yield* lifecycleEvents.publish({
              version: 1,
              type: "welcome",
              payload: {
                environment,
                ...welcomeBase,
                ...bootstrapTargets,
              },
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("startup auto-bootstrap welcome failed", {
                cause,
              }),
            ),
          ),
        ),
      );
    }
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment: yield* serverEnvironment.getDescriptor,
          },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      if (serverConfig.startupPresentation === "headless") {
        yield* Effect.logDebug("startup phase: headless access info");
        const accessInfo = yield* issueHeadlessServeAccessInfo();
        yield* runStartupPhase(
          "headless.output",
          Console.log(formatHeadlessServeOutput(accessInfo)),
        );
      } else {
        yield* Effect.logDebug("startup phase: browser open check");
        const startupBrowserTarget = yield* resolveStartupBrowserTarget;
        if (serverConfig.mode !== "desktop") {
          yield* Effect.logInfo(
            "Authentication required. Open T3 Code using the pairing URL.",
          ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
        }
        yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
      }
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartup["Service"];
});

export const layer = Layer.effect(ServerRuntimeStartup, make);
