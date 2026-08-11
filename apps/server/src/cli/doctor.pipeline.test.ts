import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  DoctorRuntimeLive,
  checkPipelineExecutor,
  checkPipelineGuard,
  checkPipelineShip,
  makeOriginRepository,
  type DoctorContext,
} from "./doctor.ts";

const inDoctorWorkDir = <A, E>(
  use: (ctx: DoctorContext, workDir: string) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const sourceControl = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ctx: DoctorContext = { git, sourceControl, fs, path };
      const workDir = yield* fs.makeTempDirectory({ prefix: "t3-doctor-pipeline-" });
      const outcome = yield* Effect.result(use(ctx, workDir));
      yield* Effect.result(fs.remove(workDir, { recursive: true }));
      if (Result.isFailure(outcome)) {
        return yield* Effect.fail(outcome.failure);
      }
      return outcome.success;
    }).pipe(Effect.provide(DoctorRuntimeLive)) as Effect.Effect<A>,
  );

// createWorktree treats a missing `rift` binary as a hard failure on purpose
// (only reflink-unsupported degrades to a plain git worktree), so the ship
// check can only run where rift-snapshot is installed — the VPS, via selftest.
const hasRift =
  NodeChildProcess.spawnSync("rift", ["--version"], { stdio: "ignore" }).error === undefined;

describe("doctor pipeline checks", () => {
  it.skipIf(!hasRift)(
    "ships: worktree from fetched origin, commit, push back to the origin",
    async () => {
      // Keep the worktree store inside the temp dir for the duration of the run.
      const previous = process.env["T3CODE_WORKTREE_ROOT"];
      delete process.env["T3CODE_WORKTREE_ROOT"];
      try {
        const detail = await inDoctorWorkDir((ctx, workDir) =>
          Effect.gen(function* () {
            const origin = yield* makeOriginRepository(ctx, workDir);
            return yield* checkPipelineShip(ctx, workDir, origin);
          }),
        );
        expect(detail).toContain("pushed t3-doctor/pipeline");
      } finally {
        if (previous !== undefined) process.env["T3CODE_WORKTREE_ROOT"] = previous;
      }
    },
    60_000,
  );

  it("guards: refuses planted secrets and passes clean files", async () => {
    const detail = await Effect.runPromise(checkPipelineGuard as Effect.Effect<string>);
    expect(detail).toContain("refused");
  });

  it("executes a board.* program in the QuickJS sandbox", async () => {
    const detail = await Effect.runPromise(checkPipelineExecutor as Effect.Effect<string>);
    expect(detail).toContain("QuickJS");
  }, 30_000);
});
