/**
 * launch_helper primitive — one Hermes question → one throwaway agent thread.
 *
 * Deliberately not `launch_active` with a flag. An Active launch is a card's
 * launch: it moves a column, links a thread to a card, persists the routed
 * model on it and ends in a PR. A helper has no card to move and nothing to
 * merge — it reads, answers, and is archived. The only thing the two share is
 * "create a thread with its own worktree and start a turn", which is small
 * enough to say twice and much smaller than the branching a shared path grows.
 *
 * The worktree is the same isolation Active gets, for the same reason: a helper
 * that ignores the read-only contract must not be able to dirty the checkout
 * every other launch runs in.
 *
 * @module kanban/LaunchHelper
 */
import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { getUsageService } from "../usage/UsageService.ts";
import { buildHelperPrompt } from "./hermes/helpers.ts";
import { DEFAULT_WORKSPACE_PROBE, type LaunchActiveDeps } from "./LaunchActive.ts";
import { describeUnusableWorkspaceRoot } from "../workspace/workspaceRootSafety.ts";
import {
  buildRosterIndex,
  candidatesFromShellProviders,
  measuredCostKey,
  providerFamilyUsable,
} from "./ModelRouting.ts";

export type LaunchHelperInput = {
  readonly question: string;
  readonly projectId: string;
  /** Hermes-selected route. Omitted only for legacy/manual helper launches. */
  readonly modelSelection?: ModelSelection;
  /** The thread the question is about; its tail rides in the helper's prompt. */
  readonly transcript?: string | null;
};

export type LaunchHelperResult = {
  readonly threadId: string;
};

const titleOf = (question: string): string =>
  `Helper: ${question.replace(/\s+/g, " ").trim().slice(0, 100)}`;

const fail = (detail: string, cause?: unknown) =>
  new TextGenerationError({
    operation: "assistPrompt",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export function runLaunchHelper(
  deps: LaunchActiveDeps,
  input: LaunchHelperInput,
): Effect.Effect<LaunchHelperResult, TextGenerationError> {
  return Effect.gen(function* () {
    const shell = yield* deps.projection
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => fail("Failed to read projects.", cause)));
    const project = shell.projects.find((entry) => entry.id === input.projectId);
    if (!project) return yield* Effect.fail(fail(`Project '${input.projectId}' was not found.`));
    const probe = deps.workspaceProbe ?? DEFAULT_WORKSPACE_PROBE;
    const rootProblem = describeUnusableWorkspaceRoot(project.workspaceRoot, probe.isDirectory);
    if (rootProblem) {
      return yield* Effect.fail(
        fail(`Project '${input.projectId}' has no usable workspace — ${rootProblem}.`),
      );
    }

    const settings = yield* deps.serverSettings.getSettings.pipe(
      Effect.mapError((cause) => fail("Failed to resolve model settings.", cause)),
    );
    const usage = yield* Effect.promise(() => getUsageService().getUsageSafe()).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const providers = yield* deps.listProviders;
    const candidates = candidatesFromShellProviders(providers);
    const roster = settings.boardSettings.modelRoster;
    const rosterIndex = buildRosterIndex(roster);
    const enforced = settings.boardSettings.modelRosterEnforced === true;

    const isReady = (instanceId: string, model: string) => {
      const candidate = candidates.find(
        (entry) => entry.instanceId === instanceId && entry.model === model,
      );
      if (
        !candidate ||
        candidate.enabled === false ||
        candidate.installed === false ||
        candidate.authOk === false
      ) {
        return { ok: false as const, detail: "is not ready" };
      }
      const usable = providerFamilyUsable(usage, instanceId);
      if (!usable.ok) {
        return {
          ok: false as const,
          detail: `is unavailable: ${usable.detail ?? "capacity is exhausted"}`,
        };
      }
      if (enforced && !rosterIndex.has(measuredCostKey(instanceId, model))) {
        return { ok: false as const, detail: "is outside the enforced roster" };
      }
      return { ok: true as const, candidate };
    };

    /** First roster seat that can actually run — preference order is array order. */
    const firstReadyRosterSelection = (): ModelSelection | null => {
      for (const entry of roster ?? []) {
        const instanceId = String(entry.instanceId);
        if (isReady(instanceId, entry.model).ok) {
          return {
            instanceId: entry.instanceId,
            model: entry.model,
          } as ModelSelection;
        }
      }
      return null;
    };

    let modelSelection: ModelSelection | null =
      input.modelSelection ??
      settings.defaultModelSelection ??
      settings.textGenerationModelSelection ??
      null;
    if (!modelSelection) {
      modelSelection = firstReadyRosterSelection();
    }
    if (!modelSelection) {
      return yield* Effect.fail(fail("No model was selected for the helper."));
    }

    let instanceId = String(modelSelection.instanceId);
    let ready = isReady(instanceId, modelSelection.model);
    // A helper is not a card launch: Hermes often names a model that is not on
    // the enforced roster (or is momentarily not ready). Hard-failing that killed
    // the whole tick. Clamp to the first ready roster seat instead.
    if (!ready.ok) {
      const clamped = firstReadyRosterSelection();
      if (clamped) {
        yield* Effect.logWarning("launch_helper clamped model onto the enforced roster", {
          requested: `${instanceId}/${modelSelection.model}`,
          reason: ready.detail,
          clamped: `${String(clamped.instanceId)}/${clamped.model}`,
        });
        modelSelection = clamped;
        instanceId = String(modelSelection.instanceId);
        ready = isReady(instanceId, modelSelection.model);
      }
    }
    if (!ready.ok) {
      return yield* Effect.fail(
        fail(`Selected helper route '${instanceId}/${modelSelection.model}' ${ready.detail}.`),
      );
    }

    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const uuid = deps.crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => fail("Failed to allocate an id for the helper thread.", cause)),
    );
    const threadId = ThreadId.make(yield* uuid);
    const messageUuid = yield* uuid;
    const commandUuid = yield* uuid;
    const branchUuid = yield* uuid;

    let launchBranch: string | null = null;
    let launchWorktreePath: string | null = null;
    if (deps.worktree) {
      const branch = buildTemporaryWorktreeBranchName((byteLength) =>
        branchUuid.replace(/-/g, "").slice(0, byteLength * 2),
      );
      const prepared = yield* Effect.result(
        deps.worktree.prepare({ projectCwd: project.workspaceRoot, threadId, branch }),
      );
      // A helper answers a question and never opens a pull request, so unlike an
      // Active launch it is allowed to run in the project checkout.
      if (Result.isSuccess(prepared) && prepared.success.kind === "prepared") {
        launchBranch = prepared.success.branch;
        launchWorktreePath = prepared.success.worktreePath;
      } else if (Result.isFailure(prepared)) {
        yield* Effect.logWarning("launch_helper could not create a worktree", {
          threadId,
          projectCwd: project.workspaceRoot,
          detail: prepared.failure.detail ?? prepared.failure.message,
        });
      }
    }

    const title = titleOf(input.question);
    yield* deps.orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`kanban:launch-helper-thread:${commandUuid}`),
        threadId,
        projectId: input.projectId as ProjectId,
        title,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: launchBranch,
        worktreePath: launchWorktreePath,
        createdAt: nowIso,
      })
      .pipe(Effect.mapError((cause) => fail("Failed to create the helper thread.", cause)));

    yield* deps.orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`kanban:launch-helper:${commandUuid}`),
        threadId,
        message: {
          messageId: MessageId.make(messageUuid),
          role: "user",
          text: buildHelperPrompt({
            question: input.question,
            ...(input.transcript === undefined ? {} : { transcript: input.transcript }),
          }),
          attachments: [],
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: nowIso,
      })
      .pipe(Effect.mapError((cause) => fail("Failed to start the helper thread.", cause)));

    yield* Effect.logInfo("launch_helper started", {
      threadId,
      projectId: input.projectId,
      model: modelSelection.model,
      worktreePath: launchWorktreePath,
    });

    return { threadId: String(threadId) } satisfies LaunchHelperResult;
  });
}
