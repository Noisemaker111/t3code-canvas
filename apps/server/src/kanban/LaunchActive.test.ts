import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { KanbanCard, KanbanCardId, ProjectId } from "@t3tools/contracts";
import { buildLaunchMedia, runLaunchActive, type LaunchActiveDeps } from "./LaunchActive.ts";
import { resolveKanbanAttachmentPath } from "./kanbanAttachments.ts";
import type { LaunchWorktreePreparer } from "./launchWorktree.ts";

const PROJECT_ID = "project-1" as ProjectId;
const PROJECT_CWD = "/root/projects/demo";

const card = (id: string): KanbanCard =>
  ({
    id: id as KanbanCardId,
    title: `Card ${id}`,
    body: "# Goal: do the thing",
    at: "prompts",
    position: 0,
    threadId: null,
    prUrl: null,
    projectId: PROJECT_ID,
    modelSelection: { instanceId: "inst-1", model: "model-a" },
    modelRouteReason: null,
    prepStatus: "ready",
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  }) as unknown as KanbanCard;

interface Harness {
  readonly deps: LaunchActiveDeps;
  readonly dispatched: Array<{ type: string; [key: string]: unknown }>;
  readonly prepared: Array<{ threadId: string; branch: string }>;
  readonly setupRuns: Array<{
    threadId: string;
    worktreePath: string;
    turnAlreadyStarted: boolean;
  }>;
}

const makeHarness = (cards: ReadonlyArray<KanbanCard>, withWorktree = true): Harness => {
  const dispatched: Array<{ type: string; [key: string]: unknown }> = [];
  const prepared: Array<{ threadId: string; branch: string }> = [];
  const setupRuns: Array<{ threadId: string; worktreePath: string; turnAlreadyStarted: boolean }> =
    [];
  const stored = new Map(cards.map((entry) => [entry.id, entry]));
  let uuidCounter = 0;

  const worktree: LaunchWorktreePreparer = {
    prepare: (input) =>
      Effect.sync(() => {
        prepared.push({ threadId: input.threadId, branch: input.branch });
        return {
          kind: "prepared" as const,
          // Mirrors buildThreadWorktreePath: keyed by thread, not by branch.
          worktreePath: `/root/projects/.worktrees/thread-${input.threadId}`,
          branch: input.branch,
          baseBranch: "main",
        };
      }),
  };

  const deps: LaunchActiveDeps = {
    store: {
      list: () => Effect.succeed({ cards: [...stored.values()] }),
      update: (input: { id: KanbanCardId; [key: string]: unknown }) =>
        Effect.sync(() => {
          const current = stored.get(input.id);
          if (!current) throw new Error(`no card ${input.id}`);
          const next = { ...current, ...input } as KanbanCard;
          stored.set(input.id, next);
          return next;
        }),
    } as unknown as LaunchActiveDeps["store"],
    orchestrationEngine: {
      dispatch: (command: { type: string }) =>
        Effect.sync(() => {
          dispatched.push(command as { type: string });
          return { sequence: dispatched.length };
        }),
    } as unknown as LaunchActiveDeps["orchestrationEngine"],
    projection: {
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [{ id: PROJECT_ID, workspaceRoot: PROJECT_CWD }],
          threads: [],
        }),
    } as unknown as LaunchActiveDeps["projection"],
    serverSettings: {
      getSettings: Effect.succeed({
        defaultModelSelection: { instanceId: "inst-1", model: "model-a" },
        textGenerationModelSelection: { instanceId: "inst-1", model: "model-a" },
      }),
    } as unknown as LaunchActiveDeps["serverSettings"],
    crypto: {
      randomUUIDv4: Effect.sync(() => {
        uuidCounter += 1;
        return `${String(uuidCounter).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36);
      }),
    },
    listProviders: Effect.succeed([
      {
        instanceId: "inst-1",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "model-a", name: "Model A" }],
      },
    ]),
    workspaceProbe: {
      isDirectory: (path: string) => path === PROJECT_CWD,
      isGitCheckout: () => withWorktree,
    },
    ...(withWorktree ? { worktree } : {}),
    setupScript: {
      runForThread: (input) =>
        Effect.sync(() => {
          setupRuns.push({
            threadId: input.threadId,
            worktreePath: input.worktreePath,
            turnAlreadyStarted: dispatched.some((entry) => entry.type === "thread.turn.start"),
          });
          return {
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: input.worktreePath,
          };
        }),
    },
  };

  return { deps, dispatched, prepared, setupRuns };
};

describe("runLaunchActive", () => {
  it("forwards persisted card image bytes to the agent attachment", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync("/tmp"), "kanban-"),
    );
    try {
      const source = Buffer.from([1, 2, 3, 4]);
      const cardAttachment = {
        id: "card-image",
        kind: "image" as const,
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: source.byteLength,
        include: true,
      };
      const sourcePath = resolveKanbanAttachmentPath({
        attachmentsDir,
        attachment: cardAttachment,
      });
      assert.isString(sourcePath);
      NodeFS.mkdirSync(NodePath.dirname(sourcePath!), { recursive: true });
      NodeFS.writeFileSync(sourcePath!, source);

      const result = buildLaunchMedia({
        card: { ...card("card-1"), attachments: [cardAttachment] },
        threadId: "thread-1",
        attachmentsDir,
        worktreePath: null,
      });

      assert.isNull(result.error);
      assert.lengthOf(result.imageAttachments, 1);
      const forwarded = result.imageAttachments[0]!;
      const forwardedPath = NodePath.join(attachmentsDir, `${forwarded.id}.png`);
      assert.deepEqual(NodeFS.readFileSync(forwardedPath), source);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("refuses to start when an included card attachment cannot be forwarded", () => {
    const result = buildLaunchMedia({
      card: {
        ...card("card-1"),
        attachments: [
          {
            id: "missing-image",
            kind: "image",
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 4,
            include: true,
          },
        ],
      },
      threadId: "thread-1",
      attachmentsDir: "/tmp/kanban-attachments-does-not-exist",
      worktreePath: null,
    });

    assert.isNotNull(result.error);
    assert.lengthOf(result.imageAttachments, 0);
  });

  it.effect("gives a launched Active card its own worktree", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);

      const result = yield* runLaunchActive(harness.deps, {
        id: "card-1" as KanbanCardId,
        projectId: PROJECT_ID,
      });

      assert.equal(harness.prepared.length, 1);
      assert.equal(harness.prepared[0]?.threadId, result.threadId);
      // Same scheme as the web path (buildTemporaryWorktreeBranchName).
      assert.match(harness.prepared[0]?.branch ?? "", /^t3code\/[0-9a-f]+$/);

      // The thread is created with the worktree attached — not branch: null,
      // worktreePath: null as before.
      const create = harness.dispatched.find((entry) => entry.type === "thread.create");
      assert.isDefined(create);
      assert.equal(create?.worktreePath, `/root/projects/.worktrees/thread-${result.threadId}`);
      assert.equal(create?.branch, harness.prepared[0]?.branch);
      assert.isTrue(harness.dispatched.some((entry) => entry.type === "thread.turn.start"));

      // Setup script runs in the new worktree, before the agent's turn starts.
      assert.equal(harness.setupRuns.length, 1);
      assert.equal(harness.setupRuns[0]?.threadId, result.threadId);
      assert.equal(
        harness.setupRuns[0]?.worktreePath,
        `/root/projects/.worktrees/thread-${result.threadId}`,
      );
      assert.isFalse(harness.setupRuns[0]?.turnAlreadyStarted);
    }),
  );

  it.effect("appends the board contract to the launch turn, not the card title", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);

      yield* runLaunchActive(harness.deps, {
        id: "card-1" as KanbanCardId,
        projectId: PROJECT_ID,
      });

      const turn = harness.dispatched.find((entry) => entry.type === "thread.turn.start");
      const text = String((turn?.message as { text?: unknown } | undefined)?.text ?? "");
      assert.include(text, "# Goal: do the thing");
      assert.include(text, "Don't branch, commit, push, or open a pull request");
      assert.include(text, "No format required");
      assert.notInclude(String(turn?.titleSeed ?? ""), "How we work");
    }),
  );

  it.effect("gives two Active cards on the same project two different worktrees", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1"), card("card-2")]);

      const first = yield* runLaunchActive(harness.deps, {
        id: "card-1" as KanbanCardId,
        projectId: PROJECT_ID,
      });
      const second = yield* runLaunchActive(harness.deps, {
        id: "card-2" as KanbanCardId,
        projectId: PROJECT_ID,
      });

      assert.notEqual(first.threadId, second.threadId);
      const paths = harness.dispatched
        .filter((entry) => entry.type === "thread.create")
        .map((entry) => entry.worktreePath);
      assert.equal(paths.length, 2);
      assert.notEqual(paths[0], paths[1]);
      // Two different branches too — the branch is per card, not per base ref.
      assert.notEqual(harness.prepared[0]?.branch, harness.prepared[1]?.branch);
    }),
  );

  it.effect("still launches when no worktree can be prepared", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")], false);

      yield* runLaunchActive(harness.deps, {
        id: "card-1" as KanbanCardId,
        projectId: PROJECT_ID,
      });

      const create = harness.dispatched.find((entry) => entry.type === "thread.create");
      assert.equal(create?.worktreePath, null);
      assert.isTrue(harness.dispatched.some((entry) => entry.type === "thread.turn.start"));
      // No worktree, no setup script — the project checkout already has deps.
      assert.equal(harness.setupRuns.length, 0);
    }),
  );
  it.effect("refuses to spend a turn on a box failing a critical health check", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        preflight: {
          check: async () => ({
            checkId: "store.writable",
            detail: "/root/projects/.worktrees is not writable",
          }),
        },
      };

      const outcome = yield* Effect.result(
        runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? outcome.failure.detail : "";
      assert.include(detail, "store.writable");
      assert.include(detail, "t3 health --fix");
      // Nothing was spent: no thread, no turn, no worktree.
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.prepared.length, 0);
    }),
  );

  it.effect("refuses a project rooted at the filesystem root", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        projection: {
          getShellSnapshot: () =>
            Effect.succeed({ projects: [{ id: PROJECT_ID, workspaceRoot: "/" }], threads: [] }),
        } as unknown as LaunchActiveDeps["projection"],
      };

      const outcome = yield* Effect.result(
        runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? outcome.failure.detail : "";
      assert.include(detail, "filesystem root");
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.prepared.length, 0);
    }),
  );

  it.effect("refuses a project whose workspace root no longer exists", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        workspaceProbe: { isDirectory: () => false, isGitCheckout: () => true },
      };

      const outcome = yield* Effect.result(
        runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? outcome.failure.detail : "";
      assert.include(detail, "not an existing directory");
      assert.equal(harness.dispatched.length, 0);
    }),
  );

  it.effect("refuses a git project when there is no worktree preparer", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")], false);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        workspaceProbe: { isDirectory: () => true, isGitCheckout: () => true },
      };

      const outcome = yield* Effect.result(
        runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID }),
      );

      assert.isTrue(Result.isFailure(outcome));
      const detail = Result.isFailure(outcome) ? outcome.failure.detail : "";
      assert.include(detail, "no git driver");
      assert.equal(harness.dispatched.length, 0);
    }),
  );

  it.effect("preserves the validated Hermes route instead of re-routing it", () =>
    Effect.gen(function* () {
      const routed = {
        ...card("card-1"),
        modelSelection: { instanceId: "inst-9", model: "model-z" },
        modelRouteReason: "Hermes selected this route from the routing brief.",
        modelRouteProvenance: {
          source: "hermes",
          skill: "select-execution",
          at: "2026-08-02T00:00:00.000Z",
        },
      } as unknown as KanbanCard;
      const harness = makeHarness([routed]);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        listProviders: Effect.succeed([
          {
            instanceId: "inst-9",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "model-z", name: "Hermes choice" }],
          },
          {
            instanceId: "inst-1",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "claude-haiku-4-5", name: "Alternative" }],
          },
        ]),
      };

      yield* runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID });

      const create = harness.dispatched.find((entry) => entry.type === "thread.create");
      assert.deepEqual(create?.modelSelection, {
        instanceId: "inst-9",
        model: "model-z",
      });
    }),
  );

  it.effect("keeps a model a human pinned on the card", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);
      const deps: LaunchActiveDeps = {
        ...harness.deps,
        listProviders: Effect.succeed([
          {
            instanceId: "inst-1",
            enabled: true,
            installed: true,
            models: [
              { slug: "model-a", name: "Pinned" },
              { slug: "claude-haiku-4-5", name: "Haiku" },
            ],
          },
        ]),
      };

      yield* runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID });

      const create = harness.dispatched.find((entry) => entry.type === "thread.create");
      assert.deepEqual(create?.modelSelection, { instanceId: "inst-1", model: "model-a" });
    }),
  );

  it.effect("launches normally when preflight clears the box", () =>
    Effect.gen(function* () {
      const harness = makeHarness([card("card-1")]);
      const deps: LaunchActiveDeps = { ...harness.deps, preflight: { check: async () => null } };

      yield* runLaunchActive(deps, { id: "card-1" as KanbanCardId, projectId: PROJECT_ID });

      assert.isTrue(harness.dispatched.some((entry) => entry.type === "thread.turn.start"));
    }),
  );
});
