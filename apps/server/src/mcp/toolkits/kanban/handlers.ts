/**
 * Handlers for kanban MCP toolkit — thin wrappers over KanbanStore + launch_active.
 */
import type {
  KanbanBoardControlAction,
  KanbanBoardControlAppliedAction,
  KanbanCard,
  KanbanCardId,
  ComponentId,
  KanbanPrepStatus,
  ProjectId,
  ModelSelection,
} from "@t3tools/contracts";
import { stripKanbanProjectModelHeaders } from "@t3tools/shared/kanbanPromptFormat";
import { boardRulePolicy } from "@t3tools/shared/boardRules";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { parseBoardControlPlan } from "../../../kanban/BoardControl.ts";
import { DEFAULT_BOARD_CONVENTIONS, explainMoveBlock } from "@t3tools/shared/moveGate";
import { KanbanStore } from "../../../kanban/KanbanStore.ts";
import { runLaunchActive } from "../../../kanban/LaunchActive.ts";
import { runMergePr, runOpenPr } from "../../../kanban/PrPipeline.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import { launchWorktreePreparerOption } from "../../../kanban/launchWorktree.ts";
import { projectSetupScriptRunnerOption } from "../../../project/ProjectSetupScriptRunner.ts";
import { recordHermesBeat } from "../../../kanban/hermes/HermesBrain.ts";
import { recordFriction, type FrictionScope } from "../../../friction/frictionStore.ts";
import { wakeForCardCreated, wakeForCardUpdated } from "../../../kanban/hermes/boardWake.ts";
import {
  buildRosterIndex,
  candidatesFromShellProviders,
  formatAvailableModelsBlock,
  measuredCostKey,
  tierFor,
  formatUsageBlock,
  providerFamilyUsable,
} from "../../../kanban/ModelRouting.ts";
import { cachedMeasuredCostTiers } from "../../../kanban/budget/BudgetService.ts";
import { modelEvidenceIndex } from "../../../kanban/modelEvidence.ts";
import { getUsageService } from "../../../usage/UsageService.ts";
import { KanbanToolkit } from "./tools.ts";

const mcpError = (message: string) => Effect.fail({ _tag: "KanbanMcpError" as const, message });

const requireKanban = () => McpInvocationContext.requireMcpCapability("kanban");

const toCardId = (id: string) => id as KanbanCardId;

const prPipelineDeps = () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore;
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const crypto = yield* Crypto.Crypto;
    // Optional so this stays out of the requirement channel; without it
    // `runOpenPr` cannot tell a mid-merge worktree from a fresh one.
    const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
    return {
      store,
      projection,
      gitWorkflow,
      sourceControl,
      crypto: { randomUUIDv4: crypto.randomUUIDv4.pipe(Effect.orDie) },
      git: Option.getOrNull(git),
    };
  });

/** getUsageSafe never rejects; wrap only so handlers stay Effect-shaped. */
const loadUsage = () => Effect.promise(() => getUsageService().getUsageSafe());

const handlers = {
  kanban_list: () =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const listed = yield* store.list().pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "list failed",
        })),
      );
      return { cards: listed.cards };
    }),

  kanban_create_prompt: (input: { title: string; body: string; projectId?: string | undefined }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const title = input.title.trim();
      const body = input.body.trim();
      if (!title || !body) {
        return yield* mcpError("title and body are required");
      }
      const projectId =
        typeof input.projectId === "string" && input.projectId.trim().length > 0
          ? (input.projectId.trim() as ProjectId)
          : undefined;
      // Untouched until Hermes structures/routes — UI shows Waiting, not fake Structuring/ready.
      return yield* store
        .create({
          title,
          body,
          at: "prompts",
          prepStatus: "untouched",
          ...(projectId ? { projectId } : {}),
        })
        .pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "create failed",
          })),
          Effect.tap(() => Effect.sync(() => wakeForCardCreated({ at: "prompts" }))),
        );
    }),

  kanban_create_draft: (input: {
    title: string;
    body: string;
    projectId: string;
    modelSelection?: ModelSelection | undefined;
    baseBranch?: string | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const title = input.title.trim();
      const body = stripKanbanProjectModelHeaders(input.body);
      const projectIdRaw = input.projectId.trim();
      if (!title || !body) {
        return yield* mcpError("title and body are required");
      }
      if (!projectIdRaw) {
        return yield* mcpError(
          "projectId is required — pick an id from PROJECTS, or ask the user one clarifying question first",
        );
      }
      const projectId = projectIdRaw as ProjectId;
      return yield* store
        .create({
          title,
          body,
          at: "prompts",
          prepStatus: "untouched",
          projectId,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        })
        .pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "create draft failed",
          })),
          Effect.tap(() => Effect.sync(() => wakeForCardCreated({ at: "prompts" }))),
        );
    }),

  kanban_update_prompt: (input: {
    id: string;
    title?: string | undefined;
    body?: string | undefined;
    prepStatus?: KanbanPrepStatus | undefined;
    projectId?: string | null | undefined;
    modelSelection?: ModelSelection | null | undefined;
    baseBranch?: string | null | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const projectId =
        input.projectId === null
          ? null
          : typeof input.projectId === "string" && input.projectId.trim().length > 0
            ? (input.projectId.trim() as ProjectId)
            : undefined;
      return yield* store
        .update({
          id: toCardId(input.id),
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          ...(input.body !== undefined ? { body: stripKanbanProjectModelHeaders(input.body) } : {}),
          ...(input.prepStatus ? { prepStatus: input.prepStatus } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
        })
        .pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "update failed",
          })),
          Effect.tap((card) => Effect.sync(() => wakeForCardUpdated({ body: card.body }))),
        );
    }),

  kanban_move: (input: { id: string; at: ComponentId }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const listed = yield* store.list().pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "list failed",
        })),
      );
      const card = listed.cards.find((entry) => entry.id === input.id);
      if (!card) {
        return yield* mcpError(`Card '${input.id}' not found`);
      }
      const block = explainMoveBlock(card, input.at, DEFAULT_BOARD_CONVENTIONS);
      if (block) {
        return yield* mcpError(block);
      }
      return yield* store
        .update({
          id: toCardId(input.id),
          at: input.at,
          ...(input.at === "prompts" ? { prepStatus: "ready" as const } : {}),
        })
        .pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "move failed",
          })),
          Effect.tap((card) => Effect.sync(() => wakeForCardUpdated({ at: card.at }))),
        );
    }),

  kanban_delete: (input: { id: string }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      return yield* store.remove({ id: toCardId(input.id) }).pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "delete failed",
        })),
      );
    }),

  kanban_launch_active: (input: { id: string; projectId?: string | undefined }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const crypto = yield* Crypto.Crypto;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const launchWorktreePreparer = yield* launchWorktreePreparerOption;
      const setupScriptRunner = yield* projectSetupScriptRunnerOption;

      // Prefer explicit projectId, then card.projectId. Do not invent a project —
      // Hermes routes it; launch only uses what is already set.
      let projectId =
        typeof input.projectId === "string" && input.projectId.trim().length > 0
          ? (input.projectId.trim() as ProjectId)
          : undefined;
      if (!projectId) {
        const listed = yield* store.list().pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "list failed",
          })),
        );
        const existing = listed.cards.find((entry) => entry.id === input.id);
        if (existing?.projectId) {
          projectId = existing.projectId;
        }
      }
      if (!projectId) {
        return yield* mcpError(
          "projectId required — set it on the card (Hermes) or pass projectId from PROJECTS",
        );
      }

      return yield* runLaunchActive(
        {
          store,
          orchestrationEngine,
          projection,
          serverSettings,
          crypto: {
            randomUUIDv4: crypto.randomUUIDv4.pipe(Effect.orDie),
          },
          listProviders: providerRegistry.getProviders,
          worktree: launchWorktreePreparer,
          setupScript: setupScriptRunner,
        },
        { id: toCardId(input.id), projectId },
      ).pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "launch_active failed",
        })),
      );
    }),

  kanban_open_pr: (input: { id: string }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const deps = yield* prPipelineDeps();
      return yield* runOpenPr(deps, { id: toCardId(input.id) }).pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "open_pr failed",
        })),
      );
    }),

  kanban_merge_pr: (input: { id: string }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const deps = yield* prPipelineDeps();
      return yield* runMergePr(deps, { id: toCardId(input.id) }).pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "merge_pr failed",
        })),
      );
    }),

  kanban_apply_plan: (input: { actions: ReadonlyArray<unknown>; reply?: string | undefined }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const store = yield* KanbanStore;
      const plan = parseBoardControlPlan(
        JSON.stringify({
          reply: input.reply ?? "Applied board plan",
          actions: input.actions,
        }),
      );
      const applied: KanbanBoardControlAppliedAction[] = [];
      let cardsById = new Map<string, KanbanCard>();
      {
        const listed = yield* store.list().pipe(
          Effect.mapError((cause) => ({
            _tag: "KanbanMcpError" as const,
            message: cause instanceof Error ? cause.message : "list failed",
          })),
        );
        cardsById = new Map(listed.cards.map((card) => [card.id as string, card]));
      }

      for (const action of plan.actions as ReadonlyArray<KanbanBoardControlAction>) {
        if (action.type === "create_prompt") {
          const created = yield* store
            .create({
              title: action.title,
              body: action.body,
              at: "prompts",
              prepStatus: "ready",
              ...(action.projectId ? { projectId: action.projectId } : {}),
            })
            .pipe(
              Effect.mapError((cause) => ({
                _tag: "KanbanMcpError" as const,
                message: cause instanceof Error ? cause.message : "create failed",
              })),
            );
          cardsById.set(created.id, created);
          applied.push({ type: "create_prompt", summary: `Created ${created.title}`, ok: true });
          continue;
        }
        if (action.type === "update_prompt") {
          const existing = cardsById.get(action.id);
          if (!existing) {
            applied.push({
              type: "update_prompt",
              summary: `Unknown ${action.id}`,
              ok: false,
              detail: "not found",
            });
            continue;
          }
          const updated = yield* store
            .update({
              id: existing.id,
              ...(action.title ? { title: action.title } : {}),
              ...(action.body !== undefined ? { body: action.body } : {}),
              ...(action.prepStatus ? { prepStatus: action.prepStatus } : {}),
              ...(action.projectId !== undefined ? { projectId: action.projectId } : {}),
            })
            .pipe(
              Effect.mapError((cause) => ({
                _tag: "KanbanMcpError" as const,
                message: cause instanceof Error ? cause.message : "update failed",
              })),
            );
          cardsById.set(updated.id, updated);
          applied.push({ type: "update_prompt", summary: `Updated ${updated.title}`, ok: true });
          continue;
        }
        if (action.type === "move") {
          const existing = cardsById.get(action.id);
          if (!existing) {
            applied.push({
              type: "move",
              summary: `Unknown ${action.id}`,
              ok: false,
              detail: "not found",
            });
            continue;
          }
          const block = explainMoveBlock(existing, action.at, DEFAULT_BOARD_CONVENTIONS);
          if (block) {
            applied.push({
              type: "move",
              summary: `Blocked ${existing.title}`,
              ok: false,
              detail: block,
            });
            continue;
          }
          const updated = yield* store.update({ id: existing.id, at: action.at }).pipe(
            Effect.mapError((cause) => ({
              _tag: "KanbanMcpError" as const,
              message: cause instanceof Error ? cause.message : "move failed",
            })),
          );
          cardsById.set(updated.id, updated);
          applied.push({
            type: "move",
            summary: `Moved ${updated.title} → ${action.at}`,
            ok: true,
          });
          continue;
        }
        if (action.type === "delete") {
          const existing = cardsById.get(action.id);
          if (!existing) {
            applied.push({
              type: "delete",
              summary: `Unknown ${action.id}`,
              ok: false,
              detail: "not found",
            });
            continue;
          }
          yield* store.remove({ id: existing.id }).pipe(
            Effect.mapError((cause) => ({
              _tag: "KanbanMcpError" as const,
              message: cause instanceof Error ? cause.message : "delete failed",
            })),
          );
          cardsById.delete(action.id);
          applied.push({ type: "delete", summary: `Deleted ${existing.title}`, ok: true });
          continue;
        }
        if (action.type === "launch_active") {
          applied.push({
            type: "launch_active",
            summary: `Use kanban_launch_active for ${action.id}`,
            ok: false,
            detail: "Call kanban_launch_active tool for coding threads",
          });
        }
      }

      const fresh = yield* store.list().pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "re-list failed",
        })),
      );
      return {
        reply: plan.reply,
        applied,
        cards: fresh.cards,
      };
    }),

  kanban_list_models: () =>
    Effect.gen(function* () {
      yield* requireKanban();
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providers = yield* providerRegistry.getProviders;
      const usage = yield* loadUsage();
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const board = yield* serverSettings.getSettings.pipe(
        Effect.map((current) => current.boardSettings),
        Effect.orElseSucceed(() => null),
      );
      const roster = {
        entries: board?.modelRoster ?? [],
        enforced: board?.modelRosterEnforced === true,
      };
      const rosterIndex = buildRosterIndex(roster.entries);
      const measured = cachedMeasuredCostTiers();
      const candidates = candidatesFromShellProviders(providers);
      const evidence = yield* Effect.promise(() => modelEvidenceIndex(candidates));
      const models = candidates
        .filter((candidate) => candidate.enabled && candidate.installed !== false)
        .filter(
          (candidate) =>
            !roster.enforced ||
            rosterIndex.has(measuredCostKey(candidate.instanceId, candidate.model)),
        )
        .map((candidate) => {
          const usable = providerFamilyUsable(usage, candidate.instanceId);
          const priced = tierFor(candidate, measured);
          const facts = evidence.get(measuredCostKey(candidate.instanceId, candidate.model));
          return {
            instanceId: candidate.instanceId,
            model: candidate.model,
            name: candidate.name,
            costTier: priced.tier,
            costBasis: priced.basis,
            scores: facts?.scores ?? null,
            benchSource: facts?.benchSource ?? null,
            medianTurnMs: facts?.medianTurnMs ?? null,
            tokensPerSecond: facts?.tokensPerSecond ?? null,
            usable: usable.ok,
            detail: usable.detail,
          };
        });
      return {
        text: formatAvailableModelsBlock(candidates, usage, measured, roster, evidence),
        models,
      };
    }),

  kanban_usage_snapshot: () =>
    Effect.gen(function* () {
      yield* requireKanban();
      const usage = yield* loadUsage();
      return {
        text: formatUsageBlock(usage),
        usage,
      };
    }),

  kanban_board_settings: () =>
    Effect.gen(function* () {
      yield* requireKanban();
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => ({
          _tag: "KanbanMcpError" as const,
          message: cause instanceof Error ? cause.message : "settings read failed",
        })),
      );
      const board = settings.boardSettings;
      return {
        // "Auto-apply skills" means structure drafts into agent-ready Prompts.
        structureDrafts: boardRulePolicy(board).structureDrafts,
        autoLaunch: boardRulePolicy(board).launchPrompts,
        stuckPrepMs: board.hermesStuckPrepMs,
        alwaysOnSkillIds: [...board.alwaysOnSkillIds],
        hermesBrainEnabled: board.hermesBrainEnabled,
      };
    }),

  kanban_papercut: (input: {
    tool: string;
    summary: string;
    evidence: string;
    workaround?: string | undefined;
    scope?: FrictionScope | undefined;
  }) =>
    Effect.gen(function* () {
      const invocation = yield* requireKanban();
      const threadId = String(invocation.threadId);
      const store = yield* KanbanStore;
      // Best effort: a papercut is worth keeping even if the board read fails,
      // so the stamp degrades to just the thread rather than losing the report.
      const card = yield* store.list().pipe(
        Effect.map(
          (listed) => listed.cards.find((c) => c.threadId === invocation.threadId) ?? null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const context: Record<string, string> = { threadId };
      if (card?.projectId) context["projectId"] = String(card.projectId);
      if (card?.modelSelection) {
        context["model"] = card.modelSelection.model;
        context["harness"] = String(card.modelSelection.instanceId);
      }
      const entry = recordFriction({
        source: "agent",
        scope: input.scope ?? "harness",
        tool: input.tool,
        summary: input.summary,
        evidence: input.evidence,
        workaround: input.workaround ?? null,
        threadId,
        cardId: card ? String(card.id) : null,
        context,
      });
      return {
        ok: true as const,
        fingerprint: entry.fingerprint,
        count: entry.count,
        status: entry.status,
      };
    }),

  kanban_heartbeat: (input: { summary: string }) =>
    Effect.gen(function* () {
      yield* requireKanban();
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const status = recordHermesBeat({ summary: input.summary, beatAtIso: nowIso });
      return {
        ok: true as const,
        lastBeatAt: status.lastBeatAt ?? nowIso,
        lastSummary: status.lastSummary ?? "",
      };
    }),
} satisfies Parameters<typeof KanbanToolkit.toLayer>[0];

export const KanbanToolkitHandlersLive = KanbanToolkit.toLayer(handlers);
