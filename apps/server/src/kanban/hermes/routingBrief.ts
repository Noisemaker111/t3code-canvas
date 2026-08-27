/**
 * The semantic abstraction Hermes sees for one Prompt card.
 *
 * It is deliberately capped: the original prompt once, at most eight routes,
 * three related thread summaries, and project identities without checkout
 * contents. Skills can use searchProjects/threadTranscript only when ambiguity
 * actually requires a drill-down.
 */
import type {
  HermesRoutingBrief,
  HermesRouteOption,
  KanbanCard,
  ModelSelection,
} from "@t3tools/contracts";

import type { BoardProject } from "./boardApi.ts";
import { keywordMatchEvidence, rankProjectsByPromptKeywords } from "./projectKeywordMatch.ts";
import { projectSlug, projectSlugs } from "./projectRouting.ts";

const MAX_ROUTES = 8;
const MAX_THREADS = 3;

export type RoutingModelFacts = {
  readonly routeId: string;
  readonly selection: ModelSelection;
  readonly usable: boolean;
  readonly note: string;
  readonly options: string;
  readonly optionChoices: HermesRouteOption["optionChoices"];
  readonly capability: HermesRouteOption["capability"];
  readonly speed: HermesRouteOption["speed"];
  readonly capacity: HermesRouteOption["capacity"];
  readonly usage: HermesRouteOption["usage"];
  readonly meteredPrice: HermesRouteOption["meteredPrice"];
  readonly taskCost: HermesRouteOption["taskCost"];
};

export type RoutingThreadFacts = {
  readonly cardId: string;
  readonly threadId: string;
  readonly title: string;
  readonly summary: string;
  readonly projectId: string | null;
  readonly contextUsedPercent: number | null;
  readonly compatibleRouteIds: ReadonlyArray<string>;
};

type ProjectStreakCard = Pick<
  KanbanCard,
  | "id"
  | "projectId"
  | "at"
  | "threadId"
  | "archivedAt"
  | "createdAt"
  | "updatedAt"
  | "projectRouteProvenance"
>;

const STREAK_CARD_LIMIT = 6;

function projectStreakEvidence(input: {
  readonly card: KanbanCard;
  readonly cards: ReadonlyArray<ProjectStreakCard>;
  readonly projectId: string;
}): ReadonlyArray<string> {
  const cards = input.cards
    .filter(
      (card) =>
        card.id !== input.card.id && card.archivedAt === null && card.projectId === input.projectId,
    )
    .toSorted((left, right) => {
      const leftAt = Date.parse(String(left.updatedAt ?? left.createdAt));
      const rightAt = Date.parse(String(right.updatedAt ?? right.createdAt));
      return rightAt - leftAt;
    })
    .slice(0, STREAK_CARD_LIMIT);
  const activeThreads = cards.filter((card) => card.at === "active" && card.threadId).length;
  const humanRoutes = cards.filter(
    (card) => card.projectRouteProvenance?.source === "human" && card.at !== "prompts",
  ).length;
  const signals = [
    cards.length >= 2 ? `${cards.length} recent same-project cards` : null,
    activeThreads > 0
      ? `${activeThreads} active same-project thread${activeThreads === 1 ? "" : "s"}`
      : null,
    humanRoutes > 0 ? "a last successful human-routed card" : null,
  ].filter((signal): signal is string => signal !== null);
  // One old Hermes-routed card is not intent. Require two independent board
  // signals, with the human route counting as one.
  return signals.length >= 2 ? signals : [];
}

export function buildRoutingBrief(input: {
  readonly card: KanbanCard;
  readonly projects: ReadonlyArray<BoardProject>;
  readonly models: ReadonlyArray<RoutingModelFacts>;
  readonly threads: ReadonlyArray<RoutingThreadFacts>;
  readonly cards?: ReadonlyArray<ProjectStreakCard>;
  readonly naturalLanguageRules?: ReadonlyArray<string>;
  readonly rosterEnforced?: boolean;
  readonly maxTaskUsagePercent?: number | null;
}): HermesRoutingBrief {
  const slugs = projectSlugs(input.projects);
  const keywordHits = rankProjectsByPromptKeywords({
    title: input.card.title,
    body: input.card.body,
    projects: input.projects.map((project) => ({
      id: project.id,
      name: project.name,
      slug: slugs.get(project.id) ?? projectSlug(project),
      workspaceRoot: project.workspaceRoot,
      repo: project.repo ?? null,
    })),
  });
  const hitById = new Map(keywordHits.map((hit) => [hit.projectId, hit]));
  const humanPinnedSelection =
    input.card.modelSelection &&
    (input.card.modelRouteProvenance?.source === "human" ||
      input.card.modelRouteProvenance === null)
      ? input.card.modelSelection
      : null;
  const isPinnedModel = (model: RoutingModelFacts) =>
    humanPinnedSelection !== null &&
    String(model.selection.instanceId) === String(humanPinnedSelection.instanceId) &&
    model.selection.model === humanPinnedSelection.model;
  const routes = [...input.models]
    .toSorted(
      (left, right) =>
        Number(isPinnedModel(right)) - Number(isPinnedModel(left)) ||
        Number(right.usable) - Number(left.usable),
    )
    .slice(0, MAX_ROUTES)
    .map(
      (model): HermesRouteOption => ({
        routeId: model.routeId,
        selection: isPinnedModel(model) ? humanPinnedSelection! : model.selection,
        available: model.usable,
        ownerRule: model.note,
        optionsSummary: isPinnedModel(model)
          ? (humanPinnedSelection?.options ?? [])
              .map((option) => `${option.id}=${String(option.value)}`)
              .join(" ")
          : model.options,
        optionChoices: isPinnedModel(model) ? [] : model.optionChoices,
        capability: model.capability,
        speed: model.speed,
        capacity: model.capacity,
        usage: model.usage,
        meteredPrice: model.meteredPrice,
        taskCost: model.taskCost,
      }),
    );
  const routeIds = new Set(routes.map((route) => route.routeId));
  // Reuse is offered only when the source card already owns the thread. The
  // runtime can safely resume that session; sharing an unrelated card's thread
  // would violate one-card/one-workspace ownership.
  const threads = input.threads
    .filter((thread) => thread.cardId === (input.card.id as string))
    .slice(0, MAX_THREADS)
    .map((thread) => ({
      threadId: thread.threadId,
      cardId: thread.cardId,
      title: thread.title,
      summary: thread.summary,
      contextUsedPercent: thread.contextUsedPercent,
      compatibleRouteIds: thread.compatibleRouteIds.filter((routeId) => routeIds.has(routeId)),
    }));

  const pinnedRoute = humanPinnedSelection
    ? (routes.find(
        (route) =>
          String(route.selection.instanceId) === String(humanPinnedSelection.instanceId) &&
          route.selection.model === humanPinnedSelection.model,
      )?.routeId ?? `${String(humanPinnedSelection.instanceId)}/${humanPinnedSelection.model}`)
    : null;

  return {
    cardId: input.card.id as string,
    prompt: input.card.body.trim() || input.card.title,
    attachments: (input.card.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
    })),
    projects: input.projects.map((project) => {
      const streak =
        input.cards === undefined
          ? []
          : projectStreakEvidence({
              card: input.card,
              cards: input.cards,
              projectId: project.id,
            });
      const keyword = keywordMatchEvidence(hitById.get(project.id));
      return {
        id: project.id,
        slug: slugs.get(project.id) ?? projectSlug(project),
        name: project.name,
        repo: project.repo ?? null,
        evidence: [...streak, ...(keyword ? [keyword] : [])],
      };
    }),
    routes,
    threads,
    policy: {
      pinnedProjectId:
        input.card.projectRouteProvenance?.source === "human"
          ? (input.card.projectId as string | null)
          : null,
      pinnedRouteId: pinnedRoute,
      naturalLanguageRules: [...(input.naturalLanguageRules ?? [])],
      allowedRouteIds: routes.map((route) => route.routeId),
      rosterEnforced: input.rosterEnforced === true,
      preferSubscriptions: true,
      preserveScarceUsage: true,
      maxTaskUsagePercent: input.maxTaskUsagePercent ?? null,
    },
  };
}

export function formatRoutingBrief(brief: HermesRoutingBrief): string {
  return JSON.stringify(brief);
}
