import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { runHermesProgram } from "../kanban/hermes/executor.ts";
import { makeFakeBoardApi } from "../kanban/hermes/fakeBoardApi.ts";
import type { RulePolicy } from "../kanban/hermes/rulePass.ts";
import { makeLaunchWorktreePreparerFrom } from "../kanban/launchWorktree.ts";
import { runPrePushGuard, type PrePushGuardIo } from "../kanban/prePushGuard.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { buildThreadWorktreePath, nodeWorktreePath } from "../vcs/worktreeLayout.ts";

// The doctor exercises the source-control and worktree operations that broke on
// prod (delete → re-add clone into a pre-existing directory; new-worktree on a
// filesystem without copy-on-write reflink support) against THIS box's real
// filesystem, using the actual services rather than a stub. Any failure exits
// non-zero so a post-deploy self-test can gate on it.

export class DoctorChecksFailedError extends Schema.TaggedErrorClass<DoctorChecksFailedError>()(
  "DoctorChecksFailedError",
  {
    operation: Schema.Literal("t3 doctor"),
    failedChecks: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `t3 doctor: ${this.failedChecks.length} check(s) failed: ${this.failedChecks.join(", ")}.`;
  }
}

// SourceControlRepositoryService requires a provider registry in its layer
// graph, but every doctor clone uses an explicit remoteUrl and therefore never
// touches a provider. A stub keeps the whole GitHub/GitLab/... provider stack
// (and its CLI probes) out of the diagnostic.
const stubProviderRegistry = SourceControlProviderRegistry.SourceControlProviderRegistry.of({
  get: () => Effect.die("source-control providers are not initialized in `t3 doctor`"),
  resolveHandle: () => Effect.die("source-control providers are not initialized in `t3 doctor`"),
  resolve: () => Effect.die("source-control providers are not initialized in `t3 doctor`"),
  discover: Effect.succeed([]),
});

// Every check funnels its own failure type into this one so the runner has a
// typed error channel instead of `unknown`; `detail` is what the FAIL line prints.
export class DoctorCheckFailedError extends Schema.TaggedErrorClass<DoctorCheckFailedError>()(
  "DoctorCheckFailedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { detail?: unknown; message?: unknown };
    if (typeof record.detail === "string" && record.detail.length > 0) {
      return record.detail;
    }
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
  }
  return String(error);
};

export interface DoctorContext {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly sourceControl: SourceControlRepositoryService.SourceControlRepositoryService["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

const runGit = (ctx: DoctorContext, cwd: string, args: ReadonlyArray<string>) =>
  ctx.git.execute({ operation: "t3.doctor.git", cwd, args, timeoutMs: 60_000 });

// Build a bare "origin" repository (with one commit on `main`) that clone and
// worktree checks can target via a filesystem URL — no network required.
export const makeOriginRepository = (ctx: DoctorContext, workDir: string) =>
  Effect.gen(function* () {
    const seed = ctx.path.join(workDir, "seed");
    const origin = ctx.path.join(workDir, "origin.git");
    yield* ctx.fs.makeDirectory(seed, { recursive: true });
    yield* runGit(ctx, workDir, ["init", "--bare", origin]);
    yield* runGit(ctx, seed, ["init"]);
    yield* runGit(ctx, seed, ["config", "user.email", "doctor@t3j.local"]);
    yield* runGit(ctx, seed, ["config", "user.name", "t3 doctor"]);
    yield* ctx.fs.writeFileString(ctx.path.join(seed, "README.md"), "# t3 doctor seed\n");
    yield* runGit(ctx, seed, ["add", "."]);
    yield* runGit(ctx, seed, ["commit", "-m", "seed"]);
    yield* runGit(ctx, seed, ["branch", "-M", "main"]);
    yield* runGit(ctx, seed, ["remote", "add", "origin", origin]);
    yield* runGit(ctx, seed, ["push", "origin", "main"]);
    yield* runGit(ctx, origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return origin;
  });

const assert = (condition: boolean, detail: string) =>
  condition ? Effect.void : Effect.fail(new DoctorCheckFailedError({ detail }));

const asCheckFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, (cause) => new DoctorCheckFailedError({ detail: describeError(cause) }));

// Each check returns a short success detail or fails; the runner turns that into
// a PASS/FAIL line and records failures for the final exit code.
const checkCloneFresh = (ctx: DoctorContext, workDir: string, origin: string) =>
  Effect.gen(function* () {
    const destination = ctx.path.join(workDir, "clone-fresh");
    const result = yield* ctx.sourceControl.cloneRepository({
      remoteUrl: origin,
      destinationPath: destination,
    });
    yield* assert(result.cwd === destination, `unexpected clone cwd ${result.cwd}`);
    const hasGit = yield* ctx.fs.exists(ctx.path.join(destination, ".git"));
    yield* assert(hasGit, "clone did not produce a .git directory");
    return `cloned into fresh ${destination}`;
  });

const checkCloneAdopt = (ctx: DoctorContext, workDir: string, origin: string) =>
  Effect.gen(function* () {
    // The fresh clone directory is now a populated checkout of `origin`.
    // Cloning again into it must ADOPT it instead of erroring on a non-empty
    // destination — this is the exact delete → re-add regression.
    const destination = ctx.path.join(workDir, "clone-fresh");
    const result = yield* ctx.sourceControl.cloneRepository({
      remoteUrl: origin,
      destinationPath: destination,
    });
    yield* assert(result.cwd === destination, `adopt returned unexpected cwd ${result.cwd}`);
    return `adopted existing matching checkout at ${destination}`;
  });

const checkCloneConflict = (ctx: DoctorContext, workDir: string, origin: string) =>
  Effect.gen(function* () {
    // A non-empty directory that is NOT a checkout of the requested repo must
    // fail with an actionable error that names the path — not a raw git error.
    const destination = ctx.path.join(workDir, "clone-conflict");
    yield* ctx.fs.makeDirectory(destination, { recursive: true });
    yield* ctx.fs.writeFileString(ctx.path.join(destination, "unrelated.txt"), "not a repo\n");
    const outcome = yield* Effect.result(
      ctx.sourceControl.cloneRepository({ remoteUrl: origin, destinationPath: destination }),
    );
    yield* assert(
      Result.isFailure(outcome),
      "cloning into an unrelated non-empty directory unexpectedly succeeded",
    );
    if (Result.isFailure(outcome)) {
      const detail = describeError(outcome.failure);
      yield* assert(
        detail.includes(destination),
        "conflict error did not name the destination path",
      );
    }
    return "refused an unrelated non-empty directory with an actionable error";
  });

const checkCreateWorktree = (ctx: DoctorContext, workDir: string, origin: string) =>
  Effect.gen(function* () {
    const source = ctx.path.join(workDir, "worktree-source");
    yield* ctx.sourceControl.cloneRepository({ remoteUrl: origin, destinationPath: source });
    const worktreePath = ctx.path.join(workDir, "worktree-target");
    const created = yield* ctx.git.createWorktree({
      cwd: source,
      path: worktreePath,
      refName: "main",
      newRefName: "t3-doctor-worktree",
      baseRefName: "origin/main",
    });
    yield* assert(
      created.worktree.path === worktreePath,
      `worktree created at unexpected path ${created.worktree.path}`,
    );
    const hasGit = yield* ctx.fs.exists(ctx.path.join(worktreePath, ".git"));
    yield* assert(hasGit, "worktree is missing its .git link");
    // Best-effort cleanup so repeated deploys do not accumulate workspaces.
    yield* Effect.result(ctx.git.removeWorktree({ cwd: source, path: worktreePath, force: true }));
    return `created a worktree at ${worktreePath} on ${workDir}'s filesystem`;
  });

/**
 * The mechanical spine a card rides from Prompts to a pull request, minus the
 * forge call: launch a worktree from freshly fetched origin (the exact
 * `launch_active` preparer, not a re-implementation), commit in it, push the
 * branch back to the origin. Every one of these has hard-failed on prod after
 * the agent's work was already done — the most expensive point to fail.
 */
export const checkPipelineShip = (ctx: DoctorContext, workDir: string, origin: string) => {
  const project = ctx.path.join(workDir, "pipeline-project");
  const branch = "t3-doctor/pipeline";
  const threadId = "t3-doctor-pipeline";
  const expectedWorktree = buildThreadWorktreePath({
    path: nodeWorktreePath,
    projectCwd: project,
    threadId,
  });

  const body = Effect.gen(function* () {
    yield* ctx.sourceControl.cloneRepository({ remoteUrl: origin, destinationPath: project });
    const preparer = makeLaunchWorktreePreparerFrom(ctx.git);
    const prepared = yield* preparer.prepare({ projectCwd: project, threadId, branch });
    yield* assert(
      prepared.kind === "prepared",
      `launch preparer refused the doctor project: ${
        prepared.kind === "not_a_repo" ? prepared.reason : "unknown"
      }`,
    );
    if (prepared.kind !== "prepared") return "unreachable";
    const worktree = prepared.worktreePath;

    yield* ctx.fs.writeFileString(ctx.path.join(worktree, "pipeline.txt"), "t3 doctor pipeline\n");
    // Local identity on purpose: git.identity is `t3 health`'s check; this one
    // is about the worktree → commit → push mechanics.
    yield* runGit(ctx, worktree, ["config", "user.email", "doctor@t3j.local"]);
    yield* runGit(ctx, worktree, ["config", "user.name", "t3 doctor"]);
    yield* runGit(ctx, worktree, ["add", "."]);
    yield* runGit(ctx, worktree, ["commit", "-m", "t3 doctor pipeline"]);
    yield* runGit(ctx, worktree, ["push", "origin", branch]);
    yield* runGit(ctx, project, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
    return `worktree from fetched origin/${prepared.baseBranch}, committed and pushed ${branch}`;
  });

  // The worktree may land in the real store (T3CODE_WORKTREE_ROOT), so remove
  // it whether the check passed or died halfway.
  return body.pipe(
    Effect.ensuring(
      Effect.result(
        ctx.git.removeWorktree({ cwd: project, path: expectedWorktree, force: true }),
      ).pipe(Effect.asVoid),
    ),
  );
};

const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

const doctorGuardIo = (contents: Readonly<Record<string, string>>): PrePushGuardIo => ({
  size: async (absolutePath) => contents[baseName(absolutePath)]?.length ?? null,
  read: async (absolutePath) => contents[baseName(absolutePath)] ?? null,
});

/** The only gate between an agent worktree and a public remote. */
export const checkPipelineGuard = Effect.gen(function* () {
  // Built in pieces so this source file itself never matches the PEM pattern
  // the guard scans for when openPr commits the worktree.
  const plantedKey = ["-----BEGIN ", "PRIVATE KEY-----", "\nabc\n"].join("");
  const io = doctorGuardIo({
    "clean.ts": "export const fine = true;\n",
    "leaked.txt": plantedKey,
  });
  const blocked = yield* Effect.promise(() =>
    runPrePushGuard({ cwd: "/doctor", paths: [".env", "leaked.txt"], io }),
  );
  yield* assert(
    blocked.length === 2,
    `pre-push guard let a secret through (found ${blocked.length} of 2 plants)`,
  );
  const clean = yield* Effect.promise(() =>
    runPrePushGuard({ cwd: "/doctor", paths: ["clean.ts"], io }),
  );
  yield* assert(
    clean.length === 0,
    `pre-push guard false-positived on a clean file: ${clean[0]?.reason ?? ""}`,
  );
  return "refused a planted .env and private key, passed a clean file";
});

const doctorPolicy: RulePolicy = {
  launchPrompts: true,
  stuckPrepMs: 60_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "" },
  helpers: { enabled: false, maxConcurrent: 2, timeoutMs: 60_000 },
};

/**
 * The QuickJS WASM sandbox every Hermes program runs in. A box where the WASM
 * runtime cannot load shows up as every tick failing with an opaque error;
 * here it is one FAIL line at deploy time instead.
 */
export const checkPipelineExecutor = Effect.gen(function* () {
  const { api } = makeFakeBoardApi();
  const result = yield* Effect.promise(() =>
    runHermesProgram({
      api,
      source: 'await board.note({ text: "doctor ok" });',
      policy: doctorPolicy,
    }),
  );
  yield* assert(result.error === null, `executor ran with an error: ${result.error ?? ""}`);
  yield* assert(
    result.note?.includes("doctor ok") === true,
    "executor ran but the board.note call did not land",
  );
  return "QuickJS sandbox ran a board.* program end to end";
});

const runDoctor = (workDirFlag: Option.Option<string>, keep: boolean) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const sourceControl = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ctx: DoctorContext = { git, sourceControl, fs, path };

    const workDir = yield* Option.match(workDirFlag, {
      onSome: (dir) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dir, { recursive: true });
          return dir;
        }),
      onNone: () => fs.makeTempDirectory({ prefix: "t3-doctor-" }),
    });

    yield* Console.log(`t3 doctor: exercising critical operations under ${workDir}`);

    // Build one bare origin repo and thread it through every check. The clone
    // checks target a shared subdirectory so clone.fresh's checkout is the very
    // directory clone.adopt-matching then re-clones into.
    const sharedDir = path.join(workDir, "shared");
    const origin = yield* makeOriginRepository(ctx, sharedDir).pipe(
      Effect.mapError(
        (error) =>
          new DoctorCheckFailedError({
            detail: `failed to build the doctor origin repo: ${describeError(error)}`,
          }),
      ),
    );

    const orderedChecks: ReadonlyArray<{
      readonly name: string;
      readonly run: Effect.Effect<string, DoctorCheckFailedError>;
    }> = [
      { name: "clone.fresh", run: asCheckFailure(checkCloneFresh(ctx, sharedDir, origin)) },
      {
        name: "clone.adopt-matching",
        run: asCheckFailure(checkCloneAdopt(ctx, sharedDir, origin)),
      },
      {
        name: "clone.refuse-conflict",
        run: asCheckFailure(checkCloneConflict(ctx, sharedDir, origin)),
      },
      { name: "worktree.create", run: asCheckFailure(checkCreateWorktree(ctx, sharedDir, origin)) },
      { name: "pipeline.ship", run: asCheckFailure(checkPipelineShip(ctx, sharedDir, origin)) },
      { name: "pipeline.pre-push-guard", run: asCheckFailure(checkPipelineGuard) },
      { name: "pipeline.hermes-executor", run: asCheckFailure(checkPipelineExecutor) },
    ];

    const failed: string[] = [];
    for (const check of orderedChecks) {
      const outcome = yield* Effect.result(check.run);
      if (Result.isSuccess(outcome)) {
        yield* Console.log(`  PASS  ${check.name} — ${outcome.success}`);
      } else {
        failed.push(check.name);
        yield* Console.log(`  FAIL  ${check.name} — ${outcome.failure.detail}`);
      }
    }

    if (!keep) {
      yield* Effect.result(fs.remove(workDir, { recursive: true }));
    } else {
      yield* Console.log(`t3 doctor: kept artifacts under ${workDir}`);
    }

    if (failed.length > 0) {
      yield* Console.log(`t3 doctor: FAILED (${failed.length}/${orderedChecks.length}).`);
      return yield* new DoctorChecksFailedError({ operation: "t3 doctor", failedChecks: failed });
    }
    yield* Console.log(`t3 doctor: OK (${orderedChecks.length}/${orderedChecks.length}).`);
  });

const doctorServices = NodeServices.layer;
const doctorConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-doctor-config-",
}).pipe(Layer.provide(doctorServices));
const doctorGit = GitVcsDriver.layer.pipe(
  Layer.provide(doctorConfig),
  Layer.provide(doctorServices),
);
const doctorRegistry = Layer.succeed(
  SourceControlProviderRegistry.SourceControlProviderRegistry,
  stubProviderRegistry,
);
const doctorSourceControl = SourceControlRepositoryService.layer.pipe(
  Layer.provide(doctorGit),
  Layer.provide(doctorConfig),
  Layer.provide(doctorRegistry),
  Layer.provide(doctorServices),
);
export const DoctorRuntimeLive = Layer.mergeAll(
  doctorServices,
  doctorConfig,
  doctorGit,
  doctorSourceControl,
);

export const doctorCommand = Command.make("doctor", {
  workDir: Flag.string("work-dir").pipe(
    Flag.withDescription(
      "Directory to create the diagnostic artifacts under (defaults to a temp dir). The worktree check runs on this directory's filesystem.",
    ),
    Flag.optional,
  ),
  keep: Flag.boolean("keep").pipe(
    Flag.withDescription("Keep the diagnostic artifacts instead of removing them."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Run post-deploy self-tests of the critical source-control and worktree operations against this box.",
  ),
  Command.withHandler((flags) =>
    runDoctor(flags.workDir, flags.keep).pipe(Effect.provide(DoctorRuntimeLive)),
  ),
);
