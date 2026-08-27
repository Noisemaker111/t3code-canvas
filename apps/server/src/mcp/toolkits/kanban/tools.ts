/**
 * Kanban board MCP tools for Hermes and MCP-connected agents.
 * Hermes turns low-effort / STT board-composer input into Prompts and owns
 * skills, queue moves, Active, and kanban_heartbeat.
 * Heavy coding stays in launch_active threads.
 */
import {
  KanbanBoardControlResult,
  KanbanCard,
  ComponentId,
  KanbanLaunchActiveResult,
  KanbanMergePrResult,
  KanbanOpenPrResult,
  KanbanPrepStatus,
  ModelSelection,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as Crypto from "effect/Crypto";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as KanbanStore from "../../../kanban/KanbanStore.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  KanbanStore.KanbanStore,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
  ServerSettings.ServerSettingsService,
  Crypto.Crypto,
];

/** PR/merge additionally need the git workflow + forge registry. */
const prDependencies = [
  ...dependencies,
  GitWorkflowService.GitWorkflowService,
  SourceControlProviderRegistry.SourceControlProviderRegistry,
];

const boardTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBoardTool = <T extends Tool.Any>(tool: T): T =>
  boardTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyBoardTool = <T extends Tool.Any>(tool: T): T =>
  safeBoardTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const KanbanMcpFailure = Schema.Union([
  PreviewAutomationUnavailableError,
  Schema.Struct({
    _tag: Schema.Literal("KanbanMcpError"),
    message: Schema.String,
  }),
]);

export const KanbanListTool = readonlyBoardTool(
  Tool.make("kanban_list", {
    description:
      "List all kanban cards (prompts / active / pr / done) with linked threadId. Prompts = capture + ready queue (prepStatus gates launch).",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ cards: Schema.Array(KanbanCard) }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "List kanban board"),
);

export const KanbanCreatePromptTool = safeBoardTool(
  Tool.make("kanban_create_prompt", {
    description:
      "Create one READY card in the Prompts queue. One coding task per card. Set projectId from the PROJECTS list so Hermes can auto-launch into the right repo. Never pack multiple unrelated tasks into one card.",
    parameters: Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      projectId: Schema.optional(Schema.String),
    }),
    success: KanbanCard,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Create ready prompt card"),
);

export const KanbanCreateDraftTool = safeBoardTool(
  Tool.make("kanban_create_draft", {
    description:
      "Create a Prompt from low-effort / STT user input (untouched until Hermes structures it). REQUIRED: projectId from PROJECTS (ask one clarifying question if unclear). REQUIRED when a clear pick exists: modelSelection from AVAILABLE MODELS + USAGE. Body is Mission/Work/Constraints/Done when only — never put Project/Model in the body text.",
    parameters: Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      projectId: Schema.String,
      modelSelection: Schema.optional(ModelSelection),
      baseBranch: Schema.optional(Schema.String),
    }),
    success: KanbanCard,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Create prompt card from capture"),
);

export const KanbanUpdatePromptTool = safeBoardTool(
  Tool.make("kanban_update_prompt", {
    description:
      "Update title, body, prepStatus, projectId, and/or modelSelection on an existing card. Project and model are fields — never encode them as # Project / # Model body lines.",
    parameters: Schema.Struct({
      id: Schema.String,
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      prepStatus: Schema.optional(KanbanPrepStatus),
      projectId: Schema.optional(Schema.NullOr(Schema.String)),
      modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
      baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    success: KanbanCard,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Update kanban card"),
);

export const KanbanMoveTool = safeBoardTool(
  Tool.make("kanban_move", {
    description:
      "Move a card between prompts | active | pr | done. Active requires a ready Prompt. PR needs Active+thread.",
    parameters: Schema.Struct({
      id: Schema.String,
      at: ComponentId,
    }),
    success: KanbanCard,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Move kanban card"),
);

export const KanbanDeleteTool = boardTool(
  Tool.make("kanban_delete", {
    description: "Delete a kanban card by id.",
    parameters: Schema.Struct({
      id: Schema.String,
    }),
    success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Delete kanban card"),
);

export const KanbanLaunchActiveTool = boardTool(
  Tool.make("kanban_launch_active", {
    description:
      "Easy primitive: start one coding-agent thread for a ready prompt card, link threadId, move to Active, and send the card body as the first user message. Prefer card.projectId or pass projectId from PROJECTS. Do not implement the work yourself — launch it.",
    parameters: Schema.Struct({
      id: Schema.String,
      projectId: Schema.optional(Schema.String),
    }),
    success: KanbanLaunchActiveResult,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Launch active coding thread"),
);

export const KanbanOpenPrTool = boardTool(
  Tool.make("kanban_open_pr", {
    description:
      "Commit whatever the card's coding thread left in its worktree, push it on a feature branch, open the pull request, and move the card to PR. The coding agent never runs git — this is how work leaves a thread. Safe to re-run: extra commits go onto the same PR.",
    parameters: Schema.Struct({
      id: Schema.String,
    }),
    success: KanbanOpenPrResult,
    failure: KanbanMcpFailure,
    dependencies: prDependencies,
  }).annotate(Tool.Title, "Open pull request for card"),
);

export const KanbanMergePrTool = boardTool(
  Tool.make("kanban_merge_pr", {
    description:
      "Merge the card's pull request and move it to Archived. Fails with the forge's own reason on a conflict, a red required check, or a missing approval — the card stays in PR so you can fix it and retry.",
    parameters: Schema.Struct({
      id: Schema.String,
    }),
    success: KanbanMergePrResult,
    failure: KanbanMcpFailure,
    dependencies: prDependencies,
  }).annotate(Tool.Title, "Merge card pull request"),
);

export const KanbanApplyPlanTool = boardTool(
  Tool.make("kanban_apply_plan", {
    description:
      "Apply a list of board actions in order (create_prompt, update_prompt, move, delete). launch_active is separate — call kanban_launch_active for coding threads.",
    parameters: Schema.Struct({
      actions: Schema.Array(Schema.Unknown),
      reply: Schema.optional(Schema.String),
    }),
    success: KanbanBoardControlResult,
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Apply kanban action plan"),
);

export const KanbanListModelsTool = readonlyBoardTool(
  Tool.make("kanban_list_models", {
    description:
      "List ready provider models with cost tier ($) and usage status. Use before setting modelSelection on prompts.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      text: Schema.String,
      models: Schema.Array(
        Schema.Struct({
          instanceId: Schema.String,
          model: Schema.String,
          name: Schema.String,
          costTier: Schema.Number,
          usable: Schema.Boolean,
          detail: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "List available models"),
);

export const KanbanUsageSnapshotTool = readonlyBoardTool(
  Tool.make("kanban_usage_snapshot", {
    description: "Fetch the current AI usage snapshot (limits / utilization per provider family).",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      text: Schema.String,
      usage: Schema.Unknown,
    }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "AI usage snapshot"),
);

export const KanbanBoardSettingsTool = readonlyBoardTool(
  Tool.make("kanban_board_settings", {
    description:
      "Read Board policy from server settings (structure prompts, auto-launch Prompts→Active, stuck timeout). Call at the start of each tick and honor these flags.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      structureDrafts: Schema.Boolean,
      autoLaunch: Schema.Boolean,
      stuckPrepMs: Schema.Number,
      alwaysOnSkillIds: Schema.Array(Schema.String),
      hermesBrainEnabled: Schema.Boolean,
    }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Board Hermes policy"),
);

export const KanbanHeartbeatTool = safeBoardTool(
  Tool.make("kanban_heartbeat", {
    description:
      "Report a board heartbeat. Updates the Board Hermes chip (lastBeatAt + summary). Call once at the end of each board tick. Summary like: p2/a0/pr0 · moved 1 · launched 0.",
    parameters: Schema.Struct({
      summary: Schema.String,
    }),
    success: Schema.Struct({
      ok: Schema.Boolean,
      lastBeatAt: Schema.String,
      lastSummary: Schema.String,
    }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Hermes board heartbeat"),
);

export const KanbanPapercutTool = safeBoardTool(
  Tool.make("kanban_papercut", {
    description:
      "Report a broken tool, command or environment you had to work around, so the next agent does not rediscover it. Call it the moment you route around something and keep going — do not explain it in your closing note instead. One line each: what broke, the actual error, what you did instead. Thread, card, project, model and worktree are stamped for you. Recurrences are deduped into one counted entry; past the threshold the board files its own fix card.",
    parameters: Schema.Struct({
      tool: Schema.String.annotate({
        description: "The tool, command or binary that broke, e.g. apply_patch, rift, pnpm.",
      }),
      summary: Schema.String.annotate({ description: "One sentence: what broke." }),
      evidence: Schema.String.annotate({
        description: "The error text itself, not a paraphrase.",
      }),
      workaround: Schema.optional(
        Schema.String.annotate({
          description: "What you did instead. This is what unblocks the next agent.",
        }),
      ),
      scope: Schema.optional(
        Schema.Literals(["harness", "repo", "env", "upstream"]).annotate({
          description:
            "Where the fix has to land. `upstream` = a bug in someone else's tool; it becomes its own card and never reopens the work you are doing. Defaults to harness.",
        }),
      ),
    }),
    success: Schema.Struct({
      ok: Schema.Boolean,
      fingerprint: Schema.String,
      count: Schema.Number,
      status: Schema.String,
    }),
    failure: KanbanMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Report tooling friction"),
);

export const KanbanToolkit = Toolkit.make(
  KanbanListTool,
  KanbanCreatePromptTool,
  KanbanCreateDraftTool,
  KanbanUpdatePromptTool,
  KanbanMoveTool,
  KanbanDeleteTool,
  KanbanLaunchActiveTool,
  KanbanOpenPrTool,
  KanbanMergePrTool,
  KanbanApplyPlanTool,
  KanbanListModelsTool,
  KanbanUsageSnapshotTool,
  KanbanBoardSettingsTool,
  KanbanHeartbeatTool,
  KanbanPapercutTool,
);
