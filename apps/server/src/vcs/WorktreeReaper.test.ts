import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ThreadId } from "@t3tools/contracts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeReaper from "./WorktreeReaper.ts";
import { buildThreadWorktreePath } from "./worktreeLayout.ts";

const PROJECT_CWD = "/root/projects/demo";
const PROJECT_ID = "project-1";
const THREAD_ID = ThreadId.make("11111111-1111-4111-8111-111111111111");

const nodePath = {
  join: (...segments: ReadonlyArray<string>) => segments.join("/"),
  resolve: (value: string) => value,
  dirname: (value: string) => value.slice(0, value.lastIndexOf("/")),
  isAbsolute: (value: string) => value.startsWith("/"),
};

const threadWorktree = buildThreadWorktreePath({
  path: nodePath,
  projectCwd: PROJECT_CWD,
  threadId: THREAD_ID,
  env: {},
});

const projectionLayer = (worktreePath: string | null, opts?: { archivedOnly?: boolean }) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: () =>
      Effect.succeed(
        opts?.archivedOnly
          ? Option.none()
          : Option.some({
              id: THREAD_ID,
              projectId: PROJECT_ID,
              worktreePath,
            }),
      ),
    getArchivedShellSnapshot: () =>
      Effect.succeed({
        threads: opts?.archivedOnly ? [{ id: THREAD_ID, projectId: PROJECT_ID, worktreePath }] : [],
      }),
    getShellSnapshot: () =>
      Effect.succeed({
        projects: [{ id: PROJECT_ID, workspaceRoot: PROJECT_CWD }],
        threads: [],
      }),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

const gitLayer = (input: {
  readonly hasWorkingTreeChanges: boolean;
  readonly removed: Array<{ path: string; force: boolean | undefined }>;
}) =>
  Layer.succeed(GitVcsDriver.GitVcsDriver, {
    statusDetailsLocal: () =>
      Effect.succeed({ hasWorkingTreeChanges: input.hasWorkingTreeChanges }),
    removeWorktree: (removeInput: { path: string; force?: boolean }) =>
      Effect.sync(() => {
        input.removed.push({ path: removeInput.path, force: removeInput.force });
      }),
  } as unknown as GitVcsDriver.GitVcsDriver["Service"]);

const engineLayer = (dispatched: Array<{ threadId: string; worktreePath: string | null }>) =>
  Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
    dispatch: (command: { type: string; threadId?: string; worktreePath?: string | null }) => {
      if (command.type === "thread.meta.update") {
        dispatched.push({
          threadId: String(command.threadId),
          worktreePath: command.worktreePath ?? null,
        });
      }
      return Effect.succeed({ sequence: 1 });
    },
  } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);

const run = (input: {
  readonly worktreePath: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly removed: Array<{ path: string; force: boolean | undefined }>;
  readonly dispatched?: Array<{ threadId: string; worktreePath: string | null }>;
  readonly archivedOnly?: boolean;
}) =>
  Effect.gen(function* () {
    const reaper = yield* WorktreeReaper.WorktreeReaper;
    return yield* reaper.reapThreadWorktree(THREAD_ID);
  }).pipe(
    Effect.provide(
      WorktreeReaper.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            projectionLayer(input.worktreePath, { archivedOnly: input.archivedOnly ?? false }),
            gitLayer({
              hasWorkingTreeChanges: input.hasWorkingTreeChanges,
              removed: input.removed,
            }),
            engineLayer(input.dispatched ?? []),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("WorktreeReaper", () => {
  it.effect("removes a clean thread worktree when the thread goes away", () =>
    Effect.gen(function* () {
      const removed: Array<{ path: string; force: boolean | undefined }> = [];
      const dispatched: Array<{ threadId: string; worktreePath: string | null }> = [];
      const outcome = yield* run({
        worktreePath: threadWorktree,
        hasWorkingTreeChanges: false,
        removed,
        dispatched,
      });

      assert.equal(outcome.kind, "removed");
      assert.deepEqual(
        removed.map((entry) => entry.path),
        [threadWorktree],
      );
      // Never force: a surprise on disk must surface, not be bulldozed.
      assert.equal(removed[0]?.force, false);
      // The thread's own record must stop pointing at a directory that is
      // now gone, or the next thing that trusts it finds nothing there.
      assert.deepEqual(dispatched, [{ threadId: THREAD_ID, worktreePath: null }]);
    }),
  );

  it.effect("still reaps a thread that was archived before the reap ran", () =>
    Effect.gen(function* () {
      // The ws archive handler dispatches `thread.archive` first, so by the
      // time the reap runs the active-only lookup misses. The archived shell
      // must cover it or every archive-triggered reap dies as "not found".
      const removed: Array<{ path: string; force: boolean | undefined }> = [];
      const outcome = yield* run({
        worktreePath: threadWorktree,
        hasWorkingTreeChanges: false,
        removed,
        archivedOnly: true,
      });

      assert.equal(outcome.kind, "removed");
      assert.deepEqual(
        removed.map((entry) => entry.path),
        [threadWorktree],
      );
    }),
  );

  it.effect("keeps — and reports — a worktree with uncommitted changes", () =>
    Effect.gen(function* () {
      const removed: Array<{ path: string; force: boolean | undefined }> = [];
      const outcome = yield* run({
        worktreePath: threadWorktree,
        hasWorkingTreeChanges: true,
        removed,
      });

      assert.equal(outcome.kind, "skipped");
      assert.equal(
        outcome.kind === "skipped" ? outcome.reason : "",
        "worktree has uncommitted changes",
      );
      assert.deepEqual(removed, []);
    }),
  );

  it.effect("never removes the project checkout itself", () =>
    Effect.gen(function* () {
      const removed: Array<{ path: string; force: boolean | undefined }> = [];
      const outcome = yield* run({
        worktreePath: PROJECT_CWD,
        hasWorkingTreeChanges: false,
        removed,
      });

      assert.equal(outcome.kind, "skipped");
      assert.deepEqual(removed, []);
    }),
  );

  it.effect("ignores a thread that owns no worktree", () =>
    Effect.gen(function* () {
      const removed: Array<{ path: string; force: boolean | undefined }> = [];
      const outcome = yield* run({
        worktreePath: null,
        hasWorkingTreeChanges: false,
        removed,
      });

      assert.equal(outcome.kind, "skipped");
      assert.deepEqual(removed, []);
    }),
  );
});
