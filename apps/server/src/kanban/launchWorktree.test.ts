import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as NodePath from "node:path";

import { GitCommandError, type VcsCreateWorktreeInput } from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { launchWorktreePreparerOption } from "./launchWorktree.ts";

const PROJECT_CWD = "/root/projects/demo";

const gitLayer = (
  created: Array<VcsCreateWorktreeInput>,
  options: {
    readonly isRepo?: boolean;
    readonly listRefs?: "fail";
    readonly resolveRemote?: "fail";
    readonly resolvedRefNames?: Array<string>;
    /** What the project checkout's HEAD and worktree look like. */
    readonly checkout?: { readonly branch: string; readonly dirty?: boolean };
    /** Records every `git.execute` argv, so the restore can be asserted on. */
    readonly gitCalls?: Array<ReadonlyArray<string>>;
  } = {},
) =>
  Layer.succeed(GitVcsDriver.GitVcsDriver, {
    listRefs: () =>
      options.listRefs === "fail"
        ? Effect.fail(
            new GitCommandError({
              operation: "listRefs",
              command: "git",
              cwd: PROJECT_CWD,
              detail: "not a git repository (or any parent)",
            }),
          )
        : Effect.succeed({
            refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
            isRepo: options.isRepo !== false,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
          }),
    fetchRemote: () => Effect.void,
    resolveRemoteTrackingCommit: (input: { readonly refName: string }) =>
      Effect.sync(() => {
        options.resolvedRefNames?.push(input.refName);
      }).pipe(
        Effect.andThen(() =>
          options.resolveRemote === "fail"
            ? Effect.fail(
                new GitCommandError({
                  operation: "resolveRemoteTrackingCommit",
                  command: "git",
                  cwd: PROJECT_CWD,
                  detail: "no such remote ref",
                }),
              )
            : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/main" }),
        ),
      ),
    execute: (input: { readonly args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        options.gitCalls?.push(input.args);
        const [command] = input.args;
        if (command === "symbolic-ref") {
          return { exitCode: 0, stdout: options.checkout?.branch ?? "main", stderr: "" };
        }
        if (command === "status") {
          return {
            exitCode: 0,
            stdout: options.checkout?.dirty === true ? " M src/app.ts" : "",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    createWorktree: (input: VcsCreateWorktreeInput) =>
      Effect.sync(() => {
        created.push(input);
        return { worktree: { path: input.path ?? "", refName: input.newRefName ?? input.refName } };
      }),
  } as unknown as GitVcsDriver.GitVcsDriver["Service"]);

const prepareBoth = (created: Array<VcsCreateWorktreeInput>) =>
  Effect.gen(function* () {
    const preparer = yield* launchWorktreePreparerOption;
    if (!preparer) throw new Error("expected a worktree preparer when a git driver is in context");
    const first = yield* preparer.prepare({
      projectCwd: PROJECT_CWD,
      threadId: "11111111-1111-4111-8111-111111111111",
      branch: "t3/worktree/aaaa1111",
    });
    const second = yield* preparer.prepare({
      projectCwd: PROJECT_CWD,
      threadId: "22222222-2222-4222-8222-222222222222",
      branch: "t3/worktree/bbbb2222",
    });
    if (first.kind !== "prepared" || second.kind !== "prepared") {
      throw new Error("expected a git checkout to be prepared");
    }
    return { first, second };
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer(created), NodeServices.layer)));

describe("launchWorktree", () => {
  it.effect("gives two launches from the same project and base branch two directories", () =>
    Effect.gen(function* () {
      const created: Array<VcsCreateWorktreeInput> = [];
      const { first, second } = yield* prepareBoth(created);

      assert.equal(created.length, 2);
      assert.equal(created[0]?.baseRefName, "main");
      assert.equal(created[1]?.baseRefName, "main");
      assert.notEqual(first.worktreePath, second.worktreePath);
      assert.notEqual(first.branch, second.branch);
    }),
  );

  it.effect("asks for an absolute, thread-scoped path under the workspace root", () =>
    Effect.gen(function* () {
      const created: Array<VcsCreateWorktreeInput> = [];
      const { first } = yield* prepareBoth(created);

      assert.isTrue(NodePath.isAbsolute(first.worktreePath));
      assert.equal(NodePath.dirname(first.worktreePath), "/root/projects/.worktrees/demo");
      // The branch is metadata; it must not appear in the directory name.
      assert.isFalse(NodePath.basename(first.worktreePath).includes("aaaa1111"));
      assert.isTrue(NodePath.basename(first.worktreePath).startsWith("thread-"));
    }),
  );

  it.effect("starts new work from freshly fetched origin, not the local checkout", () =>
    Effect.gen(function* () {
      const created: Array<VcsCreateWorktreeInput> = [];
      yield* prepareBoth(created);

      assert.equal(created[0]?.refName, "abc123");
    }),
  );

  it.effect("puts a project checkout parked on another card's branch back on its base", () => {
    const gitCalls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const preparer = yield* launchWorktreePreparerOption;
      if (!preparer) throw new Error("expected a worktree preparer");
      yield* preparer.prepare({
        projectCwd: PROJECT_CWD,
        threadId: "66666666-6666-4666-8666-666666666666",
        branch: "t3/worktree/ffff6666",
      });

      assert.deepEqual(
        gitCalls.find((args) => args[0] === "switch"),
        ["switch", "main"],
      );
      // Fast-forward only: the checkout tracks the remote, it never rewrites it.
      assert.deepEqual(
        gitCalls.find((args) => args[0] === "merge"),
        ["merge", "--ff-only", "origin/main"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          gitLayer([], { checkout: { branch: "feature/previous-card" }, gitCalls }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("never throws away uncommitted work it finds in the project checkout", () => {
    const gitCalls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const preparer = yield* launchWorktreePreparerOption;
      if (!preparer) throw new Error("expected a worktree preparer");
      yield* preparer.prepare({
        projectCwd: PROJECT_CWD,
        threadId: "77777777-7777-4777-8777-777777777777",
        branch: "t3/worktree/aaaa7777",
      });

      assert.isUndefined(gitCalls.find((args) => args[0] === "switch"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          gitLayer([], { checkout: { branch: "feature/previous-card", dirty: true }, gitCalls }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect(
    "refuses to branch when origin cannot be resolved, rather than using the local ref",
    () =>
      Effect.gen(function* () {
        const preparer = yield* launchWorktreePreparerOption;
        if (!preparer) throw new Error("expected a worktree preparer");
        const outcome = yield* Effect.result(
          preparer.prepare({
            projectCwd: PROJECT_CWD,
            threadId: "33333333-3333-4333-8333-333333333333",
            branch: "t3/worktree/cccc3333",
          }),
        );

        assert.isTrue(Result.isFailure(outcome));
        if (Result.isFailure(outcome)) {
          assert.include(outcome.failure.detail, "origin/main could not be resolved");
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(gitLayer([], { resolveRemote: "fail" }), NodeServices.layer)),
      ),
  );

  it.effect("refuses rather than guessing `main` when git cannot say what the base branch is", () =>
    Effect.gen(function* () {
      const preparer = yield* launchWorktreePreparerOption;
      if (!preparer) throw new Error("expected a worktree preparer");
      const outcome = yield* Effect.result(
        preparer.prepare({
          projectCwd: PROJECT_CWD,
          threadId: "55555555-5555-4555-8555-555555555555",
          branch: "t3/worktree/eeee5555",
        }),
      );

      assert.isTrue(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) {
        assert.include(outcome.failure.detail, "could not list refs");
        assert.include(outcome.failure.detail, "not a git repository");
      }
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer([], { listRefs: "fail" }), NodeServices.layer))),
  );

  it.effect("cuts the worktree from the base branch the caller asked for", () => {
    const created: Array<VcsCreateWorktreeInput> = [];
    const resolvedRefNames: Array<string> = [];
    return Effect.gen(function* () {
      const preparer = yield* launchWorktreePreparerOption;
      if (!preparer) throw new Error("expected a worktree preparer");
      yield* preparer.prepare({
        projectCwd: PROJECT_CWD,
        threadId: "44444444-4444-4444-8444-444444444444",
        branch: "t3/worktree/dddd4444",
        baseBranch: "integration/next",
      });

      assert.equal(created[0]?.baseRefName, "integration/next");
      assert.deepEqual([...resolvedRefNames], ["integration/next"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(gitLayer(created, { resolvedRefNames }), NodeServices.layer)),
    );
  });

  it.effect("reports a project with no git instead of failing the launch", () =>
    Effect.gen(function* () {
      const preparer = yield* launchWorktreePreparerOption;
      if (!preparer) throw new Error("expected a worktree preparer");
      const outcome = yield* preparer.prepare({
        projectCwd: PROJECT_CWD,
        threadId: "55555555-5555-4555-8555-555555555555",
        branch: "t3/worktree/eeee5555",
      });

      assert.equal(outcome.kind, "not_a_repo");
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer([], { isRepo: false }), NodeServices.layer))),
  );
});
