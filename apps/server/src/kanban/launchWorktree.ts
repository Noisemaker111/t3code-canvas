/**
 * Worktree preparation for server-owned Active launches.
 *
 * The web path (`ChatView.tsx`) sends `bootstrap.prepareWorktree` with a fresh
 * `buildTemporaryWorktreeBranchName` branch and lets `ws.ts` create the
 * workspace. `launch_active` cannot reuse that: it dispatches straight into the
 * orchestration engine, and `bootstrap` is only interpreted by the ws layer
 * (`dispatchBootstrapTurnStart`). So the same three steps — fetch origin,
 * resolve the base commit, create the worktree — live here, and Active cards
 * get a real workspace of their own.
 *
 * The path is thread-scoped (`buildThreadWorktreePath`), so two cards launched
 * from the same project on the same base branch land in two directories.
 *
 * The git driver is resolved with `Effect.serviceOption`, which keeps this out
 * of the requirement channel: `launch_active` is called from the ws handlers,
 * the Hermes fiber and the board MCP toolkit, and those signatures are pinned.
 *
 * @module kanban/launchWorktree
 */
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { buildThreadWorktreePath, nodeWorktreePath } from "../vcs/worktreeLayout.ts";

/** Ref used when a project has no discoverable default branch. */
const FALLBACK_BASE_BRANCH = "main";

export interface LaunchWorktreePreparation {
  readonly kind: "prepared";
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
}

/**
 * The project has no git in it, so there is no worktree to give the thread and
 * nothing stale to protect it from. Distinct from a failure: the caller launches
 * in the project directory rather than refusing the card.
 */
export interface LaunchWorktreeNotARepo {
  readonly kind: "not_a_repo";
  readonly reason: string;
}

export type LaunchWorktreeOutcome = LaunchWorktreePreparation | LaunchWorktreeNotARepo;

export interface LaunchWorktreePreparer {
  readonly prepare: (input: {
    readonly projectCwd: string;
    readonly threadId: string;
    readonly branch: string;
    readonly baseBranch?: string;
  }) => Effect.Effect<LaunchWorktreeOutcome, GitCommandError>;
}

const staleBase = (cwd: string, detail: string) =>
  new GitCommandError({
    operation: "launchWorktree.prepare",
    command: "git",
    cwd,
    detail,
  });

/**
 * The default branch for `projectCwd`, or null when the directory is not a git
 * checkout at all.
 */
const resolveBaseBranch = (git: GitVcsDriver.GitVcsDriver["Service"], projectCwd: string) =>
  Effect.gen(function* () {
    const listed = yield* Effect.result(
      git.listRefs({ cwd: projectCwd, refKind: "all", limit: 100 }),
    );
    // Guessing `main` here is a base branch nobody chose: `git` failed, so the
    // card would branch off whatever `origin/main` happens to be — or off a ref
    // this project does not have — and blame the card for it.
    if (Result.isFailure(listed)) {
      return yield* staleBase(
        projectCwd,
        `could not list refs in ${projectCwd} ` +
          `(${listed.failure.detail ?? listed.failure.message}), so the base branch is unknown. ` +
          "Set the project's default base branch, or fix the checkout (t3 health --fix).",
      );
    }
    if (!listed.success.isRepo) return null;
    const defaultRef = listed.success.refs.find((ref) => ref.isDefault);
    if (!defaultRef) return FALLBACK_BASE_BRANCH;
    const name = defaultRef.name;
    const remoteName = defaultRef.remoteName;
    return remoteName && name.startsWith(`${remoteName}/`)
      ? name.slice(remoteName.length + 1)
      : name;
  });

/**
 * Put the project checkout back on its base branch.
 *
 * The checkout is a reference clone, not a workspace: every card works in its
 * own worktree and everything it produces goes to the remote. A checkout left
 * on the last card's branch is drift, and the next card that has to commit
 * there inherits its commits — that is how one pull request ended up with seven
 * cards in it.
 *
 * Non-destructive on purpose. A dirty tree is left exactly as it is and
 * reported: uncommitted work should not exist here, but if it does, throwing it
 * away is unrecoverable. Switching away keeps the old branch ref, so its
 * commits are still there to land or drop by hand.
 */
const restoreProjectCheckout = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  projectCwd: string,
  baseBranch: string,
) =>
  Effect.gen(function* () {
    const run = (args: ReadonlyArray<string>) =>
      Effect.result(
        git.execute({
          operation: "launchWorktree.restoreProjectCheckout",
          cwd: projectCwd,
          args: [...args],
          allowNonZeroExit: true,
        }),
      );

    const head = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (Result.isFailure(head) || head.success.exitCode !== 0) return;
    const branch = head.success.stdout.trim();
    if (branch.length === 0 || branch === baseBranch) return;

    const dirty = yield* run(["status", "--porcelain"]);
    if (Result.isFailure(dirty)) return;
    if (dirty.success.stdout.trim().length > 0) {
      yield* Effect.logWarning(
        `Leaving ${projectCwd} on '${branch}': it has uncommitted changes. ` +
          "Nothing on the box should hold uncommitted work — commit or drop it by hand, " +
          "and the next launch will put the checkout back on " +
          `'${baseBranch}'.`,
      );
      return;
    }

    const switched = yield* run(["switch", baseBranch]);
    if (Result.isFailure(switched) || switched.success.exitCode !== 0) {
      yield* Effect.logWarning(
        `Could not put ${projectCwd} back on '${baseBranch}' from '${branch}'`,
        {
          detail: Result.isSuccess(switched) ? switched.success.stderr.trim() : undefined,
        },
      );
      return;
    }
    // Fast-forward only: the checkout tracks the remote, it never rewrites it.
    yield* run(["merge", "--ff-only", `origin/${baseBranch}`]);
    yield* Effect.logInfo("put the project checkout back on its base branch", {
      projectCwd,
      from: branch,
      to: baseBranch,
    });
  });

export const makeLaunchWorktreePreparerFrom = (
  git: GitVcsDriver.GitVcsDriver["Service"],
): LaunchWorktreePreparer => ({
  prepare: Effect.fn("launchWorktree.prepare")(function* (input) {
    const resolvedBase = input.baseBranch ?? (yield* resolveBaseBranch(git, input.projectCwd));
    if (resolvedBase === null) {
      return {
        kind: "not_a_repo",
        reason: `${input.projectCwd} is not a git checkout`,
      } as const;
    }
    const baseBranch = resolvedBase;

    // Same contract as the web path's `startFromOrigin: true` — new work starts
    // at freshly fetched origin, not at whatever the checkout is sitting on.
    const fetched = yield* Effect.result(
      git.fetchRemote({ cwd: input.projectCwd, remoteName: "origin" }),
    );
    if (Result.isFailure(fetched)) {
      // Swallowing this is how a box with a broken deploy key branched every
      // card off a week-old `main` for days without one line saying so.
      yield* Effect.logError("launchWorktree could not fetch origin before branching", {
        projectCwd: input.projectCwd,
        baseBranch,
        detail: fetched.failure.detail ?? fetched.failure.message,
      });
    }

    // Every launch is a chance to undo drift, and a launch is the moment it
    // matters: the checkout is about to be the fallback for anything that
    // cannot get a worktree.
    yield* restoreProjectCheckout(git, input.projectCwd, baseBranch);

    const remoteBase = yield* Effect.result(
      git.resolveRemoteTrackingCommit({
        cwd: input.projectCwd,
        refName: baseBranch,
        fallbackRemoteName: "origin",
      }),
    );
    // Falling back to the local ref here is the stale-base bug itself: the local
    // branch is whatever the checkout last happened to see, and the card that
    // starts there opens a pull request against a base it never had.
    if (Result.isFailure(remoteBase)) {
      const chosen = input.baseBranch !== undefined;
      return yield* staleBase(
        input.projectCwd,
        `origin/${baseBranch} could not be resolved in ${input.projectCwd} ` +
          `(${remoteBase.failure.detail ?? remoteBase.failure.message}).` +
          (chosen
            ? ` '${baseBranch}' is the base branch this card asks for — check the name, or push` +
              " the branch, before launching it."
            : " Refusing to branch from the local ref instead: fix the remote (t3 health --fix)" +
              " so new work starts from the current base branch."),
      );
    }
    const startRef = remoteBase.success.commitSha;

    const worktreePath = buildThreadWorktreePath({
      path: nodeWorktreePath,
      projectCwd: input.projectCwd,
      threadId: input.threadId,
    });

    const created = yield* git.createWorktree({
      cwd: input.projectCwd,
      refName: startRef,
      newRefName: input.branch,
      baseRefName: baseBranch,
      path: worktreePath,
    });

    return {
      kind: "prepared",
      worktreePath: created.worktree.path,
      branch: created.worktree.refName,
      baseBranch,
    } as const;
  }),
});

/**
 * The preparer when a git driver is in context, `null` otherwise. Nothing is
 * added to the requirement channel, so every `launch_active` call site can ask
 * for it without changing its own signature.
 */
export const launchWorktreePreparerOption: Effect.Effect<LaunchWorktreePreparer | null> =
  Effect.gen(function* () {
    const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
    return Option.isSome(git) ? makeLaunchWorktreePreparerFrom(git.value) : null;
  });
