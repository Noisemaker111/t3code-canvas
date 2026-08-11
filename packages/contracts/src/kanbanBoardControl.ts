import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { KanbanCard, KanbanCardId, ComponentId, KanbanPrepStatus } from "./kanban.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Board control primitives (RPCs / tool surface).
 *
 * - **Hermes**: the persistent board brain that watches the board and
 *   structures low-effort input into Prompts.
 * - **launch_active**: easy primitive to start one coding thread per card.
 *
 * Where a card sits is visual status; moves must pass the board's gate.
 */

export const KanbanBoardControlActionType = Schema.Literals([
  "create_prompt",
  "update_prompt",
  "move",
  "delete",
  "launch_active",
]);
export type KanbanBoardControlActionType = typeof KanbanBoardControlActionType.Type;

export const KanbanBoardControlCreatePromptAction = Schema.Struct({
  type: Schema.Literal("create_prompt"),
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  /** Structured by Hermes → default ready when omitted. */
  prepStatus: Schema.optionalKey(KanbanPrepStatus),
  /** Target project for later Hermes/Active launch. */
  projectId: Schema.optionalKey(ProjectId),
});
export type KanbanBoardControlCreatePromptAction = typeof KanbanBoardControlCreatePromptAction.Type;

export const KanbanBoardControlUpdatePromptAction = Schema.Struct({
  type: Schema.Literal("update_prompt"),
  id: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  body: Schema.optionalKey(TrimmedString),
  prepStatus: Schema.optionalKey(KanbanPrepStatus),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
});
export type KanbanBoardControlUpdatePromptAction = typeof KanbanBoardControlUpdatePromptAction.Type;

export const KanbanBoardControlMoveAction = Schema.Struct({
  type: Schema.Literal("move"),
  id: TrimmedNonEmptyString,
  at: ComponentId,
});
export type KanbanBoardControlMoveAction = typeof KanbanBoardControlMoveAction.Type;

export const KanbanBoardControlDeleteAction = Schema.Struct({
  type: Schema.Literal("delete"),
  id: TrimmedNonEmptyString,
});
export type KanbanBoardControlDeleteAction = typeof KanbanBoardControlDeleteAction.Type;

export const KanbanBoardControlLaunchActiveAction = Schema.Struct({
  type: Schema.Literal("launch_active"),
  id: TrimmedNonEmptyString,
});
export type KanbanBoardControlLaunchActiveAction = typeof KanbanBoardControlLaunchActiveAction.Type;

export const KanbanBoardControlAction = Schema.Union([
  KanbanBoardControlCreatePromptAction,
  KanbanBoardControlUpdatePromptAction,
  KanbanBoardControlMoveAction,
  KanbanBoardControlDeleteAction,
  KanbanBoardControlLaunchActiveAction,
]);
export type KanbanBoardControlAction = typeof KanbanBoardControlAction.Type;

export const KanbanBoardControlInput = Schema.Struct({
  /** User ramble / instruction for structured board planning (cheap one-shot). */
  message: TrimmedNonEmptyString,
  /**
   * Optional model override. When omitted, server uses the configured
   * text-generation model (cheap assist path).
   */
  modelSelection: Schema.optionalKey(ModelSelection),
  cwd: Schema.optionalKey(Schema.String),
});
export type KanbanBoardControlInput = typeof KanbanBoardControlInput.Type;

export const KanbanBoardControlAppliedAction = Schema.Struct({
  type: KanbanBoardControlActionType,
  /** Human-readable one-liner for UI toasts. */
  summary: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
});
export type KanbanBoardControlAppliedAction = typeof KanbanBoardControlAppliedAction.Type;

export const KanbanBoardControlResult = Schema.Struct({
  /** Short assistant reply to show the user. */
  reply: TrimmedString,
  applied: Schema.Array(KanbanBoardControlAppliedAction),
  /** Fresh board after applying actions. */
  cards: Schema.Array(KanbanCard),
});
export type KanbanBoardControlResult = typeof KanbanBoardControlResult.Type;

// ---------------------------------------------------------------------------
// launch_active primitive — one card → one coding thread + turn start
// ---------------------------------------------------------------------------

export const KanbanLaunchActiveInput = Schema.Struct({
  id: KanbanCardId,
  /** Project that owns the new coding thread. Required for bootstrap. */
  projectId: ProjectId,
  modelSelection: Schema.optionalKey(ModelSelection),
  /**
   * When true, always create a new coding thread even if the card already
   * has threadId (fat-context / cost policy). Hermes/server may also set this
   * after reading the linked thread's context-window usage.
   */
  forceFreshThread: Schema.optionalKey(Schema.Boolean),
  /** Working directory hint for provider home; server falls back to config.cwd. */
  cwd: Schema.optionalKey(Schema.String),
});
export type KanbanLaunchActiveInput = typeof KanbanLaunchActiveInput.Type;

export const KanbanLaunchActiveResult = Schema.Struct({
  card: KanbanCard,
  threadId: TrimmedNonEmptyString,
  reusedExistingThread: Schema.Boolean,
});
export type KanbanLaunchActiveResult = typeof KanbanLaunchActiveResult.Type;
