import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  });

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
  );

describe("autoInstallScript", () => {
  it("prefers the repo's own installer over lockfile detection", () => {
    const files = new Set(["/wt/scripts/install-deps.sh", "/wt/pnpm-lock.yaml"]);
    const script = ProjectSetupScriptRunner.autoInstallScript("/wt", (path) => files.has(path));
    expect(script?.command).toBe("bash scripts/install-deps.sh");
    expect(script?.runOnWorktreeCreate).toBe(true);
  });

  it("maps each lockfile to its package manager", () => {
    const command = (file: string) =>
      ProjectSetupScriptRunner.autoInstallScript("/wt", (path) => path === `/wt/${file}`)?.command;
    expect(command("bun.lock")).toBe("bun install");
    expect(command("bun.lockb")).toBe("bun install");
    expect(command("pnpm-lock.yaml")).toBe("pnpm install");
    expect(command("yarn.lock")).toBe("yarn install");
    expect(command("package-lock.json")).toBe("npm install");
    expect(command("package.json")).toBe("npm install");
  });

  it("returns null for a worktree with nothing installable", () => {
    expect(ProjectSetupScriptRunner.autoInstallScript("/wt", () => false)).toBeNull();
  });

  // A Rift snapshot arrives with the source's node_modules already in it, as
  // extents shared with the source. Installing over them rewrites every file
  // and makes the workspace cost a full install instead of nearly nothing.
  it("does not reinstall into a workspace that already has dependencies", () => {
    const script = ProjectSetupScriptRunner.autoInstallScript(
      "/wt",
      (path) => path === "/wt/pnpm-lock.yaml",
      (path) => (path === "/wt/node_modules" ? [".pnpm", "effect"] : []),
    );
    expect(script).toBeNull();
  });

  it("still installs when the workspace has no dependencies", () => {
    const script = ProjectSetupScriptRunner.autoInstallScript(
      "/wt",
      (path) => path === "/wt/pnpm-lock.yaml",
      () => [],
    );
    expect(script?.command).toBe("pnpm install");
  });
});

describe("worktreeHasDependencies", () => {
  it("is true only for a populated node_modules", () => {
    expect(ProjectSetupScriptRunner.worktreeHasDependencies("/wt", () => ["effect"])).toBe(true);
    expect(ProjectSetupScriptRunner.worktreeHasDependencies("/wt", () => [])).toBe(false);
  });

  it("reads node_modules inside the workspace, not the workspace itself", () => {
    const seen: string[] = [];
    ProjectSetupScriptRunner.worktreeHasDependencies("/wt", (path) => {
      seen.push(path);
      return [];
    });
    expect(seen).toEqual(["/wt/node_modules"]);
  });
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});
