/**
 * The real `BoardApi` — the same primitives the kanban MCP toolkit exposes,
 * plus the loop-closing calls Hermes needs that no tool had: read an agent's
 * closing report, nudge it, and answer a blocked permission prompt.
 *
 * @module kanban/hermes/liveBoardApi
 */
import type {
  KanbanCard,
  KanbanCardId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import type * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ProviderService from "../../provider/Services/ProviderService.ts";
import type * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { EFFORT_ORDER } from "@t3tools/shared/model";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import { getUsageService } from "../../usage/UsageService.ts";
import type { CanvasStore } from "../../canvas/CanvasStore.ts";
import type { KanbanStore } from "../KanbanStore.ts";
import type { LaunchActiveDeps } from "../LaunchActive.ts";
import { buildLaunchMedia, runLaunchActive } from "../LaunchActive.ts";
import { runLaunchHelper } from "../LaunchHelper.ts";
import {
  buildRosterIndex,
  candidatesFromShellProviders,
  formatRosterOptions,
  measuredCostKey,
  providerFamilyUsable,
  tierFor,
} from "../ModelRouting.ts";
import { cachedMeasuredCostTiers } from "../budget/BudgetService.ts";
import { readBudgetStore } from "../budget/budgetStore.ts";
import { capabilityForModel, getModelCapabilityCatalog } from "../ModelCapabilityCatalog.ts";
import { getModelPriceCatalog } from "../ModelPriceCatalog.ts";
import { isSubscriptionHarness, priceForHarness } from "../budget/pricing.ts";
import { taskCostFrom } from "../budget/measurements.ts";
import { relativeTo } from "../modelEvidence.ts";
import {
  runClosePr,
  runMergePr,
  runOpenPr,
  runPrChecks,
  runRestorePrWorktree,
  runSyncPrBranch,
} from "../PrPipeline.ts";
import type {
  BoardApi,
  BoardPendingInput,
  BoardProject,
  BoardThreadReport,
  BoardThreadTranscript,
} from "./boardApi.ts";
import { formatHelperTranscript, HELPER_TRANSCRIPT_LIMIT } from "./helpers.ts";
import {
  capacityPoolForRoute,
  routeCapability,
  routeSpeed,
  taskUsageEstimate,
} from "./routeFacts.ts";
import { routingUsageSamples } from "./routingUsageStore.ts";
import { listOpenIssues as listOpenIssuesFor } from "./openIssueList.ts";
import { boardProjectsOf, listOpenPrs as listOpenPrsFor } from "./openPrList.ts";
import { derivePendingInputsForThread } from "./pendingInputs.ts";
import {
  dropNestedWorkspaceAncestors,
  projectSlug,
  projectSlugs,
  resolveProjectId,
  unknownProjectMessage,
} from "./projectRouting.ts";

export type LiveBoardApiDeps = LaunchActiveDeps & {
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly providerService: Pick<ProviderService.ProviderService["Service"], "respondToUserInput">;
};

type Deps = LiveBoardApiDeps & {
  readonly store: KanbanStore["Service"];
  readonly canvas: CanvasStore["Service"];
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly projection: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly serverSettings: ServerSettingsService["Service"];
  readonly workspaceEntries: WorkspaceEntries.WorkspaceEntries["Service"];
};

/**
 * Board calls surface as plain rejections; the recorder turns them into
 * transcript rows.
 *
 * A tagged error whose `detail` getter is absent used to stringify to the
 * literal `"undefined"`, which is what Hermes then read as the reason a card
 * failed — and what it repeated back to the user. Every branch here has to end
 * in text that names something.
 */
/** A nudge that would drop the card's media rather than carry it. Refused, never silently sent. */
export class NudgeMediaError extends Data.TaggedError("NudgeMediaError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.mapError((cause) => new Error(describeCause(cause)))) as Effect.Effect<
      A,
      Error
    >,
  );

const firstText = (...values: ReadonlyArray<unknown>): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
};

function describeCause(cause: unknown): string {
  if (cause !== null && typeof cause === "object") {
    const bag = cause as { detail?: unknown; message?: unknown; _tag?: unknown };
    const text = firstText(bag.detail, bag.message);
    if (text) return text;
    const tag = firstText(bag._tag);
    if (tag) return `${tag} (no detail)`;
  }
  return firstText(cause) ?? `${typeof cause} error with no message`;
}

const DEFAULT_PROJECT_SEARCH_LIMIT = 5;

const prDeps = (deps: Deps) => ({
  store: deps.store,
  projection: deps.projection,
  gitWorkflow: deps.gitWorkflow,
  sourceControl: deps.sourceControl,
  crypto: deps.crypto,
  preflight: deps.preflight ?? null,
  git: deps.git,
});

export function makeLiveBoardApi(deps: Deps): BoardApi {
  const listCards = (): Promise<ReadonlyArray<KanbanCard>> =>
    run(deps.store.list().pipe(Effect.map((listed) => listed.cards)));

  const threadDetail = (threadId: string) =>
    deps.projection.getThreadDetailById(threadId as ThreadId);

  const boardProjects = (): Promise<ReadonlyArray<BoardProject>> =>
    run(
      deps.projection
        .getShellSnapshot()
        .pipe(Effect.map((snapshot) => boardProjectsOf(snapshot.projects))),
    );

  // A card is routed by a slug or an id a program wrote; an id nothing on the
  // board answers to is a wrong launch, so it fails here instead of silently.
  const resolveProject = async (value: string | null | undefined): Promise<string | null> => {
    if (value === undefined || value === null || String(value).trim().length === 0) return null;
    const projects = await boardProjects();
    const resolved = resolveProjectId(projects, String(value));
    if (resolved === null) throw new Error(unknownProjectMessage(projects, String(value)));
    return resolved;
  };

  return {
    list: listCards,

    updateCard: async (input) =>
      run(
        deps.store.update({
          id: input.id as KanbanCardId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.at === undefined ? {} : { at: input.at }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.projectId === undefined
            ? {}
            : { projectId: ((await resolveProject(input.projectId)) as ProjectId | null) ?? null }),
          ...(input.projectRouteProvenance === undefined
            ? {}
            : { projectRouteProvenance: input.projectRouteProvenance }),
          ...(input.prepStatus === undefined ? {} : { prepStatus: input.prepStatus }),
          ...(input.modelSelection === undefined
            ? {}
            : { modelSelection: input.modelSelection as ModelSelection | null }),
          ...(input.modelRouteReason === undefined
            ? {}
            : { modelRouteReason: input.modelRouteReason }),
          ...(input.modelRouteProvenance === undefined
            ? {}
            : { modelRouteProvenance: input.modelRouteProvenance }),
          ...(input.modelRouteUsage === undefined
            ? {}
            : { modelRouteUsage: input.modelRouteUsage }),
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
          ...(input.prTitle === undefined ? {} : { prTitle: input.prTitle }),
          ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
          ...(input.movedBy === undefined ? {} : { movedBy: input.movedBy }),
        }),
      ),

    createCard: async (input) =>
      run(
        deps.store.create({
          title: input.title,
          body: input.body,
          at: input.at ?? "prompts",
          ...(input.prepStatus === undefined ? {} : { prepStatus: input.prepStatus }),
          ...(input.projectId
            ? { projectId: (await resolveProject(input.projectId)) as ProjectId }
            : {}),
          ...(input.projectRouteProvenance
            ? { projectRouteProvenance: input.projectRouteProvenance }
            : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.modelRouteReason ? { modelRouteReason: input.modelRouteReason } : {}),
          ...(input.modelRouteProvenance
            ? { modelRouteProvenance: input.modelRouteProvenance }
            : {}),
          ...(input.modelRouteUsage ? { modelRouteUsage: input.modelRouteUsage } : {}),
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        }),
      ),

    launchActive: async (input) => {
      const cards = await listCards();
      const card = cards.find((entry) => entry.id === input.id);
      const projectId =
        (await resolveProject(input.projectId ?? (card?.projectId as string | null))) ?? null;
      if (!projectId) throw new Error(`Card '${input.id}' has no project to launch into.`);
      const result = await run(
        runLaunchActive(deps, {
          id: input.id as KanbanCardId,
          projectId: projectId as ProjectId,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.forceFreshThread === undefined
            ? {}
            : { forceFreshThread: input.forceFreshThread }),
        }),
      );
      return { threadId: String(result.threadId) };
    },

    openPr: async (input) => {
      const result = await run(runOpenPr(prDeps(deps), { id: input.id as KanbanCardId }));
      return { prUrl: result.prUrl };
    },

    mergePr: async (input) => {
      try {
        await run(runMergePr(prDeps(deps), { id: input.id as KanbanCardId }));
        return { merged: true, reason: null };
      } catch (cause) {
        // A refused merge is data Hermes acts on, not a program crash.
        return { merged: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    closePr: async (input) => {
      try {
        await run(
          runClosePr(prDeps(deps), {
            id: input.id as KanbanCardId,
            ...(input.reference === undefined ? {} : { reference: input.reference }),
          }),
        );
        return { closed: true, reason: null };
      } catch (cause) {
        // A refused close is data Hermes acts on, not a program crash.
        return { closed: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    prChecks: async (input) => run(runPrChecks(prDeps(deps), { id: input.id as KanbanCardId })),

    restorePrWorktree: async (input) =>
      run(
        runRestorePrWorktree({ ...prDeps(deps), git: deps.git }, { id: input.id as KanbanCardId }),
      ),

    syncPrBranch: async (input) =>
      run(runSyncPrBranch({ ...prDeps(deps), git: deps.git }, { id: input.id as KanbanCardId })),

    nudgeThread: async (input) =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const messageUuid = yield* deps.crypto.randomUUIDv4;
          const commandUuid = yield* deps.crypto.randomUUIDv4;
          const detail = yield* threadDetail(input.threadId);
          if (Option.isNone(detail)) {
            return yield* Effect.fail(new Error(`Thread '${input.threadId}' no longer exists.`));
          }
          const cards = yield* Effect.promise(() => listCards());
          const card = cards.find((candidate) => String(candidate.threadId) === input.threadId);
          if (!card) {
            return yield* Effect.fail(
              new NudgeMediaError({
                reason: `No kanban card owns thread '${input.threadId}'; refusing to forward media.`,
              }),
            );
          }
          const serverConfig = yield* Effect.serviceOption(ServerConfig);
          const media = buildLaunchMedia({
            card,
            threadId: input.threadId,
            attachmentsDir: Option.isSome(serverConfig) ? serverConfig.value.attachmentsDir : null,
            worktreePath: detail.value.worktreePath,
          });
          if (media.error !== null) {
            return yield* Effect.fail(
              new NudgeMediaError({
                reason: `Refusing Hermes nudge for '${card.title}': ${media.error}.`,
              }),
            );
          }
          yield* deps.orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`kanban:hermes-nudge:${commandUuid}`),
            threadId: input.threadId as ThreadId,
            message: {
              messageId: MessageId.make(messageUuid),
              role: "user",
              text: `${input.text}${media.textSuffix}`,
              attachments: media.imageAttachments,
            },
            modelSelection: detail.value.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: DateTime.formatIso(now),
          });
        }),
      ),

    launchHelper: async (input) => {
      // The transcript is fetched here and handed to the helper's prompt. That
      // is the whole economics of a helper: the runtime moves the bytes, so the
      // loop's own context never carries the thread it is asking about.
      let transcript: string | null = null;
      if (input.aboutThreadId) {
        const tail = await run(
          threadDetail(input.aboutThreadId).pipe(Effect.map((detail) => detail)),
        ).catch(() => null);
        if (tail && Option.isSome(tail)) {
          transcript = formatHelperTranscript(
            tail.value.messages
              .filter((message) => message.text.trim().length > 0)
              .slice(-HELPER_TRANSCRIPT_LIMIT)
              .map((message) => ({ role: message.role, text: message.text })),
          );
        }
      }
      const result = await run(
        runLaunchHelper(deps, {
          question: input.question,
          projectId: input.projectId,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          transcript,
        }),
      );
      return { threadId: result.threadId };
    },

    archiveThread: async (input) =>
      run(
        Effect.gen(function* () {
          const commandUuid = yield* deps.crypto.randomUUIDv4;
          yield* deps.orchestrationEngine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`kanban:hermes-helper-archive:${commandUuid}`),
            threadId: input.threadId as ThreadId,
          });
        }),
      ),

    threadReport: async (input): Promise<BoardThreadReport | null> =>
      run(
        threadDetail(input.threadId).pipe(
          Effect.map((detail) => {
            if (Option.isNone(detail)) return null;
            const thread = detail.value;
            if (thread.latestTurn?.state === "running") return null;
            const last = [...thread.messages]
              .reverse()
              .find((message) => message.role === "assistant" && message.text.trim().length > 0);
            if (!last) return null;
            return {
              threadId: input.threadId,
              text: last.text,
              finishedAt: thread.latestTurn?.completedAt ?? null,
            } satisfies BoardThreadReport;
          }),
        ),
      ),

    threadTranscript: async (input): Promise<BoardThreadTranscript | null> =>
      run(
        threadDetail(input.threadId).pipe(
          Effect.map((detail) => {
            if (Option.isNone(detail)) {
              return {
                threadId: input.threadId,
                title: "",
                exists: false,
                archived: false,
                turnState: "none",
                lastActivityAt: null,
                idleForMs: null,
                messageCount: 0,
                entries: [],
              } satisfies BoardThreadTranscript;
            }
            const thread = detail.value;
            const limit = Math.min(40, Math.max(1, input.limit ?? 12));
            const messages = thread.messages
              .filter((message) => message.text.trim().length > 0)
              .map((message) => ({
                at: String(message.createdAt),
                role: message.role,
                text: message.text,
              }));
            // Errors and approvals explain a stall that the messages do not.
            const notable = thread.activities
              .filter((activity) => activity.tone === "error" || activity.tone === "approval")
              .map((activity) => ({
                at: String(activity.createdAt),
                role: `${activity.tone}:${activity.kind}`,
                text: activity.summary,
              }));
            const entries = [...messages, ...notable]
              .sort((a, b) => a.at.localeCompare(b.at))
              .slice(-limit)
              .map((entry) => ({
                ...entry,
                text: entry.text.length > 2000 ? `${entry.text.slice(0, 2000)}…` : entry.text,
              }));
            const lastActivityAt =
              entries.length > 0
                ? (entries[entries.length - 1]?.at ?? null)
                : String(thread.updatedAt);
            const parsed = lastActivityAt === null ? NaN : Date.parse(lastActivityAt);
            return {
              threadId: input.threadId,
              title: thread.title,
              exists: true,
              archived: thread.archivedAt !== null,
              turnState: thread.latestTurn?.state ?? "none",
              lastActivityAt,
              idleForMs: Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null,
              messageCount: messages.length,
              entries,
            } satisfies BoardThreadTranscript;
          }),
        ),
      ),

    archiveCard: async (input) =>
      run(
        deps.store.update({
          id: input.id as KanbanCardId,
          archived: input.archived ?? true,
        }),
      ),

    pendingInputs: async (): Promise<ReadonlyArray<BoardPendingInput>> => {
      const cards = await listCards();
      const threadIds = cards
        .filter((card) => card.at === "active" && card.threadId)
        .map((card) => String(card.threadId));
      const perThread = await Promise.all(
        threadIds.map((threadId) =>
          run(
            threadDetail(threadId).pipe(
              Effect.map((detail) =>
                Option.isNone(detail)
                  ? []
                  : derivePendingInputsForThread({
                      threadId,
                      activities: detail.value.activities,
                    }),
              ),
            ),
          ).catch(() => [] as ReadonlyArray<BoardPendingInput>),
        ),
      );
      return perThread.flat();
    },

    answerPermission: async (input) =>
      run(
        deps.providerService.respondToUserInput({
          threadId: input.threadId as ThreadId,
          requestId: ApprovalRequestId.make(input.requestId),
          answers: { [input.requestId]: [input.answer] },
        }) as Effect.Effect<void, unknown>,
      ),

    listModels: async () => {
      const [providers, usage, board, capabilities, prices] = await Promise.all([
        run(deps.listProviders),
        getUsageService().getUsageSafe(),
        run(
          deps.serverSettings.getSettings.pipe(
            Effect.map((settings) => settings.boardSettings),
            Effect.orElseSucceed(() => null),
          ),
        ),
        getModelCapabilityCatalog().catch(() => null),
        getModelPriceCatalog().catch(() => new Map()),
      ]);
      const rosterIndex = buildRosterIndex(board?.modelRoster ?? []);
      const measured = cachedMeasuredCostTiers();
      const all = candidatesFromShellProviders(providers);
      const rostered = all.filter((candidate) =>
        rosterIndex.has(measuredCostKey(candidate.instanceId, candidate.model)),
      );
      // The brain only sees what it is allowed to spend on.
      const visible = board?.modelRosterEnforced === true ? rostered : all;
      const seatOf = (candidate: { instanceId: string; model: string }) =>
        rosterIndex.get(measuredCostKey(candidate.instanceId, candidate.model));
      const effortChoices = (candidate: { instanceId: string; model: string }) => {
        const seat = seatOf(candidate);
        const range = seat?.effortRange;
        if (!range || seat?.options.some((option) => option.id === "effort")) return [];
        const min = EFFORT_ORDER.indexOf(range.min as (typeof EFFORT_ORDER)[number]);
        const max = EFFORT_ORDER.indexOf(range.max as (typeof EFFORT_ORDER)[number]);
        if (min < 0 || max < min) return [];
        return [{ id: "effort", values: EFFORT_ORDER.slice(min, max + 1) }];
      };
      const samples = readBudgetStore().samples;
      const learnedUsage = routingUsageSamples();
      const costs = new Map(
        visible.map((candidate) => [
          `${String(candidate.instanceId)}/${candidate.model}`,
          taskCostFrom({
            samples,
            harness: String(candidate.instanceId),
            model: candidate.model,
            price: priceForHarness({
              instanceId: String(candidate.instanceId),
              model: candidate.model,
              byId: prices,
            }),
            subscription: isSubscriptionHarness(String(candidate.instanceId)),
          }),
        ]),
      );
      const priced = [...costs.values()].map((cost) => ({ usdPerTask: cost.usdPerTask }));
      return visible.map((candidate) => {
        const instanceId = String(candidate.instanceId);
        const routeId = `${instanceId}/${candidate.model}`;
        return {
          routeId,
          selection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model: candidate.model,
            options: seatOf(candidate)?.options ?? [],
          },
          instanceId,
          model: candidate.model,
          costTier: tierFor(candidate, measured).tier,
          usable:
            candidate.enabled !== false &&
            candidate.installed !== false &&
            candidate.authOk !== false &&
            providerFamilyUsable(usage, instanceId).ok,
          note: seatOf(candidate)?.note ?? "",
          options: formatRosterOptions(seatOf(candidate)?.options),
          optionChoices: effortChoices(candidate),
          capability: routeCapability(capabilityForModel(capabilities, candidate.model)),
          speed: routeSpeed(samples, instanceId, candidate.model),
          capacity: capacityPoolForRoute(instanceId, usage),
          usage: taskUsageEstimate(routeId, learnedUsage),
          taskCost: (() => {
            const cost =
              costs.get(routeId) ??
              taskCostFrom({
                samples,
                harness: instanceId,
                model: candidate.model,
                price: priceForHarness({ instanceId, model: candidate.model, byId: prices }),
                subscription: isSubscriptionHarness(instanceId),
              });
            return {
              relative: relativeTo(priced, cost.usdPerTask),
              usdPerTask: cost.usdPerTask,
              msPerTask: cost.msPerTask,
              basis: cost.basis,
              taskCount: cost.taskCount,
              detail: cost.detail,
            };
          })(),
          meteredPrice: isSubscriptionHarness(instanceId)
            ? null
            : (() => {
                const price = priceForHarness({
                  instanceId,
                  model: candidate.model,
                  byId: prices,
                });
                return {
                  inputUsdPerMTok: price.usdPerMTokIn,
                  outputUsdPerMTok: price.usdPerMTokOut,
                  source: price.source,
                };
              })(),
        };
      });
    },

    listProjects: boardProjects,

    // The whole of project routing: ask each checkout whether it has the path
    // the card is talking about. A card that names a file answers itself — and
    // when two checkouts answer, saying so is what stops the wrong launch.
    searchProjects: async (input) => {
      const query = input.query.trim();
      const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_PROJECT_SEARCH_LIMIT), 20);
      if (query.length === 0) return { query, ambiguous: false, projects: [] };
      const projects = await boardProjects();
      const slugs = projectSlugs(projects);
      const found = await Promise.all(
        projects.map(async (project) => {
          // A project whose search failed used to answer "no hits", which reads
          // exactly like a project that does not contain the file — and routes
          // the card to whichever checkout did answer. Refusing is the only
          // honest answer: the caller asked which project owns a path.
          const result = await run(
            deps.workspaceEntries
              .search({ cwd: project.workspaceRoot ?? "", query, limit })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new Error(
                      `searchProjects could not read ${project.name}` +
                        ` (${project.workspaceRoot ?? "no workspace root"}): ` +
                        `${cause instanceof Error ? cause.message : String(cause)}. ` +
                        "Routing on the projects that did answer would name the wrong one.",
                    ),
                ),
              ),
          );
          return {
            projectId: project.id,
            slug: slugs.get(project.id) ?? projectSlug(project),
            name: project.name,
            hits: result.entries.length,
            paths: result.entries.map((entry) => entry.path),
          };
        }),
      );
      const hits = dropNestedWorkspaceAncestors(
        found.filter((entry) => entry.hits > 0),
        projects,
      ).toSorted((left, right) => right.hits - left.hits);
      return { query, ambiguous: hits.length > 1, projects: hits };
    },

    // A forge that did not answer is not "no open pull requests": callers would
    // read the empty list as an answer, so this fails instead.
    listOpenPrs: async (input) =>
      run(
        listOpenPrsFor(
          { projects: Effect.promise(boardProjects), sourceControl: deps.sourceControl },
          input,
        ),
      ),

    listOpenIssues: async (input) =>
      run(
        listOpenIssuesFor(
          { projects: Effect.promise(boardProjects), sourceControl: deps.sourceControl },
          input,
        ),
      ),

    canvasDigest: async () => run(deps.canvas.digest()),

    // Comments without pixels: the image rides the prompt as its own part, and
    // a base64 screenshot in a board call transcript would be unreadable.
    canvasInbox: async (input) =>
      run(
        deps.canvas
          .listMessages({
            target: "hermes",
            undeliveredOnly: true,
            includeImages: input?.includeImages === true,
          })
          .pipe(Effect.map(({ messages }) => messages)),
      ),

    canvasAckMessages: async (input) =>
      run(deps.canvas.ackMessages({ ids: input.ids }).pipe(Effect.asVoid)),

    // Queued, not drawn: the browser owns the tldraw editor and materializes
    // this on its next poll. Hermes never authors tldraw records.
    canvasDraw: async (input) =>
      run(
        deps.canvas.enqueueInjection({ spec: input.spec }).pipe(Effect.map(({ id }) => ({ id }))),
      ),
  };
}
