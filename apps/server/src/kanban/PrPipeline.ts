/**
 * Board-owned git: Active → PR → merged.
 *
 * The coding agent in a card's thread never branches, commits, pushes or opens
 * a PR. Moving the card is what does that, so the agent can be prompted to do
 * the work and say what is left without also being trusted with git.
 *
 * @module kanban/PrPipeline
 */
import type {
  GitActionProgressEvent,
  KanbanCard,
  KanbanCardId,
  ComponentId,
  KanbanClosePrInput,
  KanbanClosePrResult,
  KanbanMergePrInput,
  KanbanMergePrResult,
  KanbanOpenPrInput,
  KanbanOpenPrResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type { LaunchPreflight } from "../health/preflight.ts";
import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  unavailableChangeRequestChecks,
  type ChangeRequestChecks,
} from "../sourceControl/SourceControlProvider.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isThreadWorktreePath, nodeWorktreePath } from "../vcs/worktreeLayout.ts";
import type { KanbanStore } from "./KanbanStore.ts";
import { describePrePushFindings, prePushGuardIo, runPrePushGuard } from "./prePushGuard.ts";

/**
 * Where the card lands when the action succeeds.
 *
 * Opening a pull request and merging one are forge work. Which column the card
 * then sits in is the board's rule, and it was written into these two functions
 * — so the dialog row "when checks pass then merge the pull request" did not in
 * fact decide where the card went, and renaming the PR column left cards flying
 * to an id called `pr`. The caller that knows the rule passes it; the defaults
 * below are the seed board's, kept so an untouched board is unchanged.
 */
export interface PrPlacement {
  readonly moveTo?: ComponentId;
}

/** Where a freshly opened pull request puts its card on the seed board. */
const SEED_PR_COLUMN: ComponentId = "pr";
/** Where a merge puts its card on the seed board. */
const SEED_MERGED_COLUMN: ComponentId = "done";

export interface PrPipelineDeps {
  readonly store: KanbanStore["Service"];
  readonly projection: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly crypto: { readonly randomUUIDv4: Effect.Effect<string> };
  /** Same gate as launch: a box that cannot write cannot commit either. */
  readonly preflight?: LaunchPreflight | null;
  /** Present wherever raw git is available; the pipeline degrades without it. */
  readonly git?: GitVcsDriver.GitVcsDriver["Service"] | null;
}

/**
 * A base branch that moved on far enough to collide with the card's own work,
 * described well enough that an agent with no git can act on it.
 */
export type PrSyncConflict = {
  readonly baseBranch: string;
  readonly headBranch: string;
  /** Paths git could not merge on its own. */
  readonly files: ReadonlyArray<string>;
  /** What landed on the base branch since the card branched, newest first. */
  readonly baseCommits: ReadonlyArray<string>;
  /** How many commits the branch is behind its base. */
  readonly behindCount: number;
  /** Where the half-merged tree is waiting, when one was left for the agent. */
  readonly worktreePath: string | null;
};

export type PrSyncResult = {
  readonly synced: boolean;
  readonly reason: string | null;
  readonly conflict: PrSyncConflict | null;
};

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new TextGenerationError({
      operation: "assistPrompt",
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

const asDetail = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;

/** Commits from the base branch to name in a conflict brief. */
const CONFLICT_COMMIT_LIMIT = 12;

/** Conflicted paths to name before the list stops being readable. */
const CONFLICT_FILE_LIMIT = 25;

const splitLines = (value: string): ReadonlyArray<string> =>
  value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const findCard = (deps: PrPipelineDeps, id: KanbanCardId) =>
  Effect.gen(function* () {
    const listed = yield* deps.store
      .list()
      .pipe(Effect.catch((cause) => fail(asDetail(cause, "Failed to read the board."), cause)));
    const card = listed.cards.find((entry) => entry.id === id);
    if (!card) return yield* fail(`Kanban card '${id}' was not found.`);
    return card;
  });

const threadShellOf = (deps: PrPipelineDeps, card: KanbanCard) =>
  Effect.gen(function* () {
    if (!card.threadId) {
      return yield* fail(
        `Card '${card.title}' has no coding thread yet. Launch it into Active first.`,
      );
    }
    const thread = yield* deps.projection
      .getThreadShellById(card.threadId as ThreadId)
      .pipe(Effect.catch((cause) => fail(asDetail(cause, "Failed to read the thread."), cause)));
    if (Option.isNone(thread)) {
      return yield* fail(`Thread '${card.threadId}' for this card no longer exists.`);
    }
    return thread.value;
  });

const projectCwdOf = (deps: PrPipelineDeps, card: KanbanCard, projectId: ProjectId) =>
  Effect.gen(function* () {
    const project = yield* deps.projection
      .getProjectShellById(projectId)
      .pipe(Effect.catch((cause) => fail(asDetail(cause, "Failed to read the project."), cause)));
    if (Option.isNone(project)) {
      return yield* fail(`Project for card '${card.title}' no longer exists.`);
    }
    return project.value.workspaceRoot;
  });

/**
 * Where the card's uncommitted work lives: its thread's own worktree, and
 * nowhere else.
 *
 * A thread with no worktree ran in the shared project checkout, where nothing
 * is attributable to this card — the fallback is what put an unrelated rename
 * in a card's pull request. It refuses instead.
 */
const resolveWorkCwd = (deps: PrPipelineDeps, card: KanbanCard) =>
  Effect.gen(function* () {
    const shell = yield* threadShellOf(deps, card);
    if (shell.worktreePath) return shell.worktreePath;
    const projectId = card.projectId ?? shell.projectId;
    const projectCwd = yield* projectCwdOf(deps, card, projectId);
    return yield* fail(
      `Not opening a pull request for '${card.title}': its thread has no workspace of its own, ` +
        `so the only checkout to commit from is the shared project checkout ${projectCwd} — ` +
        "nothing there is known to be this card's work. Relaunch this card to give it a " +
        "workspace, then move it to PR again.",
    );
  });

/**
 * Merging runs against the project checkout, never the thread worktree.
 * `KanbanStore.update` reaps the worktree the moment a card leaves Active, so by
 * the time a card sits in PR its worktree directory is usually gone.
 */
const resolveForgeCwd = (deps: PrPipelineDeps, card: KanbanCard) =>
  Effect.gen(function* () {
    if (card.projectId) return yield* projectCwdOf(deps, card, card.projectId);
    const shell = yield* threadShellOf(deps, card);
    return yield* projectCwdOf(deps, card, shell.projectId);
  });

/**
 * Commit whatever the agent left in the card's worktree, push it on a feature
 * branch and open the PR. Re-running on a card that already has an open PR
 * pushes the new commits onto it rather than failing.
 */
export function runOpenPr(
  deps: PrPipelineDeps,
  input: KanbanOpenPrInput,
  options: PrPlacement = {},
): Effect.Effect<KanbanOpenPrResult, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);

    // Without this, a box whose disk is full retries the same unreadable git
    // failure on every card until someone opens the box by hand.
    if (deps.preflight) {
      const block = yield* Effect.promise(() => deps.preflight!.check());
      if (block) {
        return yield* fail(
          `Not opening a pull request for '${card.title}': this box is failing ${block.checkId} — ` +
            `${block.detail}. The card stays where it is; fix the box (t3 health --fix) and try again.`,
        );
      }
    }

    const cwd = yield* resolveWorkCwd(deps, card);

    // The reaper deletes a card's worktree the moment the card leaves Active but
    // leaves `thread.worktreePath` pointing at it, so every later openPr on that
    // card handed git a directory that was no longer there — and the only trace
    // was an unattributable "failed to resolve the VCS driver".
    const workspace = yield* deps.gitWorkflow
      .localStatus({ cwd })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (workspace === null || !workspace.isRepo) {
      return yield* fail(
        `Not opening a pull request for '${card.title}': its workspace ${cwd} is no longer a ` +
          "git worktree — the board reaps a card's worktree when the card leaves Active. " +
          "Relaunch this card to give it a fresh workspace, then move it to PR again.",
      );
    }

    const dirtyPaths = workspace.workingTree.files.map((file) => file.path);

    // A thread whose worktree *is* the project checkout still commits from a
    // shared directory, and nothing sitting there is attributable to this card.
    const shared = yield* describeSharedCheckoutRefusal(deps, card, cwd, dirtyPaths);
    if (shared) {
      return yield* fail(
        `Not opening a pull request for '${card.title}' from the shared checkout ${cwd}: ${shared}. ` +
          "Relaunch this card — the launch gives it a workspace of its own and leaves the " +
          "checkout's own work where it is.",
      );
    }

    const mission = missionOf(card);
    const actionId = yield* deps.crypto.randomUUIDv4;

    // GitCommandError redacts git's output from its message, so without this
    // tail a failed commit reads as a bare "non-zero status" in the tick log.
    const gitOutput: string[] = [];
    const progressReporter = {
      publish: (event: GitActionProgressEvent) => {
        if (event.kind === "hook_output") gitOutput.push(event.text);
        return Effect.void;
      },
    };
    const describeGitOutput = (): string => {
      const tail = gitOutput.slice(-6).join(" | ").trim();
      return tail.length > 0 ? ` [git: ${tail.slice(0, 600)}]` : "";
    };

    // The agent never runs git, so this is the only place between what it left
    // in the worktree and a public remote.
    const findings = yield* Effect.promise(() =>
      runPrePushGuard({ cwd, paths: dirtyPaths, io: prePushGuardIo }),
    );
    if (findings.length > 0) {
      yield* Effect.logWarning("kanban.openPr blocked by the pre-push guard", {
        cardId: card.id,
        findings: findings.map((finding) => finding.path),
      });
      return yield* fail(
        `Refusing to commit '${card.title}': ${describePrePushFindings(findings)}. ` +
          "Remove or ignore the file in the worktree, then move the card to PR again.",
      );
    }

    // A card that came back from PR to fix a conflict is sitting on a merge the
    // board started. Its resolution belongs on the pull request's own branch as
    // the merge commit — not on a new feature branch cut out from under it.
    const midMerge = yield* describeMidMerge(deps, cwd);
    if (midMerge?.unresolved.length) {
      return yield* fail(
        `Not committing '${card.title}': ${midMerge.unresolved.length} file(s) still have ` +
          `unresolved conflict markers — ${midMerge.unresolved.slice(0, 6).join(", ")}. ` +
          "Edit each one so it reads as finished code, then the board commits the merge.",
      );
    }

    let featureBranch = midMerge === null;
    if (midMerge === null && dirtyPaths.length === 0) {
      const unpushed = yield* countUnpushedCommits(deps, cwd);
      if (unpushed === 0) featureBranch = false;
    }

    // A card with a clean worktree (no uncommitted changes, no unpushed commits)
    // may already have an open PR if it was pushed by a prior agent run. Let the
    // git workflow check for an existing PR on the branch; if one exists,
    // reusedExistingPr will be true and the card stays in the correct state.
    // Only a missing PR URL after runStackedAction indicates truly no work.

    const result = yield* deps.gitWorkflow
      .runStackedAction(
        {
          actionId: `kanban-open-pr-${actionId}`,
          cwd,
          action: "commit_push_pr",
          featureBranch,
          ...(mission === null ? {} : { mission }),
        },
        { actionId: `kanban-open-pr-${actionId}`, progressReporter },
      )
      .pipe(
        Effect.catch((cause) =>
          fail(
            `Could not open a pull request for '${card.title}': ${asDetail(cause, "git failed.")}${describeGitOutput()}`,
            cause,
          ),
        ),
      );

    const prUrl = result.pr.url?.trim();
    if (!prUrl) {
      return yield* fail(
        `No pull request was opened for '${card.title}'. ${
          result.commit.status === "skipped_no_changes"
            ? "The worktree has no changes to propose."
            : "The forge did not return a pull request URL."
        }`,
      );
    }

    const updated = yield* deps.store
      .update({
        id: card.id as KanbanCardId,
        at: options.moveTo ?? SEED_PR_COLUMN,
        prUrl,
        prTitle: result.pr.title?.trim() || null,
        prNumber: result.pr.number ?? null,
        prepStatus: "ready",
      })
      .pipe(
        Effect.catch((cause) =>
          fail(asDetail(cause, "Opened the pull request but failed to move the card."), cause),
        ),
      );

    return {
      card: updated,
      prUrl,
      reusedExistingPr: result.pr.status === "opened_existing",
      commitSha: result.commit.commitSha ?? null,
    } satisfies KanbanOpenPrResult;
  });
}

/** Paths to name before a refusal stops being readable. */
const REFUSAL_FILE_LIMIT = 8;

const missionOf = (card: KanbanCard): string | null => {
  const mission = [card.title.trim(), card.body.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return mission.length > 0 ? mission.slice(0, 4_000) : null;
};

type GitService = NonNullable<PrPipelineDeps["git"]>;

/** Runs a read-only git command; `null` unless it exited zero. */
const gitRunner =
  (git: GitService, operation: string, cwd: string) =>
  (args: ReadonlyArray<string>): Effect.Effect<string | null, never> =>
    Effect.result(git.execute({ operation, cwd, args: [...args], allowNonZeroExit: true })).pipe(
      Effect.map((result) =>
        Result.isSuccess(result) && result.success.exitCode === 0
          ? result.success.stdout.trim()
          : null,
      ),
    );

function resolveDefaultBranch(git: GitService, cwd: string): Effect.Effect<string, never> {
  return Effect.gen(function* () {
    const run = gitRunner(git, "kanban.openPr.defaultBranch", cwd);
    const originHead = yield* run([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    return originHead === null ? "main" : originHead.replace(/^origin\//, "");
  });
}

/**
 * Commits on HEAD that the remote does not have yet, or `null` when git cannot
 * say. Zero means every commit here has already been proposed.
 */
function countUnpushedCommits(
  deps: PrPipelineDeps,
  cwd: string,
): Effect.Effect<number | null, never> {
  return Effect.gen(function* () {
    const git = deps.git;
    if (!git) return null;
    const run = gitRunner(git, "kanban.openPr.unpushed", cwd);
    const upstream = yield* run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const base = upstream ?? `origin/${yield* resolveDefaultBranch(git, cwd)}`;
    const count = yield* run(["rev-list", "--count", `${base}..HEAD`]);
    if (count === null) return null;
    const parsed = Number.parseInt(count, 10);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

/**
 * `null` when this checkout is the card's own to commit from; the reason to
 * refuse otherwise.
 *
 * Only the shared project checkout is at risk — a thread worktree belongs to
 * one card. Nothing in a shared checkout is attributable: uncommitted files and
 * unpushed commits alike belong to whoever left them, and wrapping either into
 * this card's pull request is how one PR ended up with seven cards in it, and
 * how another shipped a stranger's rename.
 */
function describeSharedCheckoutRefusal(
  deps: PrPipelineDeps,
  card: KanbanCard,
  cwd: string,
  dirtyPaths: ReadonlyArray<string>,
): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const projectCwd = yield* Effect.result(resolveForgeCwd(deps, card));
    if (Result.isFailure(projectCwd) || projectCwd.success !== cwd) return null;

    const git = deps.git;
    if (!git) {
      return "the board has no git driver here, so it cannot tell whose work the checkout is carrying";
    }

    if (dirtyPaths.length > 0) {
      const named = dirtyPaths.slice(0, REFUSAL_FILE_LIMIT).join(", ");
      const rest =
        dirtyPaths.length > REFUSAL_FILE_LIMIT
          ? ` (+${dirtyPaths.length - REFUSAL_FILE_LIMIT} more)`
          : "";
      return `it has ${dirtyPaths.length} uncommitted file(s) that are not known to be this card's — ${named}${rest}`;
    }

    const run = gitRunner(git, "kanban.openPr.sharedCheckout", cwd);
    const branch = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch === null || branch.length === 0) return "its HEAD is detached";

    const defaultBranch = yield* resolveDefaultBranch(git, cwd);
    const count = yield* run(["rev-list", "--count", `origin/${defaultBranch}..HEAD`]);
    if (count === null) {
      return `git could not compare '${branch}' against origin/${defaultBranch}`;
    }
    const aheadCount = Number.parseInt(count, 10);
    if (!Number.isFinite(aheadCount) || aheadCount <= 0) return null;

    const log = yield* run([
      "log",
      "--format=%h %s",
      `-${REFUSAL_FILE_LIMIT}`,
      `origin/${defaultBranch}..HEAD`,
    ]);
    const commits = log === null ? "" : ` — ${splitLines(log).join("; ")}`;
    return (
      `it is on '${branch}' with ${aheadCount} commit(s) that are not this card's, and ` +
      `committing here would put all of them in one pull request${commits}`
    );
  });
}

/**
 * `null` when the worktree is not mid-merge; the still-unresolved paths
 * otherwise. Without a git driver the answer is always `null` — the pipeline
 * behaves exactly as it did before, cutting a feature branch per pull request.
 */
function describeMidMerge(
  deps: PrPipelineDeps,
  cwd: string,
): Effect.Effect<{ readonly unresolved: ReadonlyArray<string> } | null> {
  return Effect.gen(function* () {
    const git = deps.git;
    if (!git) return null;
    const run = (args: ReadonlyArray<string>) =>
      Effect.result(
        git.execute({
          operation: "kanban.openPr.midMerge",
          cwd,
          args: [...args],
          allowNonZeroExit: true,
        }),
      );

    const mergeHead = yield* run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]);
    if (Result.isFailure(mergeHead) || mergeHead.success.exitCode !== 0) return null;

    const unmerged = yield* run(["diff", "--name-only", "--diff-filter=U"]);
    return {
      unresolved: Result.isSuccess(unmerged) ? splitLines(unmerged.success.stdout) : [],
    };
  });
}

/**
 * Merge the card's PR. A conflicted merge, a failing required check or a
 * missing approval fails here — the card stays in PR and the reason is the
 * forge's own message.
 */
export function runMergePr(
  deps: PrPipelineDeps,
  input: KanbanMergePrInput,
  options: PrPlacement = {},
): Effect.Effect<KanbanMergePrResult, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);
    const prUrl = card.prUrl?.trim();
    if (!prUrl) {
      return yield* fail(
        `Card '${card.title}' has no pull request yet. Move it to PR before merging.`,
      );
    }
    const cwd = yield* resolveForgeCwd(deps, card);

    const provider = yield* deps.sourceControl
      .resolve({ cwd })
      .pipe(
        Effect.catch((cause) =>
          fail(asDetail(cause, "No source control provider for this project."), cause),
        ),
      );

    if (!provider.mergeChangeRequest) {
      return yield* fail(`Merging from the board is not supported for ${provider.kind} yet.`);
    }

    const mergeCommitSha = yield* provider
      .mergeChangeRequest({ cwd, reference: prUrl })
      .pipe(
        Effect.catch((cause) =>
          fail(
            `Could not merge ${prUrl}: ${asDetail(cause, "the forge refused the merge.")}`,
            cause,
          ),
        ),
      );

    const updated = yield* deps.store
      .update({ id: card.id as KanbanCardId, at: options.moveTo ?? SEED_MERGED_COLUMN })
      .pipe(
        Effect.catch((cause) =>
          fail(asDetail(cause, "Merged the pull request but failed to move the card."), cause),
        ),
      );

    return {
      card: updated,
      prUrl,
      mergeCommitSha: mergeCommitSha ?? null,
    } satisfies KanbanMergePrResult;
  });
}

/**
 * Close a pull request without merging it — abandon it, not land it.
 *
 * `input.reference` targets a PR the card does not itself own: an
 * orphan-reconcile card closes the PR named in its own body, which it never
 * held in `prUrl` (nothing ever opened it from that card). Omit it to close
 * the card's own `prUrl` instead. Either way the card is archived: its work
 * here — decide the PR's fate — is done once the forge agrees.
 */
export function runClosePr(
  deps: PrPipelineDeps,
  input: KanbanClosePrInput,
): Effect.Effect<KanbanClosePrResult, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);
    const reference = input.reference?.trim() || card.prUrl?.trim();
    if (!reference) {
      return yield* fail(
        `Card '${card.title}' has no pull request to close. Pass a reference or open one first.`,
      );
    }
    const cwd = yield* resolveForgeCwd(deps, card);

    const provider = yield* deps.sourceControl
      .resolve({ cwd })
      .pipe(
        Effect.catch((cause) =>
          fail(asDetail(cause, "No source control provider for this project."), cause),
        ),
      );

    if (!provider.closeChangeRequest) {
      return yield* fail(
        `Closing a pull request from the board is not supported for ${provider.kind} yet.`,
      );
    }

    yield* provider
      .closeChangeRequest({ cwd, reference })
      .pipe(
        Effect.catch((cause) =>
          fail(
            `Could not close ${reference}: ${asDetail(cause, "the forge refused to close it.")}`,
            cause,
          ),
        ),
      );

    const updated = yield* deps.store
      .update({ id: card.id as KanbanCardId, archived: true })
      .pipe(
        Effect.catch((cause) =>
          fail(asDetail(cause, "Closed the pull request but failed to update the card."), cause),
        ),
      );

    return { card: updated, prUrl: reference, closed: true } satisfies KanbanClosePrResult;
  });
}

/**
 * Merge the PR's base branch into its head branch and push.
 *
 * Hermes calls this once when `runMergePr` fails as un-mergeable. The merge runs
 * in the card's own worktree — restored from the remote head branch when the
 * reaper already took it — so a conflict can be left sitting there for the agent
 * that wrote the code. The shared project checkout is never left half-merged:
 * work landing there is what stacked seven cards onto one branch.
 */
export function runSyncPrBranch(
  deps: PrPipelineDeps & { readonly git: GitVcsDriver.GitVcsDriver["Service"] },
  input: KanbanMergePrInput,
): Effect.Effect<PrSyncResult, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);
    const prUrl = card.prUrl?.trim();
    if (!prUrl) return yield* fail(`Card '${card.title}' has no pull request to sync.`);
    const projectCwd = yield* resolveForgeCwd(deps, card);

    const resolved = yield* deps.gitWorkflow
      .resolvePullRequest({ cwd: projectCwd, reference: prUrl })
      .pipe(
        Effect.catch((cause) => fail(asDetail(cause, "Could not read the pull request."), cause)),
      );
    const { baseBranch, headBranch } = resolved.pullRequest;

    const worktree = yield* restoreCardWorktree(deps, card, { baseBranch, headBranch });
    const cwd = worktree ?? projectCwd;

    const run = (args: ReadonlyArray<string>) =>
      deps.git
        .execute({ operation: "kanban.syncPrBranch", cwd, args: [...args], allowNonZeroExit: true })
        .pipe(Effect.catch((cause) => fail(asDetail(cause, `git ${args[0]} failed.`), cause)));

    yield* run(["fetch", "origin", baseBranch, headBranch]);
    const checkout = yield* run(["checkout", headBranch]);
    if (checkout.exitCode !== 0) {
      return {
        synced: false,
        reason: checkout.stderr.trim() || `cannot check out ${headBranch}`,
        conflict: null,
      };
    }

    const merge = yield* run(["merge", "--no-edit", `origin/${baseBranch}`]);
    if (merge.exitCode === 0) {
      const push = yield* run(["push", "origin", headBranch]);
      if (push.exitCode !== 0) {
        return { synced: false, reason: push.stderr.trim() || "push failed", conflict: null };
      }
      return { synced: true, reason: null, conflict: null };
    }

    const unmerged = yield* run(["diff", "--name-only", "--diff-filter=U"]);
    const files = splitLines(unmerged.stdout).slice(0, CONFLICT_FILE_LIMIT);
    const log = yield* run([
      "log",
      "--no-merges",
      `--max-count=${CONFLICT_COMMIT_LIMIT}`,
      "--format=%h %s",
      `${headBranch}..origin/${baseBranch}`,
    ]);
    const behind = yield* run(["rev-list", "--count", `${headBranch}..origin/${baseBranch}`]);

    // The half-merged tree is the agent's whole workspace for the next round, so
    // it stays exactly where it is — but only when it is the card's own
    // worktree. A half-merged project checkout would poison the next card.
    if (worktree === null) yield* run(["merge", "--abort"]);

    return {
      synced: false,
      reason: `${baseBranch} conflicts with ${headBranch}: ${merge.stdout.trim() || merge.stderr.trim()}`,
      conflict: {
        baseBranch,
        headBranch,
        files,
        baseCommits: splitLines(log.stdout),
        behindCount: Number.parseInt(behind.stdout.trim(), 10) || 0,
        worktreePath: worktree,
      },
    };
  });
}

/**
 * The card's worktree, ready on `headBranch` — recreated when the reaper already
 * took it, which it always has by the time a card sits in PR. Null when the card
 * has no worktree of its own to restore.
 */
function restoreCardWorktree(
  deps: PrPipelineDeps & { readonly git: GitVcsDriver.GitVcsDriver["Service"] },
  card: KanbanCard,
  refs: { readonly baseBranch: string; readonly headBranch: string },
): Effect.Effect<string | null, TextGenerationError> {
  return Effect.gen(function* () {
    if (!card.threadId) return null;
    const shell = yield* Effect.result(threadShellOf(deps, card));
    if (Result.isFailure(shell)) return null;
    // A thread that never had a worktree ran in the project checkout, and
    // `resolveWorkCwd` will send `openPr` back there. Handing it a new worktree
    // now would sync one directory and commit from another.
    if (!shell.success.worktreePath) return null;
    const projectCwd = yield* projectCwdOf(deps, card, shell.success.projectId);
    const worktreePath = shell.success.worktreePath;
    if (worktreePath === projectCwd) return null;
    if (!isThreadWorktreePath({ path: nodeWorktreePath, projectCwd, candidate: worktreePath })) {
      return null;
    }

    const alive = yield* Effect.result(
      deps.git.execute({
        operation: "kanban.syncPrBranch.probeWorktree",
        cwd: worktreePath,
        args: ["rev-parse", "--git-dir"],
        allowNonZeroExit: true,
      }),
    );
    if (Result.isSuccess(alive) && alive.success.exitCode === 0) return worktreePath;

    const created = yield* Effect.result(
      deps.git.createWorktree({
        cwd: projectCwd,
        refName: `origin/${refs.headBranch}`,
        newRefName: refs.headBranch,
        baseRefName: refs.baseBranch,
        path: worktreePath,
      }),
    );
    if (Result.isFailure(created)) {
      yield* Effect.logWarning("could not restore the card's worktree to sync its branch", {
        cardId: card.id,
        worktreePath,
        detail: created.failure.detail ?? created.failure.message,
      });
      return null;
    }
    return created.success.worktree.path;
  });
}

/**
 * Give a card in PR its worktree back before it is sent to Active again.
 *
 * The reaper takes the worktree the moment a card leaves Active, so every rule
 * that bounces a card back — red checks, a base-branch conflict — was pointing
 * its thread at a directory that no longer exists.
 */
export function runRestorePrWorktree(
  deps: PrPipelineDeps & { readonly git: GitVcsDriver.GitVcsDriver["Service"] },
  input: KanbanMergePrInput,
): Effect.Effect<{ readonly worktreePath: string | null }, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);
    const prUrl = card.prUrl?.trim();
    if (!prUrl) return { worktreePath: null };
    const projectCwd = yield* resolveForgeCwd(deps, card);

    const resolved = yield* Effect.result(
      deps.gitWorkflow.resolvePullRequest({ cwd: projectCwd, reference: prUrl }),
    );
    if (Result.isFailure(resolved)) return { worktreePath: null };

    return {
      worktreePath: yield* restoreCardWorktree(deps, card, {
        baseBranch: resolved.success.pullRequest.baseBranch,
        headBranch: resolved.success.pullRequest.headBranch,
      }),
    };
  });
}

/**
 * The forge's verdict on the card's PR checks.
 *
 * `unknown` covers every "we could not tell", and `unknownReason` says which
 * kind: `no_checks` is a forge with nothing to report, `unavailable` is a read
 * that did not answer. Neither is a pass.
 */
export function runPrChecks(
  deps: PrPipelineDeps,
  input: KanbanMergePrInput,
): Effect.Effect<ChangeRequestChecks, TextGenerationError> {
  return Effect.gen(function* () {
    const card = yield* findCard(deps, input.id);
    const prUrl = card.prUrl?.trim();
    if (!prUrl) {
      return unavailableChangeRequestChecks("This card does not have a pull request URL.");
    }
    const cwd = yield* resolveForgeCwd(deps, card);

    const resolved = yield* Effect.result(deps.sourceControl.resolve({ cwd }));
    if (Result.isFailure(resolved)) {
      return unavailableChangeRequestChecks(
        asDetail(resolved.failure, "The source-control provider could not be resolved."),
      );
    }
    const provider = resolved.success;
    if (!provider.getChangeRequestChecks) {
      return unavailableChangeRequestChecks(
        `The ${provider.kind} source-control provider cannot fetch CI checks.`,
      );
    }

    return yield* provider
      .getChangeRequestChecks({ cwd, reference: prUrl })
      .pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            unavailableChangeRequestChecks(
              asDetail(cause, "The forge did not answer the CI check request."),
            ),
          ),
        ),
      );
  });
}
