/**
 * Board-control intake and deterministic move conventions.
 *
 * Semantic planning does not live here. One user message is captured as one
 * untouched Prompt; Hermes then owns understanding, project resolution, route
 * selection, placement and launch through the typed LaunchPlan path.
 *
 * @module kanban/BoardControl
 */
import type {
  KanbanBoardControlAction,
  KanbanBoardControlInput,
  KanbanBoardControlResult,
  KanbanCard,
  ComponentId,
  KanbanPrepStatus,
  ProjectId,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ServerSettingsService } from "../serverSettings.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { KanbanStore } from "./KanbanStore.ts";
import { requestHermesWake } from "./hermes/HermesBrain.ts";

const PlannedActionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create_prompt"),
    title: Schema.String,
    body: Schema.String,
    prepStatus: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("update_prompt"),
    id: Schema.String,
    title: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    prepStatus: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("move"), id: Schema.String, at: Schema.String }),
  Schema.Struct({ type: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("launch_active"), id: Schema.String }),
]);
const ExplicitPlanSchema = Schema.Struct({
  reply: Schema.optional(Schema.String),
  actions: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeExplicitPlan = Schema.decodeUnknownOption(ExplicitPlanSchema);
const decodeExplicitAction = Schema.decodeUnknownOption(PlannedActionSchema);

function normalizePrep(raw: string | undefined): KanbanPrepStatus | null {
  return raw === "untouched" || raw === "processing" || raw === "ready" || raw === "failed"
    ? raw
    : null;
}

/**
 * The component an action names. Any id the board could have, not only the four
 * a fresh canvas is seeded with: a plan that says "research" must reach the
 * component called research rather than being dropped as unknown.
 */
function normalizeTarget(raw: string): ComponentId | null {
  const id = raw.trim();
  if (id === "draft") return "prompts";
  return id.length === 0 ? null : id;
}

/** Decode actions explicitly supplied to the MCP API; this performs no planning. */
export function parseBoardControlPlan(raw: string): {
  reply: string;
  actions: ReadonlyArray<KanbanBoardControlAction>;
} {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { reply: "No board changes.", actions: [] };
  }
  const decodedPlan = decodeExplicitPlan(json);
  if (decodedPlan._tag === "None") return { reply: "No board changes.", actions: [] };

  const actions: KanbanBoardControlAction[] = [];
  for (const entry of decodedPlan.value.actions ?? []) {
    const decoded = decodeExplicitAction(entry);
    if (decoded._tag === "None") continue;
    const action = decoded.value;
    if (action.type === "create_prompt") {
      const title = action.title.trim();
      const body = action.body.trim();
      if (!title || !body) continue;
      const projectId = action.projectId?.trim();
      actions.push({
        type: "create_prompt",
        title,
        body,
        prepStatus: normalizePrep(action.prepStatus) ?? "untouched",
        ...(projectId ? { projectId: projectId as ProjectId } : {}),
      });
    } else if (action.type === "update_prompt") {
      const id = action.id.trim();
      if (!id) continue;
      const projectId =
        action.projectId === null
          ? null
          : action.projectId?.trim()
            ? (action.projectId.trim() as ProjectId)
            : undefined;
      const prepStatus = normalizePrep(action.prepStatus);
      actions.push({
        type: "update_prompt",
        id,
        ...(action.title?.trim() ? { title: action.title.trim() } : {}),
        ...(action.body !== undefined ? { body: action.body } : {}),
        ...(prepStatus ? { prepStatus } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    } else if (action.type === "move") {
      const id = action.id.trim();
      const at = normalizeTarget(action.at);
      if (id && at) actions.push({ type: "move", id, at });
    } else if (action.type === "delete" || action.type === "launch_active") {
      const id = action.id.trim();
      if (id) actions.push({ type: action.type, id });
    }
  }

  const creates = actions.filter((action) => action.type === "create_prompt").length;
  const fallback =
    actions.length === 0
      ? "No board changes."
      : creates > 0
        ? `Captured ${creates} prompt${creates === 1 ? "" : "s"} for Hermes.`
        : `Applied ${actions.length} explicit board action${actions.length === 1 ? "" : "s"}.`;
  return { reply: decodedPlan.value.reply?.trim() || fallback, actions };
}

export interface BoardControlDeps {
  readonly store: KanbanStore["Service"];
  /**
   * Retained as optional compatibility fields while callers migrate. Board
   * Control no longer invokes a second text-generation planner.
   */
  readonly textGeneration?: TextGeneration["Service"];
  readonly serverSettings?: ServerSettingsService["Service"];
  readonly defaultCwd?: string;
}

function boardControlError(detail: string, cause?: unknown): TextGenerationError {
  return new TextGenerationError({
    operation: "assistPrompt",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** One user message → one untouched Prompt → the shared Hermes routing path. */
export function runBoardControlTurn(
  deps: BoardControlDeps,
  input: KanbanBoardControlInput,
): Effect.Effect<KanbanBoardControlResult, TextGenerationError> {
  return Effect.gen(function* () {
    const message = input.message.trim();
    if (message.length === 0) {
      return yield* Effect.fail(boardControlError("A board request cannot be empty."));
    }

    const firstLine = message.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
    const created = yield* deps.store
      .create({
        title: (firstLine || "Board request").slice(0, 120),
        body: message,
        at: "prompts",
        prepStatus: "untouched",
      })
      .pipe(
        Effect.mapError((cause) =>
          boardControlError(
            cause instanceof Error ? cause.message : "Failed to capture board request.",
            cause,
          ),
        ),
      );

    requestHermesWake(`board control captured ${String(created.id)}`);

    const fresh = yield* deps.store
      .list()
      .pipe(
        Effect.mapError((cause) =>
          boardControlError(
            cause instanceof Error ? cause.message : "Failed to re-list board.",
            cause,
          ),
        ),
      );

    return {
      reply: "Captured for Hermes to understand, route, and launch.",
      applied: [
        {
          type: "create_prompt",
          summary: `Captured prompt: ${created.title}`,
          ok: true,
        },
      ],
      cards: fresh.cards,
    } satisfies KanbanBoardControlResult;
  });
}
