/**
 * Teardown for thread-scoped worktrees.
 *
 * `createWorktree` had no automatic counterpart: every archived thread and
 * every kanban card that left Active leaked its workspace directory forever.
 * This service is that counterpart.
 *
 * Safety rules, in order:
 *  - only ever remove a path that lives directly inside the workspace root for
 *    the thread's project (`isThreadWorktreePath`), never a project checkout;
 *  - never remove a worktree with uncommitted changes — skip it and say so in
 *    the log, naming the path, so the work can be recovered by hand;
 *  - never force. A failure is reported, not papered over.
 *
 * `sweepOrphanedWorktrees` is the same teardown driven from the directory
 * listing rather than from a thread id, so a workspace whose thread record
 * never existed (a launch that died after `createWorktree`, a card deleted
 * while Active) is still reclaimed. Policy lives in `worktreeSweep.ts`.
 *
 * @module vcs/WorktreeReaper
 */
import * as NodeFSP from "node:fs/promises";

import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  isThreadWorktreePath,
  nodeWorktreePath,
  projectWorktreeRoot,
  THREAD_WORKTREE_PREFIX,
} from "./worktreeLayout.ts";
import {
  abandonedReapEnabled,
  planWorktreeSweep,
  resolveRetentionHours,
  type SweepCandidate,
} from "./worktreeSweep.ts";

/** Each orphan is a full dependency install (~1.7GiB), so half-hourly is ample. */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export type WorktreeReapOutcome =
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "skipped"; readonly reason: string; readonly path: string | null }
  | { readonly kind: "failed"; readonly reason: string; readonly path: string };

export interface WorktreeSweepSummary {
  readonly inspected: number;
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

export interface WorktreeReaperShape {
  /**
   * Remove the worktree belonging to `threadId`, if it owns one. Never fails —
   * teardown is best-effort by design and must not break archiving a thread or
   * moving a card. The outcome says what actually happened.
   */
  readonly reapThreadWorktree: (threadId: ThreadId) => Effect.Effect<WorktreeReapOutcome>;

  /**
   * Reclaim workspaces under every project's workspace root that no live thread
   * claims. Never fails; the summary says what happened.
   */
  readonly sweepOrphanedWorktrees: () => Effect.Effect<WorktreeSweepSummary>;

  /**
   * Run {@link sweepOrphanedWorktrees} on a timer for the life of the scope.
   * Launching a card swept orphans too, but only then — a box that stopped
   * launching (because its disk was full of orphans) never swept again.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorktreeReaper extends Context.Service<WorktreeReaper, WorktreeReaperShape>()(
  "t3/vcs/WorktreeReaper",
) {}

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  const reapThreadWorktree = Effect.fn("WorktreeReaper.reapThreadWorktree")(function* (
    threadId: ThreadId,
  ) {
    const threadOption = yield* projection
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<never>()));
    let thread = Option.getOrNull(threadOption);
    if (!thread) {
      // The ws archive handler reaps *after* dispatching `thread.archive`, and
      // the active-only query no longer sees the thread by then — which used
      // to skip every archive-triggered reap as "thread not found".
      const archived = yield* projection
        .getArchivedShellSnapshot()
        .pipe(Effect.orElseSucceed(() => null));
      thread = archived?.threads.find((entry) => entry.id === threadId) ?? null;
    }
    if (!thread) {
      return { kind: "skipped", reason: "thread not found", path: null } as const;
    }
    const worktreePath = thread.worktreePath;
    if (!worktreePath) {
      return { kind: "skipped", reason: "thread has no worktree", path: null } as const;
    }

    const shell = yield* projection.getShellSnapshot().pipe(
      Effect.orElseSucceed(() => ({
        projects: [] as ReadonlyArray<{ id: string; workspaceRoot: string }>,
      })),
    );
    const project = shell.projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      return {
        kind: "skipped",
        reason: "project not found for thread",
        path: worktreePath,
      } as const;
    }
    const projectCwd = project.workspaceRoot;

    if (path.resolve(worktreePath) === path.resolve(projectCwd)) {
      return {
        kind: "skipped",
        reason: "thread runs in the project checkout",
        path: worktreePath,
      } as const;
    }
    if (!isThreadWorktreePath({ path, projectCwd, candidate: worktreePath })) {
      yield* Effect.logInfo("worktree teardown skipped a path outside the workspace root", {
        threadId,
        worktreePath,
        projectCwd,
      });
      return {
        kind: "skipped",
        reason: "worktree is outside this project's workspace root",
        path: worktreePath,
      } as const;
    }

    // Uncommitted work is the one thing teardown must never destroy silently.
    const statusResult = yield* Effect.result(git.statusDetailsLocal(worktreePath));
    if (Result.isSuccess(statusResult) && statusResult.success.hasWorkingTreeChanges) {
      yield* Effect.logWarning(
        `Keeping worktree ${worktreePath}: it has uncommitted changes. ` +
          "Remove it by hand once the work is saved.",
        { threadId },
      );
      return {
        kind: "skipped",
        reason: "worktree has uncommitted changes",
        path: worktreePath,
      } as const;
    }

    const removeResult = yield* Effect.result(
      git.removeWorktree({ cwd: projectCwd, path: worktreePath, force: false }),
    );
    if (Result.isFailure(removeResult)) {
      const reason = removeResult.failure.detail ?? removeResult.failure.message;
      yield* Effect.logWarning(`Failed to remove worktree ${worktreePath}: ${reason}`, {
        threadId,
      });
      return { kind: "failed", reason, path: worktreePath } as const;
    }

    // The projection otherwise still says this thread owns a worktree at a
    // path that no longer exists on disk — the next thing that trusted it
    // (a relaunch, a PR pipeline step) found a directory that was not there.
    yield* Effect.gen(function* () {
      const commandUuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`vcs:reap-worktree:${commandUuid}`),
        threadId,
        worktreePath: null,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("worktree removed but clearing its thread record failed", {
          threadId,
          worktreePath,
          cause,
        }),
      ),
    );

    yield* Effect.logInfo("removed thread worktree", { threadId, worktreePath });
    return { kind: "removed", path: worktreePath } as const;
  });

  const sweepOrphanedWorktrees = Effect.fn("WorktreeReaper.sweepOrphanedWorktrees")(function* () {
    const shell = yield* projection.getShellSnapshot().pipe(
      Effect.orElseSucceed(() => ({
        projects: [] as ReadonlyArray<{ id: string; workspaceRoot: string }>,
        threads: [] as ReadonlyArray<{ worktreePath?: string | null }>,
      })),
    );

    // The unarchived threads — `getShellSnapshot` leaves archived ones to
    // `getArchivedShellSnapshot`, so an archived thread's workspace is already
    // an orphan here. A claim only defers the sweep; `planWorktreeSweep` still
    // reclaims a claimed workspace once it is clean and past retention.
    const livePaths = new Set(
      (shell.threads ?? [])
        .map((thread) => thread.worktreePath)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => path.resolve(value)),
    );

    const removed: Array<string> = [];
    const kept: Array<string> = [];
    const failed: Array<string> = [];
    let inspected = 0;
    // Settings-backed policy with the env keys as override; absent service
    // (tests, minimal layers) falls through to env/defaults.
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const board = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(
          Effect.map((settings) => settings.boardSettings),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const retentionHours = resolveRetentionHours(undefined, board?.worktreeRetentionHours);
    const reapAbandoned = abandonedReapEnabled(undefined, board?.worktreeReapAbandoned);

    for (const project of shell.projects) {
      const root = projectWorktreeRoot({
        path: nodeWorktreePath,
        projectCwd: project.workspaceRoot,
      });
      const entries = yield* Effect.promise(() =>
        NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []),
      );

      const candidates: Array<SweepCandidate> = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(THREAD_WORKTREE_PREFIX)) continue;
        const candidatePath = path.resolve(nodeWorktreePath.join(root, entry.name));
        if (
          !isThreadWorktreePath({
            path: nodeWorktreePath,
            projectCwd: project.workspaceRoot,
            candidate: candidatePath,
          })
        ) {
          continue;
        }
        const stat = yield* Effect.promise(() =>
          NodeFSP.stat(candidatePath).catch(() => undefined),
        );
        // A status read that fails is treated as dirty: teardown must never
        // guess "clean" for a directory it could not inspect.
        const status = yield* Effect.result(git.statusDetailsLocal(candidatePath));
        candidates.push({
          path: candidatePath,
          mtimeMs: stat?.mtimeMs ?? 0,
          hasWorkingTreeChanges: Result.isSuccess(status)
            ? status.success.hasWorkingTreeChanges
            : true,
        });
      }
      inspected += candidates.length;

      const decisions = planWorktreeSweep({
        candidates,
        livePaths: [...livePaths],
        nowMs: yield* Clock.currentTimeMillis,
        retentionHours,
        reapAbandoned,
      });

      for (const decision of decisions) {
        if (decision.kind === "keep") {
          kept.push(decision.path);
          continue;
        }
        if (decision.force) {
          yield* Effect.logWarning(
            `Force-removing abandoned worktree ${decision.path} — it has UNCOMMITTED CHANGES ` +
              `that will be lost. ${decision.reason}. ` +
              "This only happens because T3CODE_WORKTREE_REAP_ABANDONED is set.",
          );
        }
        const result = yield* Effect.result(
          git.removeWorktree({
            cwd: project.workspaceRoot,
            path: decision.path,
            force: decision.force,
          }),
        );
        if (Result.isFailure(result)) {
          failed.push(decision.path);
          yield* Effect.logWarning(
            `Failed to reclaim orphaned worktree ${decision.path}: ` +
              (result.failure.detail ?? result.failure.message),
          );
          continue;
        }
        removed.push(decision.path);
        yield* Effect.logInfo("reclaimed orphaned worktree", {
          worktreePath: decision.path,
          reason: decision.reason,
        });
      }
    }

    return { inspected, removed, kept, failed } as const;
  });

  const start: WorktreeReaperShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        sweepOrphanedWorktrees().pipe(
          Effect.catchCause((cause) => Effect.logWarning("worktree sweep failed", { cause })),
          Effect.catchDefect((defect) => Effect.logWarning("worktree sweep defect", { defect })),
          Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
        ),
      );
      yield* Effect.logInfo("worktree.reaper.started", { sweepIntervalMs: SWEEP_INTERVAL_MS });
    });

  return WorktreeReaper.of({ reapThreadWorktree, sweepOrphanedWorktrees, start });
});

export const layer = Layer.effect(WorktreeReaper, make);
