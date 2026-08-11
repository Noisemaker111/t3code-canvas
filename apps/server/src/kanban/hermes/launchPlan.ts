/**
 * Validate one semantic LaunchPlan against the exact RoutingBrief Hermes saw,
 * then apply structure + launch as one guarded operation.
 */
import type {
  HermesLaunchPlan,
  HermesLaunchTask,
  HermesRouteOption,
  HermesRoutingBrief,
  KanbanCard,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import type { BoardApi } from "./boardApi.ts";

export class LaunchPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchPlanValidationError";
  }
}

function selectionAllowed(
  proposed: HermesLaunchTask["execution"]["selection"],
  route: HermesRouteOption,
): boolean {
  if (
    String(proposed.instanceId) !== String(route.selection.instanceId) ||
    proposed.model !== route.selection.model
  ) {
    return false;
  }
  const offered = proposed.options ?? [];
  const byId = new Map(offered.map((option) => [option.id, option.value]));
  if (byId.size !== offered.length) return false;

  const fixed = route.selection.options ?? [];
  for (const option of fixed) {
    if (byId.get(option.id) !== option.value) return false;
  }
  const choices = new Map(route.optionChoices.map((choice) => [choice.id, choice.values]));
  for (const choice of route.optionChoices) {
    const value = byId.get(choice.id);
    if (typeof value !== "string" || !choice.values.includes(value)) return false;
  }
  for (const option of offered) {
    if (fixed.some((entry) => entry.id === option.id)) continue;
    const values = choices.get(option.id);
    if (!values || typeof option.value !== "string" || !values.includes(option.value)) return false;
  }
  return true;
}

export function validateLaunchPlan(
  proposed: HermesLaunchPlan,
  brief: HermesRoutingBrief,
  now = DateTime.nowUnsafe(),
): HermesLaunchPlan {
  if (proposed.version !== 1) throw new LaunchPlanValidationError("unsupported plan version");
  if (proposed.sourceCardId !== brief.cardId) {
    throw new LaunchPlanValidationError("plan source does not match the routing brief");
  }
  if (proposed.status === "blocked") {
    if (!proposed.blockedReason?.trim()) {
      throw new LaunchPlanValidationError("a blocked plan needs a reason");
    }
    return { ...proposed, tasks: [] };
  }
  if (proposed.tasks.length === 0) throw new LaunchPlanValidationError("a ready plan has no tasks");
  if (proposed.tasks.length > 8)
    throw new LaunchPlanValidationError("a plan may launch at most 8 tasks");

  const projects = new Set(brief.projects.map((project) => project.id));
  const routes = new Map(brief.routes.map((route) => [route.routeId, route]));
  const threads = new Map(brief.threads.map((thread) => [thread.threadId, thread]));
  const allowed = new Set(brief.policy.allowedRouteIds);
  const canonical: HermesLaunchTask[] = [];

  for (const [index, task] of proposed.tasks.entries()) {
    if (!task.title.trim() || !task.brief.trim() || !task.reason.trim()) {
      throw new LaunchPlanValidationError(
        `task ${index + 1} needs a title, brief and route reason`,
      );
    }
    const [minTurns, maxTurns] = task.expectedWork.expectedTurns;
    if (
      !Number.isInteger(minTurns) ||
      !Number.isInteger(maxTurns) ||
      minTurns < 1 ||
      maxTurns < minTurns ||
      maxTurns > 100
    ) {
      throw new LaunchPlanValidationError(`task ${index + 1} has an invalid expected-turn range`);
    }
    if (task.sourceCardId !== brief.cardId) {
      throw new LaunchPlanValidationError(`task ${index + 1} names a different source card`);
    }
    if (!projects.has(task.projectId)) {
      throw new LaunchPlanValidationError(`task ${index + 1} names an unknown project`);
    }
    if (brief.policy.pinnedProjectId !== null && task.projectId !== brief.policy.pinnedProjectId) {
      throw new LaunchPlanValidationError("plan changed the human-pinned project");
    }
    const route = routes.get(task.execution.routeId);
    if (!route) throw new LaunchPlanValidationError(`task ${index + 1} names an unknown route`);
    if (!route.available) {
      throw new LaunchPlanValidationError(`route '${route.routeId}' is unavailable`);
    }
    if (brief.policy.pinnedRouteId !== null && route.routeId !== brief.policy.pinnedRouteId) {
      throw new LaunchPlanValidationError("plan changed the human-pinned route");
    }
    if (brief.policy.rosterEnforced && !allowed.has(route.routeId)) {
      throw new LaunchPlanValidationError(
        `route '${route.routeId}' is outside the enforced roster`,
      );
    }
    if (!selectionAllowed(task.execution.selection, route)) {
      throw new LaunchPlanValidationError(
        `task ${index + 1} changed the route's validated model/options`,
      );
    }
    const max = brief.policy.maxTaskUsagePercent;
    const high = route.usage.highPercent;
    if (max !== null && (high === null || high > max)) {
      throw new LaunchPlanValidationError(
        high === null
          ? `route '${route.routeId}' has unknown usage and cannot satisfy the hard usage cap`
          : `route '${route.routeId}' may use ${high}% (cap ${max}%)`,
      );
    }
    if (task.placement.kind === "reuse") {
      const thread = threads.get(task.placement.threadId);
      if (!thread) {
        throw new LaunchPlanValidationError(
          `reuse thread '${task.placement.threadId}' is not relevant`,
        );
      }
      if (!thread.compatibleRouteIds.includes(route.routeId)) {
        throw new LaunchPlanValidationError(
          `reuse thread '${task.placement.threadId}' is incompatible with '${route.routeId}'`,
        );
      }
      if (index > 0) {
        throw new LaunchPlanValidationError(
          "split tasks cannot reuse an unrelated source-card thread",
        );
      }
    }
    canonical.push({
      ...task,
      execution: {
        routeId: route.routeId,
        selection: task.execution.selection,
        usage: route.usage,
      },
      provenance: {
        source: "hermes",
        skill: "select-execution",
        at: DateTime.formatIso(now),
      },
    });
  }
  return { ...proposed, blockedReason: null, tasks: canonical };
}

export type AppliedLaunchPlan = {
  readonly plan: HermesLaunchPlan;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly threadIds: ReadonlyArray<string>;
};

/**
 * All semantic validation completes before the first write. If a later launch
 * fails, cards are compensated back to their original state (new split cards
 * are archived). Provider/thread creation has its own idempotent command ids,
 * so retries do not duplicate successful work.
 */
export async function applyValidatedLaunchPlan(
  api: BoardApi,
  plan: HermesLaunchPlan,
): Promise<AppliedLaunchPlan> {
  if (plan.status !== "ready") {
    throw new LaunchPlanValidationError(plan.blockedReason ?? "launch plan is blocked");
  }
  const before = await api.list();
  const source = before.find((card) => card.id === plan.sourceCardId);
  if (!source) throw new LaunchPlanValidationError("source card is gone");
  if (source.at !== "prompts") {
    throw new LaunchPlanValidationError(`source card is in ${source.at}, not Prompts`);
  }

  const touched: KanbanCard[] = [];
  const created: KanbanCard[] = [];
  const threadIds: string[] = [];
  try {
    for (const [index, task] of plan.tasks.entries()) {
      const card =
        index === 0
          ? await api.updateCard({
              id: source.id,
              title: task.title,
              body: task.brief,
              projectId: task.projectId,
              projectRouteProvenance: task.provenance,
              modelSelection: task.execution.selection,
              modelRouteReason: [
                task.reason.trim(),
                ...task.alternativesConsidered.map(
                  (alternative) => `Why not: ${alternative.trim()}`,
                ),
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
              modelRouteProvenance: task.provenance,
              modelRouteUsage: task.execution.usage,
              prepStatus: "ready",
            })
          : await api.createCard({
              title: task.title,
              body: task.brief,
              at: "prompts",
              prepStatus: "ready",
              projectId: task.projectId,
              projectRouteProvenance: task.provenance,
              modelSelection: task.execution.selection,
              modelRouteReason: [
                task.reason.trim(),
                ...task.alternativesConsidered.map(
                  (alternative) => `Why not: ${alternative.trim()}`,
                ),
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
              modelRouteProvenance: task.provenance,
              modelRouteUsage: task.execution.usage,
            });
      touched.push(card);
      if (index > 0) created.push(card);
      const launched = await api.launchActive({
        id: card.id,
        projectId: task.projectId,
        modelSelection: task.execution.selection,
        forceFreshThread: task.placement.kind === "new",
      });
      threadIds.push(launched.threadId);
    }
    return { plan, cards: touched, threadIds };
  } catch (cause) {
    for (const threadId of threadIds) {
      await api.archiveThread({ threadId }).catch(() => undefined);
    }
    for (const card of created) {
      await api.archiveCard({ id: card.id }).catch(() => undefined);
    }
    await api
      .updateCard({
        id: source.id,
        title: source.title,
        body: source.body,
        at: source.at,
        threadId: source.threadId,
        projectId: source.projectId,
        projectRouteProvenance: source.projectRouteProvenance,
        prepStatus: source.prepStatus,
        modelSelection: source.modelSelection,
        modelRouteReason: source.modelRouteReason,
        modelRouteProvenance: source.modelRouteProvenance,
        modelRouteUsage: source.modelRouteUsage,
      })
      .catch(() => undefined);
    throw cause;
  }
}
