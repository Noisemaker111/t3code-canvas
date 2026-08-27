/**
 * launch_active primitive — one kanban card → one coding-agent thread + turn.
 * Used by Hermes board tools and Active-column drag.
 *
 * @module kanban/LaunchActive
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  ChatAttachment,
  KanbanCard,
  KanbanCardId,
  KanbanLaunchActiveInput,
  KanbanLaunchActiveResult,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { kanbanPromptTitleFromBody } from "@t3tools/shared/kanbanPromptFormat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { recordDegradation } from "../health/incidentLog.ts";
import type { LaunchPreflight } from "../health/preflight.ts";
import type * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { getUsageService } from "../usage/UsageService.ts";
import { ServerConfig } from "../config.ts";
import * as WorktreeReaper from "../vcs/WorktreeReaper.ts";
import type { LaunchWorktreePreparer } from "./launchWorktree.ts";
import type { KanbanStore } from "./KanbanStore.ts";
import {
  inferKanbanMediaExtension,
  readKanbanAttachmentBytes,
  resolveKanbanAttachmentPath,
} from "./kanbanAttachments.ts";
import { DEFAULT_BOARD_CONVENTIONS, explainMoveBlock } from "@t3tools/shared/moveGate";
import {
  buildRosterIndex,
  candidatesFromShellProviders,
  measuredCostKey,
  providerFamilyUsable,
} from "./ModelRouting.ts";
import { cachedMeasuredCostTiers } from "./budget/BudgetService.ts";
import { resolveBudgetKnobs } from "./budget/knobs.ts";
import { isSubscriptionHarness, measuredTiersForCandidates } from "./budget/pricing.ts";
import { quotaWindowsForModel, shadowPrice } from "./budget/shadowPrice.ts";
import { getModelPriceCatalog } from "./ModelPriceCatalog.ts";
import { readThreadContextWindow } from "./threadContextWindow.ts";
import { withAgentContract } from "./hermes/agentContract.ts";
import { lessonsForProject, noteLessonsTaught } from "./hermes/knowledgeStore.ts";
import { capacityPoolForRoute } from "./hermes/routeFacts.ts";
import { beginRoutingUsageObservation } from "./hermes/routingUsageStore.ts";
import { isGitRepository } from "../git/Utils.ts";
import {
  describeUnusableWorkspaceRoot,
  isExistingDirectory,
} from "../workspace/workspaceRootSafety.ts";

export interface LaunchActiveDeps {
  readonly store: KanbanStore["Service"];
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly projection: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly serverSettings: ServerSettingsService["Service"];
  readonly crypto: {
    readonly randomUUIDv4: Effect.Effect<string>;
  };
  /** Live provider snapshots for usage-aware model routing. */
  readonly listProviders: Effect.Effect<
    ReadonlyArray<{
      instanceId?: string;
      id?: string;
      enabled?: boolean;
      installed?: boolean;
      auth?: { status?: string } | string | null;
      models?: ReadonlyArray<{ slug: string; name?: string }>;
    }>
  >;
  /**
   * Creates the launched thread's own worktree. Absent only for callers with no
   * git context at all, and then the project must not be a git checkout — a
   * checkout without a worktree preparer refuses. See `launchWorktree.ts` for
   * why this is not `bootstrap.prepareWorktree`.
   */
  readonly worktree?: LaunchWorktreePreparer | null;
  /** Filesystem probes for the project's workspace root. Injected by tests. */
  readonly workspaceProbe?: {
    readonly isDirectory: (path: string) => boolean;
    readonly isGitCheckout: (path: string) => boolean;
  };
  /**
   * Refuses the launch when the box itself is failing a critical health check,
   * so the cost of a broken box is a card with a reason instead of a session
   * that discovers it as a broken build. Optional: a caller without one
   * launches unguarded.
   */
  readonly preflight?: LaunchPreflight | null;
  /**
   * Starts the project's setup script (or the auto-detected installer) in the
   * new worktree, exactly as the web bootstrap path does. Optional so callers
   * without one still launch — the worktree just starts without dependencies.
   */
  readonly setupScript?: Pick<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"],
    "runForThread"
  > | null;
}

export const DEFAULT_WORKSPACE_PROBE = {
  isDirectory: isExistingDirectory,
  isGitCheckout: isGitRepository,
} as const;

function promptOf(card: KanbanCard): string {
  const body = card.body.trim();
  return body.length > 0 ? body : card.title;
}

function includedAttachments(card: KanbanCard) {
  return (card.attachments ?? []).filter((entry) => entry.include !== false);
}

/** Images become turn ChatAttachments; videos land as worktree files named in the prompt. */
export function buildLaunchMedia(input: {
  readonly card: KanbanCard;
  readonly threadId: string;
  readonly attachmentsDir: string | null;
  readonly worktreePath: string | null;
}): {
  readonly textSuffix: string;
  readonly imageAttachments: ChatAttachment[];
  readonly error: string | null;
} {
  const kept = includedAttachments(input.card);
  if (kept.length === 0) {
    return { textSuffix: "", imageAttachments: [], error: null };
  }
  if (!input.attachmentsDir) {
    return {
      textSuffix: "",
      imageAttachments: [],
      error: "the server attachment directory is unavailable",
    };
  }

  const imageAttachments: ChatAttachment[] = [];
  const videoLines: string[] = [];

  for (const attachment of kept) {
    if (attachment.kind === "image") {
      const bytes = readKanbanAttachmentBytes({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!bytes) {
        return {
          textSuffix: "",
          imageAttachments: [],
          error: `attachment '${attachment.name}' is missing from the server`,
        };
      }
      const attachmentId = createAttachmentId(input.threadId);
      if (!attachmentId) {
        return {
          textSuffix: "",
          imageAttachments: [],
          error: `could not allocate an agent attachment id for '${attachment.name}'`,
        };
      }
      const persisted: ChatAttachment = {
        type: "image",
        id: attachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.byteLength,
      };
      const dest = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment: persisted,
      });
      if (!dest) {
        return {
          textSuffix: "",
          imageAttachments: [],
          error: `could not resolve the agent attachment path for '${attachment.name}'`,
        };
      }
      try {
        NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
        NodeFS.writeFileSync(dest, bytes);
        imageAttachments.push(persisted);
      } catch (cause) {
        return {
          textSuffix: "",
          imageAttachments: [],
          error:
            cause instanceof Error
              ? `could not copy '${attachment.name}' to the agent: ${cause.message}`
              : `could not copy '${attachment.name}' to the agent`,
        };
      }
      continue;
    }

    const source = resolveKanbanAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!source || !NodeFS.existsSync(source)) {
      return {
        textSuffix: "",
        imageAttachments: [],
        error: `attachment '${attachment.name}' is missing from the server`,
      };
    }
    if (!input.worktreePath) {
      return {
        textSuffix: "",
        imageAttachments: [],
        error: `attachment '${attachment.name}' needs a worktree for agent forwarding`,
      };
    }
    const mediaDir = NodePath.join(input.worktreePath, ".kanban-attachments");
    const ext = inferKanbanMediaExtension({
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      fileName: attachment.name,
    });
    const destName = `${attachment.id}${ext}`;
    const dest = NodePath.join(mediaDir, destName);
    try {
      NodeFS.mkdirSync(mediaDir, { recursive: true });
      NodeFS.copyFileSync(source, dest);
      videoLines.push(
        `- .kanban-attachments/${destName} (${attachment.name}, ${attachment.mimeType})`,
      );
    } catch (cause) {
      return {
        textSuffix: "",
        imageAttachments: [],
        error:
          cause instanceof Error
            ? `could not copy '${attachment.name}' into the worktree: ${cause.message}`
            : `could not copy '${attachment.name}' into the worktree`,
      };
    }
  }

  if (videoLines.length === 0) {
    return { textSuffix: "", imageAttachments, error: null };
  }
  return {
    textSuffix: `\n\n## Attached media\n${videoLines.join("\n")}`,
    imageAttachments,
    error: null,
  };
}

function titleOf(card: KanbanCard): string {
  const fromBody = kanbanPromptTitleFromBody(promptOf(card));
  if (fromBody && fromBody !== "Untitled task") return fromBody.slice(0, 120);
  const first = promptOf(card).split("\n")[0]?.trim() ?? card.title;
  return first.replace(/^#\s*Goal:\s*/i, "").slice(0, 120) || card.title;
}

export function runLaunchActive(
  deps: LaunchActiveDeps,
  input: KanbanLaunchActiveInput,
): Effect.Effect<KanbanLaunchActiveResult, TextGenerationError> {
  return Effect.gen(function* () {
    const listed = yield* deps.store.list().pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: cause instanceof Error ? cause.message : "Failed to list board.",
            cause,
          }),
      ),
    );
    const card = listed.cards.find((entry) => entry.id === input.id);
    if (!card) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: `Kanban card '${input.id}' was not found.`,
        }),
      );
    }

    // Active only from Prompts (ready queue), unless already active with a thread.
    if (card.at !== "active" || !card.threadId) {
      if (card.at !== "active") {
        const prepBlock = explainMoveBlock(card, "active", DEFAULT_BOARD_CONVENTIONS);
        if (prepBlock) {
          return yield* Effect.fail(
            new TextGenerationError({
              operation: "assistPrompt",
              detail: prepBlock,
            }),
          );
        }
      }
    }

    if (deps.preflight) {
      const block = yield* Effect.promise(() => deps.preflight!.check());
      if (block) {
        yield* Effect.logWarning("launch_active blocked by a failing health check", {
          cardId: card.id,
          check: block.checkId,
          detail: block.detail,
        });
        return yield* Effect.fail(
          new TextGenerationError({
            operation: "assistPrompt",
            detail:
              `Not launching '${card.title}': this box is failing ${block.checkId} — ` +
              `${block.detail}. The card stays where it is; fix the box (t3 health --fix) and launch again.`,
          }),
        );
      }
    }

    const board = yield* deps.serverSettings.getSettings.pipe(
      Effect.map((current) => current.boardSettings),
      Effect.orElseSucceed(() => null),
    );
    const forceFresh = input.forceFreshThread === true;

    if (card.threadId && !forceFresh) {
      const updated = yield* deps.store
        .update({
          id: card.id as KanbanCardId,
          at: "active",
          threadId: card.threadId,
          prepStatus: "ready",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "assistPrompt",
                detail: cause instanceof Error ? cause.message : "Failed to move card to active.",
                cause,
              }),
          ),
        );
      return {
        card: updated,
        threadId: card.threadId,
        reusedExistingThread: true,
      } satisfies KanbanLaunchActiveResult;
    }

    const shell = yield* deps.projection.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: cause instanceof Error ? cause.message : "Failed to read projects.",
            cause,
          }),
      ),
    );
    const project = shell.projects.find((entry) => entry.id === input.projectId);
    if (!project) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: `Project '${input.projectId}' was not found.`,
        }),
      );
    }

    const probe = deps.workspaceProbe ?? DEFAULT_WORKSPACE_PROBE;
    const unusableRoot = () =>
      describeUnusableWorkspaceRoot(project.workspaceRoot, probe.isDirectory);
    const refuseRoot = (detail: string) =>
      new TextGenerationError({
        operation: "assistPrompt",
        detail:
          `Not launching '${titleOf(card)}': project '${input.projectId}' has no usable workspace — ` +
          `${detail}. The card stays where it is; point the project at a real checkout ` +
          "(Settings → Projects) and launch again.",
      });

    const rootProblem = unusableRoot();
    if (rootProblem) {
      yield* Effect.logError("launch_active refused an unusable workspace root", {
        cardId: card.id,
        projectId: input.projectId,
        workspaceRoot: project.workspaceRoot,
        detail: rootProblem,
      });
      return yield* refuseRoot(rootProblem);
    }

    const settings = yield* deps.serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: "Failed to resolve model settings.",
            cause,
          }),
      ),
    );

    const usage = yield* Effect.promise(() => getUsageService().getUsageSafe()).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const providers = yield* deps.listProviders;
    const candidates = candidatesFromShellProviders(providers);
    const roster = board?.modelRoster ?? [];
    const rosterIndex = buildRosterIndex(roster);
    const enforced = board?.modelRosterEnforced === true;

    const fallback =
      settings.defaultModelSelection ?? settings.textGenerationModelSelection ?? null;
    const modelSelection: ModelSelection | null =
      input.modelSelection ?? card.modelSelection ?? fallback;
    if (!modelSelection) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: "No model was selected and no explicit fallback is configured.",
        }),
      );
    }

    const instanceId = String(modelSelection.instanceId);
    const candidate = candidates.find(
      (entry) => entry.instanceId === instanceId && entry.model === modelSelection.model,
    );
    if (
      !candidate ||
      candidate.enabled === false ||
      candidate.installed === false ||
      candidate.authOk === false
    ) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: `Selected route '${instanceId}/${modelSelection.model}' is not installed and ready.`,
        }),
      );
    }
    const usable = providerFamilyUsable(usage, instanceId);
    if (!usable.ok) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: `Selected route '${instanceId}/${modelSelection.model}' is unavailable: ${usable.detail ?? "capacity is exhausted"}.`,
        }),
      );
    }
    if (enforced && !rosterIndex.has(measuredCostKey(instanceId, modelSelection.model))) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: "assistPrompt",
          detail: `Selected route '${instanceId}/${modelSelection.model}' is outside the enforced roster.`,
        }),
      );
    }

    const provenance =
      card.modelRouteProvenance ??
      ({
        source: input.modelSelection || card.modelSelection ? "human" : "fallback",
        skill: null,
        at: DateTime.formatIso(yield* DateTime.now),
      } as const);
    const routeReason =
      provenance.source === "hermes"
        ? card.modelRouteReason?.trim() || `Hermes · ${provenance.skill ?? "semantic routing"}`
        : provenance.source === "human"
          ? "human selection"
          : "explicit settings fallback";
    const modelRouteReason = provenance.source === "human" ? null : routeReason;

    yield* Effect.logInfo("launch_active validated route", {
      cardId: card.id,
      reason: routeReason,
      instanceId,
      model: modelSelection.model,
      forceFresh,
    });

    if (
      !card.modelSelection ||
      String(card.modelSelection.instanceId) !== instanceId ||
      card.modelSelection.model !== modelSelection.model ||
      (card.modelRouteReason ?? null) !== modelRouteReason ||
      card.modelRouteProvenance?.source !== provenance.source
    ) {
      yield* deps.store
        .update({
          id: card.id as KanbanCardId,
          modelSelection,
          modelRouteReason,
          modelRouteProvenance: provenance,
        })
        .pipe(Effect.catch(() => Effect.void));
    }

    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const threadUuid = yield* deps.crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: "Failed to allocate thread id.",
            cause,
          }),
      ),
    );
    const messageUuid = yield* deps.crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: "Failed to allocate message id.",
            cause,
          }),
      ),
    );
    const commandUuid = yield* deps.crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "assistPrompt",
            detail: "Failed to allocate command id.",
            cause,
          }),
      ),
    );

    const threadId = ThreadId.make(threadUuid);
    const title = titleOf(card);
    // Every launch carries what the box already learned about this project, so
    // the second card never pays to rediscover what the first one was told.
    const lessons = lessonsForProject({ projectId: input.projectId });
    const basePrompt = withAgentContract(promptOf(card), board?.modelRoster ?? [], lessons);

    // One card, one workspace. The branch is fresh per card (same scheme as the
    // web path, `buildTemporaryWorktreeBranchName`) and the directory is keyed
    // by thread id, so two cards launched from the same project on the same
    // base branch land in two different places.
    let launchBranch: string | null = null;
    let launchWorktreePath: string | null = null;
    if (!deps.worktree && probe.isGitCheckout(project.workspaceRoot)) {
      yield* Effect.logError("launch_active has no worktree preparer for a git project", {
        cardId: card.id,
        projectId: input.projectId,
        projectCwd: project.workspaceRoot,
      });
      return yield* new TextGenerationError({
        operation: "assistPrompt",
        detail:
          `Not launching '${titleOf(card)}': this launch path has no git driver, so the card gets ` +
          `no workspace of its own in ${project.workspaceRoot}. The card stays where it is; ` +
          "running it in the project checkout would stack it on whatever the last card left there.",
      });
    }
    if (deps.worktree) {
      // Reclaim orphans before asking for another ~1.7GiB of workspace: a launch
      // that dies mid-`createWorktree` on a full disk leaves a partial workspace
      // no thread record points at, so failing launches used to feed the very
      // ENOSPC that caused them.
      const sweepReaper = yield* Effect.serviceOption(WorktreeReaper.WorktreeReaper);
      if (Option.isSome(sweepReaper)) {
        yield* sweepReaper.value.sweepOrphanedWorktrees().pipe(Effect.ignoreCause({ log: true }));
      }

      const branchUuid = yield* deps.crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "assistPrompt",
              detail: "Failed to allocate worktree branch name.",
              cause,
            }),
        ),
      );
      const branchHex = branchUuid.replace(/-/g, "");
      const branch = buildTemporaryWorktreeBranchName((byteLength) =>
        branchHex.slice(0, byteLength * 2),
      );
      // Card first, then the project's own default, then whatever the repo says
      // is default. A long-lived integration branch is set once on the project;
      // one card that has to sit somewhere else overrides it.
      const baseBranch = card.baseBranch ?? project.defaultBaseBranch ?? null;
      const prepared = yield* Effect.result(
        deps.worktree.prepare({
          projectCwd: project.workspaceRoot,
          threadId,
          branch,
          ...(baseBranch ? { baseBranch } : {}),
        }),
      );
      if (Result.isFailure(prepared)) {
        // Launching into the project checkout instead is what put seven cards'
        // work on one branch off a week-old `main`: each run committed on top of
        // the last, and the pull request swept the lot in. A git project that
        // cannot get its own workspace does not launch.
        const detail = prepared.failure.detail ?? prepared.failure.message;
        yield* Effect.logError("launch_active could not create a worktree", {
          cardId: card.id,
          threadId,
          projectCwd: project.workspaceRoot,
          detail,
        });
        return yield* new TextGenerationError({
          operation: "assistPrompt",
          detail:
            `Not launching '${titleOf(card)}': this card gets no workspace of its own — ${detail} ` +
            "The card stays in Prompts; running it in the project checkout would stack it on " +
            "whatever the last card left there.",
        });
      }
      if (prepared.success.kind === "prepared") {
        launchBranch = prepared.success.branch;
        launchWorktreePath = prepared.success.worktreePath;
        yield* Effect.logInfo("launch_active prepared worktree", {
          cardId: card.id,
          threadId,
          branch: launchBranch,
          worktreePath: launchWorktreePath,
        });
      } else {
        // No git in the project at all: there is no stale base to protect the
        // card from, so it runs in the project directory — but only if that
        // directory is still a real one to run in.
        const stillUnusable = unusableRoot();
        if (stillUnusable) {
          yield* Effect.logError("launch_active refused an in-place launch", {
            cardId: card.id,
            projectCwd: project.workspaceRoot,
            detail: stillUnusable,
          });
          return yield* refuseRoot(stillUnusable);
        }
        yield* Effect.logInfo("launch_active launching without a worktree", {
          cardId: card.id,
          threadId,
          projectCwd: project.workspaceRoot,
          reason: prepared.success.reason,
        });
      }
    }

    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const media = buildLaunchMedia({
      card,
      threadId,
      attachmentsDir: Option.isSome(serverConfig) ? serverConfig.value.attachmentsDir : null,
      worktreePath: launchWorktreePath,
    });
    if (media.error !== null) {
      return yield* new TextGenerationError({
        operation: "assistPrompt",
        detail: `Not launching '${title}': ${media.error}. The card stays where it is; fix the attachment and launch again.`,
      });
    }

    // `bootstrap` on thread.turn.start is only interpreted by ws.ts
    // (`dispatchBootstrapTurnStart`); a raw engine dispatch ignores it and the
    // decider then rejects the turn because the thread does not exist yet. So
    // create the thread here, explicitly, with the worktree already attached.
    yield* deps.orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`kanban:launch-active-thread:${commandUuid}`),
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
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "assistPrompt",
              detail: cause instanceof Error ? cause.message : "Failed to create coding thread.",
              cause,
            }),
        ),
      );

    // Same order as the web bootstrap path: thread.create → setup script →
    // turn.start. A setup failure is logged, not fatal — a launch without
    // node_modules beats a card stuck in Prompts.
    if (deps.setupScript && launchWorktreePath) {
      const setup = yield* Effect.result(
        deps.setupScript.runForThread({
          threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          worktreePath: launchWorktreePath,
        }),
      );
      if (Result.isFailure(setup)) {
        yield* Effect.logError("launch_active could not start the setup script", {
          cardId: card.id,
          threadId,
          worktreePath: launchWorktreePath,
          detail: setup.failure.message,
        });
      } else if (setup.success.status === "started") {
        yield* Effect.logInfo("launch_active started setup script", {
          cardId: card.id,
          threadId,
          scriptId: setup.success.scriptId,
          terminalId: setup.success.terminalId,
        });
      }
    }

    const text = `${basePrompt}${media.textSuffix}`;
    const imageAttachments = media.imageAttachments;

    yield* deps.orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`kanban:launch-active:${commandUuid}`),
        threadId,
        message: {
          messageId: MessageId.make(messageUuid),
          role: "user",
          text,
          attachments: imageAttachments,
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: nowIso,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "assistPrompt",
              detail: cause instanceof Error ? cause.message : "Failed to start coding thread.",
              cause,
            }),
        ),
      );

    // Counted here, not where the block was rendered: a launch that refused for
    // a worktree or an attachment taught nobody anything.
    if (lessons.length > 0)
      noteLessonsTaught(
        lessons.map((lesson) => lesson.id),
        nowIso,
      );

    beginRoutingUsageObservation({
      cardId: card.id as string,
      routeId: `${instanceId}/${modelSelection.model}`,
      pool: capacityPoolForRoute(instanceId, usage),
      at: nowIso,
    });

    const updated = yield* deps.store
      .update({
        id: card.id as KanbanCardId,
        at: "active",
        threadId,
        prepStatus: "ready",
        modelSelection,
        modelRouteReason,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "assistPrompt",
              detail: cause instanceof Error ? cause.message : "Failed to link card to thread.",
              cause,
            }),
        ),
      );

    return {
      card: updated,
      threadId,
      reusedExistingThread: false,
    } satisfies KanbanLaunchActiveResult;
  });
}
