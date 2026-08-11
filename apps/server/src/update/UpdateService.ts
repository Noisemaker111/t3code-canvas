/**
 * UpdateService – gated, user-initiated host updates.
 *
 * This service owns the *policy*: one idempotent "update now" action, refused
 * while an agent turn is running unless forced, plus a resumable tail of the
 * install log so progress survives the restart the install performs on this
 * very process.
 *
 * It owns none of the *mechanism*. Everything about how a host installs a new
 * version lives behind {@link HostUpdateHook} — a command the host declares.
 * That is what lets the same server run on a devbox that deploys itself from
 * git through systemd, and on a laptop where the desktop app updates itself and
 * no hook exists at all (`supported: false`).
 *
 * @module UpdateService
 */
import type {
  ServerInstallLogEvent,
  ServerInstallUpdateInput,
  ServerInstallRun,
  ServerSubscribeInstallLogInput,
  ServerUpdateState,
  ServerUpdateStatus,
} from "@t3tools/contracts";
import { ServerUpdateError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as HostUpdateHook from "./HostUpdateHook.ts";
import {
  countCompleteLines,
  parseInstallLog,
  parseInstallRun,
  runLogFileName,
} from "./installLog.ts";

// How often the install-log tail re-reads the run log. The log is written by
// the host's hook, so there is nothing to subscribe to; polling this fast keeps
// the UI feeling live without meaningful cost (the tail only runs while a
// client is actually watching an install).
const LOG_POLL_INTERVAL = Duration.millis(700);
// Shortest version prefix we will accept as a match. Without a floor, a
// truncated or garbage version stamp prefix-matches everything and the app
// reports "up to date" for a version it is not running.
const MIN_VERSION_PREFIX = 7;

/**
 * True when two version strings denote the same version, allowing one to be an
 * abbreviated form of the other (a git-deployed host prints short and long
 * hashes interchangeably). Mirrors `versionsMatch` in the web client.
 */
function versionsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_VERSION_PREFIX) return false;
  return longer.startsWith(shorter);
}

export class UpdateService extends Context.Service<
  UpdateService,
  {
    readonly getState: Effect.Effect<ServerUpdateState, ServerUpdateError>;
    readonly checkForUpdate: Effect.Effect<ServerUpdateState, ServerUpdateError>;
    readonly installUpdate: (
      input?: ServerInstallUpdateInput,
    ) => Effect.Effect<ServerUpdateState, ServerUpdateError>;
    /**
     * Live tail of the current (or a named) install run, resumable from a line
     * offset. Ends when the run reaches a terminal status.
     */
    readonly subscribeInstallLog: (
      input: ServerSubscribeInstallLogInput,
    ) => Stream.Stream<ServerInstallLogEvent, ServerUpdateError>;
  }
>()("t3/update/UpdateService") {}

interface MutableState {
  readonly status: ServerUpdateStatus;
  readonly availableCommit: string | null;
  readonly lastCheckedAt: string | null;
  readonly message: string | null;
  // Epoch millis of when the current install was triggered. Only meaningful
  // while status === "installing"; used to reconcile a stuck "installing" state
  // (see currentState) once the host's run is no longer in progress.
  readonly installStartedAtMs: number | null;
  // Run the host opened for the install we triggered, when it names one. This
  // is the difference between reporting an install and guessing at one: without
  // it the only evidence available was "some run exists", so a previous run
  // sitting in the pointer was read as the outcome of this click.
  readonly installRunId: string | null;
}

const INITIAL_STATE: MutableState = {
  status: "idle",
  availableCommit: null,
  lastCheckedAt: null,
  message: null,
  installStartedAtMs: null,
  installRunId: null,
};

// A triggered install normally replaces and restarts this process — so a
// surviving process still marked "installing" means the install finished
// WITHOUT restarting us (the host deferred it, the version was identical, or it
// failed). Once this grace window has elapsed and the host's run pointer is no
// longer "running", the state is reconciled back to reality instead of showing
// "Installing…" forever.
const INSTALL_RECONCILE_GRACE_MS = 8000;

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hook = yield* HostUpdateHook.HostUpdateHook;
  const projectionSnapshot = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const stateRef = yield* Ref.make<MutableState>(INITIAL_STATE);

  const supported = hook.supported;
  const logDir = hook.logDir;

  // --- install run log -------------------------------------------------------
  // The install runs outside this process, so its output would otherwise be
  // unreachable: the RPC returns the instant the install is triggered. The host
  // writes a JSONL run log the server reads, which is also how progress
  // survives the restart the install performs on this very process.

  const readInstallRun: Effect.Effect<ServerInstallRun | null> =
    logDir === null
      ? Effect.succeed(null)
      : fs.readFileString(`${logDir}/current.json`).pipe(
          Effect.map(parseInstallRun),
          Effect.catch(() => Effect.succeed(null)),
        );

  const readRunLog = (runId: string): Effect.Effect<string> =>
    logDir === null
      ? Effect.succeed("")
      : fs
          .readFileString(`${logDir}/${runLogFileName(runId)}`)
          .pipe(Effect.catch(() => Effect.succeed("")));

  // How many polls to keep waiting for a run to appear before giving up. The
  // client subscribes the moment it triggers the install, a beat before the
  // host has created the log, so ending immediately on "no run yet" would show
  // an empty pane for the whole install.
  const MAX_EMPTY_POLLS = 90;

  const subscribeInstallLog: UpdateService["Service"]["subscribeInstallLog"] = (input) =>
    Stream.callback<ServerInstallLogEvent, ServerUpdateError>((queue) =>
      Effect.gen(function* () {
        if (logDir === null) {
          yield* Queue.end(queue);
          return;
        }
        const pinnedRunId = input.runId ?? null;
        let cursor = input.fromLine ?? 0;
        let emptyPolls = 0;

        for (;;) {
          const run = yield* readInstallRun;
          const activeRunId = pinnedRunId ?? run?.runId ?? null;

          if (activeRunId === null) {
            emptyPolls += 1;
            if (emptyPolls > MAX_EMPTY_POLLS) break;
          } else {
            const text = yield* readRunLog(activeRunId);
            // A pinned run pins `activeRunId`, so the branch above can never
            // end the stream for it. Nothing to read and no pointer is the same
            // "there is no such run" this gives up on.
            if (run === null && text === "") {
              emptyPolls += 1;
              if (emptyPolls > MAX_EMPTY_POLLS) break;
            } else {
              emptyPolls = 0;
            }
            const events = parseInstallLog(text, activeRunId, cursor);
            for (const event of events) {
              yield* Queue.offer(queue, event);
            }
            if (events.length > 0) {
              cursor = events[events.length - 1]!.line;
            }
            // Read before deciding to stop, so the final lines a run writes as
            // it flips to a terminal status are never dropped. A pointer that
            // has moved on to another run also means ours is over.
            const finished =
              run !== null && (run.runId !== activeRunId || run.status !== "running");
            if (finished && cursor >= countCompleteLines(text)) break;
          }

          yield* Effect.sleep(LOG_POLL_INTERVAL);
        }

        yield* Queue.end(queue);
      }),
    );

  const countRunningAgents = Effect.gen(function* () {
    const snapshot = yield* projectionSnapshot.getSnapshot();
    return snapshot.threads.filter(
      (thread) => thread.session?.status === "running" || thread.latestTurn?.state === "running",
    ).length;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

  // The host names its own running version; a hook that cannot resolve one (or
  // fails outright) leaves the field null rather than failing the whole query.
  const resolveDeployedCommit: Effect.Effect<string | null> = supported
    ? hook.currentVersion.pipe(Effect.catch(() => Effect.succeed(null)))
    : Effect.succeed(null);

  const buildState = (
    mutable: MutableState,
    deployedCommit: string | null,
    runningAgentCount: number,
    installRun: ServerInstallRun | null,
  ): ServerUpdateState => ({
    supported,
    status: mutable.status,
    deployedCommit,
    availableCommit: mutable.availableCommit,
    agentsBusy: runningAgentCount > 0,
    runningAgentCount,
    lastCheckedAt: mutable.lastCheckedAt,
    message: mutable.message,
    installRun,
  });

  // Settle a stuck "installing". The host's own run pointer is the evidence:
  // it says whether the run is still going, and if not, whether it failed or
  // was deferred. This used to be inferred from `systemctl is-active` plus the
  // unit's exit accounting, which the app could only guess at — and which does
  // not exist on a host without systemd.
  //
  // Which run counts is the part that has to be exact. A host that names the
  // run it opened for us (`installRunId`) settles this outright: that run's
  // status IS the outcome, for as long as it takes, and no other run can stand
  // in for it. Only a host that names none falls back to inference.
  const reconcileInstalling = (
    mutable: MutableState,
    deployedCommit: string | null,
    runningAgentCount: number,
    installRun: ServerInstallRun | null,
    nowMs: number,
  ): Effect.Effect<MutableState> =>
    Effect.gen(function* () {
      if (!supported || mutable.status !== "installing") return mutable;

      const ownRun =
        mutable.installRunId !== null && installRun?.runId === mutable.installRunId
          ? installRun
          : null;
      const startedMs = mutable.installStartedAtMs ?? 0;
      const graceElapsed = nowMs - startedMs > INSTALL_RECONCILE_GRACE_MS;
      if (mutable.installRunId !== null) {
        // Our run is still going: the host is working, however long it takes.
        if (ownRun !== null && ownRun.status === "running") return mutable;
        // Our run is not in the pointer at all. Normal for the instant before
        // the host writes it; past the grace window it means another run
        // replaced ours, which settles this one either way.
        if (ownRun === null && !graceElapsed) return mutable;
      } else if (
        // No named run: keep showing "installing" while the host reports SOME run
        // as live, or during the brief window right after trigger.
        (installRun !== null && installRun.status === "running") ||
        !graceElapsed
      ) {
        return mutable;
      }

      const upToDate = versionsMatch(mutable.availableCommit, deployedCommit);
      const status: ServerUpdateStatus = upToDate
        ? "up-to-date"
        : mutable.availableCommit
          ? "available"
          : "idle";
      const settled = ownRun ?? (mutable.installRunId === null ? installRun : null);
      const message =
        mutable.installRunId !== null && ownRun === null
          ? "The install never reported back. Try installing again."
          : settled !== null && settled.status === "failed"
            ? `The install failed during "${settled.phaseLabel ?? settled.phase}". See the install log below.`
            : settled !== null && settled.status === "deferred"
              ? "Install was deferred while agents were running. Try again once they finish."
              : upToDate
                ? null
                : runningAgentCount > 0
                  ? "Install was deferred while agents were running. Try again once they finish."
                  : "The last install finished without restarting the server. Try installing again.";
      const reconciled: MutableState = {
        ...mutable,
        status,
        message,
        installStartedAtMs: null,
        installRunId: null,
      };
      yield* Ref.set(stateRef, reconciled);
      return reconciled;
    });

  const currentState = Effect.gen(function* () {
    const mutable = yield* Ref.get(stateRef);
    const runningAgentCount = yield* countRunningAgents;
    const deployedCommit = yield* resolveDeployedCommit;
    const installRun = supported ? yield* readInstallRun : null;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const effective = yield* reconcileInstalling(
      mutable,
      deployedCommit,
      runningAgentCount,
      installRun,
      nowMs,
    );
    return buildState(effective, deployedCommit, runningAgentCount, installRun);
  });

  const getState: UpdateService["Service"]["getState"] = currentState;

  const checkForUpdate: UpdateService["Service"]["checkForUpdate"] = Effect.gen(function* () {
    if (!supported) {
      return yield* currentState;
    }
    yield* Ref.update(
      stateRef,
      (prev): MutableState => ({ ...prev, status: "checking", message: null }),
    );

    const deployedCommit = yield* resolveDeployedCommit;
    const checked = yield* hook.checkVersion.pipe(Effect.result);
    if (checked._tag === "Failure") {
      const message = checked.failure.detail;
      yield* Ref.update(stateRef, (prev): MutableState => ({ ...prev, status: "error", message }));
      return yield* currentState;
    }

    const availableCommit = checked.success;
    const now = DateTime.formatIso(yield* DateTime.now);
    const upToDate = versionsMatch(availableCommit, deployedCommit);
    yield* Ref.update(
      stateRef,
      (prev): MutableState => ({
        ...prev,
        status: upToDate ? "up-to-date" : "available",
        availableCommit,
        lastCheckedAt: now,
        message: null,
      }),
    );
    return yield* currentState;
  });

  const installUpdate: UpdateService["Service"]["installUpdate"] = (input) =>
    Effect.gen(function* () {
      if (!supported) {
        return yield* Effect.fail(
          new ServerUpdateError({
            operation: "install",
            detail: "In-app updates are not available for this deployment.",
          }),
        );
      }

      // One command owns the whole update transaction. The old UI made the
      // browser check first and install second; a reconnect between those RPCs
      // left stale state and forced the user to retry. Check here so every
      // click is fresh and an already-current host is a successful no-op.
      const checked = yield* checkForUpdate;
      if (checked.status === "error") {
        return yield* Effect.fail(
          new ServerUpdateError({
            operation: "check",
            detail: checked.message ?? "Could not check for updates.",
          }),
        );
      }
      if (checked.status === "up-to-date") {
        return checked;
      }
      if (checked.status !== "available" || checked.availableCommit === null) {
        return yield* Effect.fail(
          new ServerUpdateError({
            operation: "install",
            detail: "No installable update is available.",
          }),
        );
      }

      const runningAgentCount = input?.force === true ? 0 : yield* countRunningAgents;
      if (runningAgentCount > 0) {
        yield* Ref.update(
          stateRef,
          (prev): MutableState => ({
            ...prev,
            status: "available",
            message: "Agents are running. Wait for them to finish before installing.",
          }),
        );
        return yield* Effect.fail(
          new ServerUpdateError({
            operation: "install",
            detail: `Refusing to restart while ${runningAgentCount} agent${
              runningAgentCount === 1 ? " is" : "s are"
            } running.`,
            agentsBusy: true,
          }),
        );
      }

      const installStartedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      yield* Ref.update(
        stateRef,
        (prev): MutableState => ({
          ...prev,
          status: "installing",
          message: "Installing update and restarting…",
          installStartedAtMs,
          installRunId: null,
        }),
      );

      // `force` authorizes the host to restart despite its own safety
      // deferrals. We only reach here after confirming no agent turn is
      // running, so an explicit user-initiated install should not be silently
      // deferred by lingering idle processes.
      const started = yield* hook
        .startInstall({ force: input?.force === true })
        .pipe(Effect.result);
      if (started._tag === "Failure") {
        const message = started.failure.detail;
        yield* Ref.update(
          stateRef,
          (prev): MutableState => ({
            ...prev,
            status: "error",
            message,
            installStartedAtMs: null,
            installRunId: null,
          }),
        );
        return yield* Effect.fail(new ServerUpdateError({ operation: "install", detail: message }));
      }

      // The host opened a run for this click and named it. From here the whole
      // flow — this server's status, the log the client tails, and the outcome
      // it reports — is about that one run and no other.
      yield* Ref.update(
        stateRef,
        (prev): MutableState => ({ ...prev, installRunId: started.success }),
      );

      return yield* currentState;
    });

  return UpdateService.of({ getState, checkForUpdate, installUpdate, subscribeInstallLog });
});

export const layer = Layer.effect(UpdateService, make).pipe(
  Layer.provideMerge(HostUpdateHook.layer),
);
