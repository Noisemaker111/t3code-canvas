import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

const AUTO_INSTALL_CANDIDATES: ReadonlyArray<{ marker: string; command: string }> = [
  { marker: "scripts/install-deps.sh", command: "bash scripts/install-deps.sh" },
  { marker: "bun.lock", command: "bun install" },
  { marker: "bun.lockb", command: "bun install" },
  { marker: "pnpm-lock.yaml", command: "pnpm install" },
  { marker: "yarn.lock", command: "yarn install" },
  { marker: "package-lock.json", command: "npm install" },
  { marker: "package.json", command: "npm install" },
];

const safeReadDir = (path: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(path);
  } catch {
    return [];
  }
};

/**
 * True when the workspace already carries installed dependencies.
 *
 * A Rift workspace is a copy-on-write snapshot of the whole project directory,
 * so it arrives with the source's `node_modules` already in it — the extents
 * are shared with the source, so the copy costs almost nothing. Re-running the
 * installer there rewrites those files and turns every shared extent into an
 * exclusive one, which is how N workspaces come to cost N full installs on the
 * one filesystem chosen to make them cost one.
 */
export function worktreeHasDependencies(
  worktreePath: string,
  readDir: (path: string) => ReadonlyArray<string> = safeReadDir,
): boolean {
  return readDir(NodePath.join(worktreePath, "node_modules")).length > 0;
}

/**
 * A worktree that has no node_modules needs one. When the project never
 * configured a setup script, detect the repo's own installer from what is
 * checked in so every launched thread still gets its dependencies.
 *
 * Returns null when the workspace already has them: this script is inferred,
 * not asked for, and its only job is to supply what is missing. A setup script
 * the project configured explicitly is never skipped — it may do far more than
 * install.
 */
export function autoInstallScript(
  worktreePath: string,
  exists: (path: string) => boolean = NodeFS.existsSync,
  readDir: (path: string) => ReadonlyArray<string> = safeReadDir,
): ProjectScript | null {
  const candidate = AUTO_INSTALL_CANDIDATES.find((entry) =>
    exists(NodePath.join(worktreePath, entry.marker)),
  );
  if (!candidate) return null;
  if (worktreeHasDependencies(worktreePath, readDir)) return null;
  return {
    id: "auto-install",
    name: "Install dependencies",
    command: candidate.command,
    icon: "configure",
    runOnWorktreeCreate: true,
  };
}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const script = setupProjectScript(project.scripts) ?? autoInstallScript(input.worktreePath);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
      );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);

/**
 * The runner when it is in context, `null` otherwise. Same shape as
 * `launchWorktreePreparerOption`: `launch_active` call sites ask for it without
 * adding to their requirement channel.
 */
export const projectSetupScriptRunnerOption: Effect.Effect<
  ProjectSetupScriptRunner["Service"] | null
> = Effect.gen(function* () {
  const runner = yield* Effect.serviceOption(ProjectSetupScriptRunner);
  return Option.isSome(runner) ? runner.value : null;
});
