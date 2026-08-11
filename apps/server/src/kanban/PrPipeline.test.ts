import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";

import type { KanbanCard, KanbanCardId, ProjectId, ThreadId } from "@t3tools/contracts";
import { runMergePr, runOpenPr, type PrPipelineDeps } from "./PrPipeline.ts";

const PROJECT_ID = "project-1" as ProjectId;
const PROJECT_CWD = "/root/projects/demo";
const THREAD_ID = "thread-1" as ThreadId;
const WORKTREE = "/root/projects/.worktrees/thread-thread-1";

const card = (overrides: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "card-1" as KanbanCardId,
    title: "Fix the toast",
    body: "Mission: fix it",
    at: "active",
    position: 0,
    threadId: THREAD_ID,
    prUrl: null,
    projectId: PROJECT_ID,
    modelSelection: null,
    prepStatus: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as KanbanCard;

interface HarnessOptions {
  readonly stackedAction?: unknown;
  readonly stackedActionError?: Error;
  readonly mergeError?: Error;
  readonly mergeCommitSha?: string | null;
  /** Simulate a forge whose CLI cannot merge non-interactively. */
  readonly withoutMergeSupport?: boolean;
  readonly worktreePath?: string | null;
  /** Progress lines git wrote before the action settled. */
  readonly gitOutputLines?: ReadonlyArray<string>;
  /** What the worktree would commit, for the pre-push guard. */
  readonly worktreeFiles?: ReadonlyArray<string>;
  /** The card's workspace is gone — the reaper removed it on an earlier move. */
  readonly workspaceMissing?: boolean;
  /** The workspace is there but was never a git repository. */
  readonly workspaceNotARepo?: boolean;
  /** A failing critical health check the box would be blocked on. */
  readonly preflightBlock?: { readonly checkId: string; readonly detail: string };
  /** What the checkout's HEAD looks like, for the shared-checkout gate. */
  readonly checkout?: { readonly branch: string; readonly aheadOfDefault: number };
  /** Commit subjects `git log` reports for the ahead range. */
  readonly aheadCommits?: ReadonlyArray<string>;
  /** Thread shell project id when it disagrees with the card (e.g. catch-all `/`). */
  readonly threadProjectId?: ProjectId;
  /** Map of projectId → workspaceRoot for multi-project resolution tests. */
  readonly projectRoots?: Readonly<Record<string, string>>;
}

const makeHarness = (initial: KanbanCard, options: HarnessOptions = {}) => {
  const stored = new Map<string, KanbanCard>([[initial.id as string, initial]]);
  const stackedActionCalls: Array<Record<string, unknown>> = [];
  const mergeCalls: Array<{ cwd: string; reference: string }> = [];

  const defaultStacked = {
    action: "commit_push_pr",
    branch: { status: "created", name: "t3/feature" },
    commit: { status: "created", commitSha: "abc1234" },
    push: { status: "pushed" },
    pr: { status: "created", url: "https://github.com/o/r/pull/7", number: 7 },
    toast: { title: "ok", cta: { kind: "none" } },
  };

  const projectRoots: Readonly<Record<string, string>> = {
    [PROJECT_ID]: PROJECT_CWD,
    ...(options.projectRoots ?? {}),
  };

  const deps: PrPipelineDeps = {
    store: {
      list: () => Effect.succeed({ cards: [...stored.values()] }),
      update: (input: { id: KanbanCardId; [key: string]: unknown }) =>
        Effect.sync(() => {
          const current = stored.get(input.id as string);
          if (!current) throw new Error(`no card ${input.id}`);
          const next = { ...current, ...input } as KanbanCard;
          stored.set(input.id as string, next);
          return next;
        }),
    } as unknown as PrPipelineDeps["store"],
    projection: {
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            id: THREAD_ID,
            projectId: options.threadProjectId ?? PROJECT_ID,
            worktreePath:
              options.worktreePath === undefined ? WORKTREE : (options.worktreePath ?? null),
          }),
        ),
      getProjectShellById: (projectId: ProjectId) => {
        const workspaceRoot = projectRoots[projectId];
        if (workspaceRoot === undefined) {
          return Effect.succeed(Option.none());
        }
        return Effect.succeed(Option.some({ id: projectId, workspaceRoot }));
      },
    } as unknown as PrPipelineDeps["projection"],
    gitWorkflow: {
      localStatus: () =>
        options.workspaceMissing === true
          ? Effect.fail(new Error("git manager failed"))
          : Effect.succeed({
              isRepo: options.workspaceNotARepo !== true,
              workingTree: {
                files: (options.worktreeFiles ?? ["src/app.ts"]).map((path) => ({
                  path,
                  insertions: 1,
                  deletions: 0,
                })),
              },
            }),
      runStackedAction: (
        input: Record<string, unknown>,
        callOptions?: {
          progressReporter?: { publish: (event: Record<string, unknown>) => unknown };
        },
      ) => {
        stackedActionCalls.push(input);
        for (const line of options.gitOutputLines ?? []) {
          callOptions?.progressReporter?.publish({
            kind: "hook_output",
            hookName: null,
            stream: "stderr",
            text: line,
          });
        }
        return options.stackedActionError
          ? Effect.fail(options.stackedActionError)
          : Effect.succeed(options.stackedAction ?? defaultStacked);
      },
    } as unknown as PrPipelineDeps["gitWorkflow"],
    sourceControl: {
      resolve: () =>
        Effect.succeed({
          kind: "github",
          ...(options.withoutMergeSupport
            ? {}
            : {
                mergeChangeRequest: (input: { cwd: string; reference: string }) => {
                  mergeCalls.push(input);
                  return options.mergeError
                    ? Effect.fail(options.mergeError)
                    : Effect.succeed(options.mergeCommitSha ?? "deadbee");
                },
              }),
        }),
    } as unknown as PrPipelineDeps["sourceControl"],
    crypto: { randomUUIDv4: Effect.succeed("uuid-1") },
    preflight: { check: async () => options.preflightBlock ?? null },
    ...(options.checkout
      ? {
          git: {
            execute: (input: { args: ReadonlyArray<string> }) => {
              const [command, ...rest] = input.args;
              if (command === "symbolic-ref") {
                return Effect.succeed(
                  rest.includes("refs/remotes/origin/HEAD")
                    ? { exitCode: 0, stdout: "origin/main", stderr: "" }
                    : { exitCode: 0, stdout: options.checkout!.branch, stderr: "" },
                );
              }
              if (command === "rev-list") {
                return Effect.succeed({
                  exitCode: 0,
                  stdout: String(options.checkout!.aheadOfDefault),
                  stderr: "",
                });
              }
              if (command === "log") {
                return Effect.succeed({
                  exitCode: 0,
                  stdout: (options.aheadCommits ?? []).join("\n"),
                  stderr: "",
                });
              }
              return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" });
            },
          } as unknown as NonNullable<PrPipelineDeps["git"]>,
        }
      : {}),
  };

  return { deps, stored, stackedActionCalls, mergeCalls };
};

describe("runOpenPr", () => {
  it("refuses to commit from a shared checkout parked on the last card's branch", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        worktreePath: PROJECT_CWD,
        worktreeFiles: [],
        checkout: { branch: "feature/previous-card", aheadOfDefault: 6 },
        aheadCommits: ["a27274e rename the toast module"],
      });
      const result = yield* Effect.result(
        runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.detail, "feature/previous-card");
        assert.include(result.failure.detail, "6 commit(s) that are not this card's");
        assert.include(result.failure.detail, "a27274e rename the toast module");
      }
      // Nothing was committed, so nothing swept the other cards in.
      assert.equal(harness.stackedActionCalls.length, 0);
    }));

  it("refuses a shared checkout on its default branch with unpushed commits", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        worktreePath: PROJECT_CWD,
        worktreeFiles: [],
        checkout: { branch: "main", aheadOfDefault: 2 },
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.include(failure.detail ?? "", "'main' with 2 commit(s) that are not this card's");
      assert.equal(harness.stackedActionCalls.length, 0);
    }));

  it("refuses a dirty shared checkout, naming what it will not wrap up", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        worktreePath: PROJECT_CWD,
        worktreeFiles: ["docs/HERMES.md", "src/unrelated.ts"],
        checkout: { branch: "main", aheadOfDefault: 0 },
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.include(failure.detail ?? "", "2 uncommitted file(s)");
      assert.include(failure.detail ?? "", "docs/HERMES.md");
      assert.equal(harness.stackedActionCalls.length, 0);
    }));

  it("refuses a shared checkout when there is no git driver to inspect it with", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), { worktreePath: PROJECT_CWD });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.include(failure.detail ?? "", "no git driver");
      assert.equal(harness.stackedActionCalls.length, 0);
    }));

  it("reuses an existing PR when the clean worktree's commits are all on the remote", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        worktreeFiles: [],
        checkout: { branch: "feature/card-1", aheadOfDefault: 0 },
        stackedAction: {
          action: "commit_push_pr",
          branch: { status: "existing", name: "feature/card-1" },
          commit: { status: "skipped_no_changes" },
          push: { status: "skipped_no_changes" },
          pr: { status: "opened_existing", url: "https://github.com/o/r/pull/9", number: 9 },
          toast: { title: "ok", cta: { kind: "none" } },
        },
      });
      const result = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId });

      assert.equal(result.prUrl, "https://github.com/o/r/pull/9");
      assert.equal(result.reusedExistingPr, true);
      assert.equal(result.commitSha, null);
      assert.equal(result.card.at, "pr");
      assert.equal(result.card.prUrl, "https://github.com/o/r/pull/9");
      assert.equal(harness.stackedActionCalls.length, 1);
      assert.equal(harness.stackedActionCalls[0]?.["featureBranch"], false);
    }).pipe(Effect.runPromise));

  it("commits, pushes and opens the PR in the thread's own worktree", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card());
      const result = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId });

      assert.equal(result.prUrl, "https://github.com/o/r/pull/7");
      assert.equal(result.reusedExistingPr, false);
      assert.equal(result.commitSha, "abc1234");
      assert.equal(result.card.at, "pr");
      assert.equal(result.card.prUrl, "https://github.com/o/r/pull/7");
      assert.deepEqual(harness.stackedActionCalls[0]?.["cwd"], WORKTREE);
      assert.deepEqual(harness.stackedActionCalls[0]?.["action"], "commit_push_pr");
      assert.deepEqual(harness.stackedActionCalls[0]?.["featureBranch"], true);
    }).pipe(Effect.runPromise));

  it("refuses to commit a secret the agent left in the worktree", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), { worktreeFiles: ["src/app.ts", ".env"] });

      const outcome = yield* Effect.result(
        runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? (outcome.failure.detail ?? "") : "";
      assert.include(detail, ".env");
      assert.include(detail, "Remove or ignore the file");
      // Nothing was committed or pushed.
      assert.equal(harness.stackedActionCalls.length, 0);
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));

  it("refuses a thread with no worktree instead of committing the shared checkout", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), { worktreePath: null });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.include(failure.detail ?? "", PROJECT_CWD);
      assert.include(failure.detail ?? "", "no workspace of its own");
      assert.equal(harness.stackedActionCalls.length, 0);
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));

  it("names the reaped worktree instead of handing git a path that is gone", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), { workspaceMissing: true });

      const outcome = yield* Effect.result(
        runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? (outcome.failure.detail ?? "") : "";
      assert.include(detail, WORKTREE);
      assert.include(detail, "Relaunch this card");
      assert.equal(harness.stackedActionCalls.length, 0);
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));

  it("says so when the workspace is no longer a git repository", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), { workspaceNotARepo: true });

      const outcome = yield* Effect.result(
        runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? (outcome.failure.detail ?? "") : "";
      assert.include(detail, WORKTREE);
      assert.include(detail, "Relaunch this card");
      assert.equal(harness.stackedActionCalls.length, 0);
    }).pipe(Effect.runPromise));

  it("names the card's own project in the refusal when the thread still points at /", () =>
    Effect.gen(function* () {
      const rootProjectId = "project-root" as ProjectId;
      const harness = makeHarness(card({ projectId: PROJECT_ID }), {
        worktreePath: null,
        threadProjectId: rootProjectId,
        projectRoots: {
          [PROJECT_ID]: PROJECT_CWD,
          [rootProjectId]: "/",
        },
      });

      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.include(failure.detail ?? "", PROJECT_CWD);
    }).pipe(Effect.runPromise));

  it("hands the card's mission to commit and PR text generation", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card({ title: "Fix the toast", body: "Mission: fix it" }));
      yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId });

      assert.equal(harness.stackedActionCalls[0]?.["mission"], "Fix the toast\n\nMission: fix it");
    }).pipe(Effect.runPromise));

  it("reports reuse when the branch already had an open PR", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        stackedAction: {
          action: "commit_push_pr",
          branch: { status: "skipped_not_requested" },
          commit: { status: "created", commitSha: "beef123" },
          push: { status: "pushed" },
          pr: { status: "opened_existing", url: "https://github.com/o/r/pull/7" },
          toast: { title: "ok", cta: { kind: "none" } },
        },
      });
      const result = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId });
      assert.equal(result.reusedExistingPr, true);
    }).pipe(Effect.runPromise));

  it("refuses a card with no coding thread", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card({ threadId: null }));
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /no coding thread/i);
      assert.equal(harness.stackedActionCalls.length, 0);
    }).pipe(Effect.runPromise));

  it("says so when the worktree had nothing to propose", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        stackedAction: {
          action: "commit_push_pr",
          branch: { status: "skipped_not_requested" },
          commit: { status: "skipped_no_changes" },
          push: { status: "skipped_up_to_date" },
          pr: { status: "skipped_not_requested" },
          toast: { title: "ok", cta: { kind: "none" } },
        },
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /no changes to propose/i);
      // The card must stay put when nothing was opened.
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));

  it("leaves the card in place when git fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        stackedActionError: new Error("failed to push some refs"),
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /failed to push some refs/);
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));

  it("appends git's own output when the redacted error says nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        stackedActionError: new Error(
          "Git command failed in GitVcsDriver.commit.commit (/w): Git command exited with a non-zero status.",
        ),
        gitOutputLines: ["fatal: unable to auto-detect email address (got 'root@vps.(none)')"],
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /git: fatal: unable to auto-detect email address/);
    }).pipe(Effect.runPromise));

  it("names the failing health check instead of running git on a sick box", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card(), {
        preflightBlock: {
          checkId: "disk.headroom",
          detail: "0.4GiB free of 40.0GiB — run deploy/reclaim-disk.sh",
        },
      });
      const failure = yield* runOpenPr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /disk\.headroom/);
      assert.match(failure.detail ?? "", /reclaim-disk\.sh/);
      assert.equal(harness.stackedActionCalls.length, 0);
      assert.equal(harness.stored.get("card-1")?.at, "active");
    }).pipe(Effect.runPromise));
});

describe("runMergePr", () => {
  const prCard = card({ at: "pr", prUrl: "https://github.com/o/r/pull/7" });

  it("merges from the project checkout, not the reaped thread worktree", () =>
    Effect.gen(function* () {
      const harness = makeHarness(prCard);
      const result = yield* runMergePr(harness.deps, { id: "card-1" as KanbanCardId });

      assert.equal(result.card.at, "done");
      assert.equal(result.mergeCommitSha, "deadbee");
      // Leaving Active reaps the worktree, so that directory is usually gone.
      assert.deepEqual(harness.mergeCalls, [
        { cwd: PROJECT_CWD, reference: "https://github.com/o/r/pull/7" },
      ]);
    }).pipe(Effect.runPromise));

  it("keeps the card in PR and surfaces the forge's reason on a conflict", () =>
    Effect.gen(function* () {
      const harness = makeHarness(prCard, {
        mergeError: new Error(
          "Pull request is not mergeable: the merge commit cannot be cleanly created",
        ),
      });
      const failure = yield* runMergePr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );

      assert.match(failure.detail ?? "", /not mergeable/i);
      assert.equal(harness.stored.get("card-1")?.at, "pr");
    }).pipe(Effect.runPromise));

  it("refuses a card with no pull request", () =>
    Effect.gen(function* () {
      const harness = makeHarness(card({ at: "pr", prUrl: null }));
      const failure = yield* runMergePr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /no pull request/i);
      assert.equal(harness.mergeCalls.length, 0);
    }).pipe(Effect.runPromise));

  it("says merging is unsupported rather than silently moving the card", () =>
    Effect.gen(function* () {
      const harness = makeHarness(prCard, { withoutMergeSupport: true });
      const failure = yield* runMergePr(harness.deps, { id: "card-1" as KanbanCardId }).pipe(
        Effect.flip,
      );
      assert.match(failure.detail ?? "", /not supported for github/i);
      assert.equal(harness.stored.get("card-1")?.at, "pr");
    }).pipe(Effect.runPromise));
});
