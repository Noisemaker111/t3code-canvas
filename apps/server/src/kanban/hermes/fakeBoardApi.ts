/**
 * In-memory `BoardApi` for tests and the dry-run harness. No network, no CLI.
 *
 * @module kanban/hermes/fakeBoardApi
 */
import type { CanvasInjectionSpec, CanvasMessage, KanbanCard } from "@t3tools/contracts";
import { DEFAULT_CANVAS_DOC_ID, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type {
  BoardApi,
  BoardOpenIssue,
  BoardOpenPr,
  BoardPendingInput,
  BoardPrSyncConflict,
  BoardProject,
  BoardThreadReport,
  BoardThreadTranscript,
} from "./boardApi.ts";
import { selectPrProjects } from "./openPrList.ts";
import type { HermesBoardPolicy } from "./policy.ts";
import { dropNestedWorkspaceAncestors, projectSlug, projectSlugs } from "./projectRouting.ts";

export type FakeBoardState = {
  cards: KanbanCard[];
  pendingInputs: BoardPendingInput[];
  reports: Record<string, BoardThreadReport>;
  transcripts: Record<string, BoardThreadTranscript>;
  nudges: Array<{ threadId: string; text: string }>;
  /** Helper threads Hermes started this run. */
  helperLaunches: Array<{
    question: string;
    projectId: string;
    aboutThreadId?: string | null;
    threadId: string;
  }>;
  archivedThreads: Array<string>;
  answers: Array<{ threadId: string; requestId: string; answer: string }>;
  mergeFailures: Record<string, string>;
  /** Card id → the conflict `syncPrBranch` reports instead of syncing. */
  syncConflicts: Record<string, BoardPrSyncConflict>;
  /** Card id → why the launch could not start (no disk, no worktree, no repo). */
  launchFailures: Record<string, string>;
  /** Card id → why the forge refused to open its PR. */
  openPrFailures: Record<string, string>;
  /** Card id → why the forge refused to close its PR. */
  closePrFailures: Record<string, string>;
  prChecks: Record<
    string,
    {
      state: "passing" | "failing" | "pending" | "unknown";
      failing: Array<{ name: string; url: string | null }>;
      unknownReason?: "no_checks" | "unavailable" | null;
      openedAtMs?: number | null;
    }
  >;
  projects: BoardProject[];
  /** Paths each project contains, keyed by project id. Feeds `searchProjects`. */
  projectFiles: Record<string, ReadonlyArray<string>>;
  /** Open pull requests each project's repo has, keyed by project id. */
  openPrs: Record<string, ReadonlyArray<BoardOpenPr>>;
  /** Open issues each project's repo has, keyed by project id. */
  openIssues: Record<string, ReadonlyArray<BoardOpenIssue>>;
  policy: HermesBoardPolicy;
  /** Text on the canvas Hermes can read back. */
  canvasShapes: Array<{
    id: string;
    kind: string;
    text: string;
    x: number;
    y: number;
  }>;
  /** Drawings Hermes queued this run, newest last. */
  canvasDrawings: Array<CanvasInjectionSpec>;
  /** Picture messages waiting for Hermes. */
  canvasMessages: Array<CanvasMessage>;
  canvasAcked: Array<string>;
};

type FakeCardInput = { id: string } & Partial<Record<keyof KanbanCard, unknown>>;

/**
 * Timestamps reach the rule pass decoded, never as the ISO string the wire
 * carries. Fixtures that hand over strings hide every clock the rules read.
 */
const fakeInstant = (value: unknown): DateTime.Utc | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return DateTime.makeUnsafe(value);
  return value as DateTime.Utc;
};

const INSTANT_FIELDS = ["createdAt", "updatedAt", "columnEnteredAt", "archivedAt"] as const;

export function makeFakeCard(partial: FakeCardInput): KanbanCard {
  const card = {
    title: `card ${partial.id}`,
    body: "",
    at: "prompts",
    position: 0,
    threadId: null,
    prUrl: null,
    projectId: null,
    modelSelection: null,
    baseBranch: null,
    prepStatus: "untouched",
    attachments: [],
    hermesOperation: null,
    archivedAt: null,
    columnEnteredAt: null,
    timeline: { launchedAt: null, prOpenedAt: null, shippedAt: null },
    tokenUsage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as Record<string, unknown>;
  for (const field of INSTANT_FIELDS) card[field] = fakeInstant(card[field]);
  return card as unknown as KanbanCard;
}

export function makeFakeBoardApi(initial: Partial<FakeBoardState> = {}): {
  api: BoardApi;
  state: FakeBoardState;
} {
  const state: FakeBoardState = {
    cards: [...(initial.cards ?? [])],
    pendingInputs: [...(initial.pendingInputs ?? [])],
    reports: { ...(initial.reports ?? {}) },
    transcripts: { ...(initial.transcripts ?? {}) },
    nudges: [],
    helperLaunches: [],
    archivedThreads: [],
    answers: [],
    mergeFailures: { ...(initial.mergeFailures ?? {}) },
    syncConflicts: { ...(initial.syncConflicts ?? {}) },
    launchFailures: { ...(initial.launchFailures ?? {}) },
    openPrFailures: { ...(initial.openPrFailures ?? {}) },
    closePrFailures: { ...(initial.closePrFailures ?? {}) },
    prChecks: { ...(initial.prChecks ?? {}) },
    canvasShapes: [...(initial.canvasShapes ?? [])],
    canvasDrawings: [],
    canvasMessages: [...(initial.canvasMessages ?? [])],
    canvasAcked: [],
    projectFiles: { ...(initial.projectFiles ?? {}) },
    openPrs: { ...(initial.openPrs ?? {}) },
    openIssues: { ...(initial.openIssues ?? {}) },
    projects: initial.projects ?? [
      { id: "proj-1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: null },
    ],
    policy: initial.policy ?? {
      autoMoveDraftsToPrompts: true,
      structureDrafts: true,
      autoLaunch: true,
      stuckPrepMs: 120_000,
    },
  };

  const find = (id: string): KanbanCard => {
    const card = state.cards.find((entry) => entry.id === id);
    if (!card) throw new Error(`card ${id} not found`);
    return card;
  };

  const replace = (next: KanbanCard): KanbanCard => {
    state.cards = state.cards.map((entry) => (entry.id === next.id ? next : entry));
    return next;
  };

  const api: BoardApi = {
    list: async () => [...state.cards],
    updateCard: async (input) => {
      const card = find(input.id);
      const { id: _id, ...patch } = input;
      return replace({
        ...card,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      } as KanbanCard);
    },
    createCard: async (input) => {
      const card = makeFakeCard({
        id: `card-${state.cards.length + 1}`,
        title: input.title,
        body: input.body,
        at: input.at ?? "prompts",
        projectId: input.projectId ?? null,
        projectRouteProvenance: input.projectRouteProvenance ?? null,
        modelSelection: input.modelSelection ?? null,
        modelRouteReason: input.modelRouteReason ?? null,
        modelRouteProvenance: input.modelRouteProvenance ?? null,
        modelRouteUsage: input.modelRouteUsage ?? null,
        prepStatus: input.prepStatus ?? "untouched",
      });
      state.cards.push(card);
      return card;
    },
    launchActive: async (input) => {
      const card = find(input.id);
      const refusal = state.launchFailures[card.id];
      if (refusal) throw new Error(refusal);
      const threadId = `thread-${card.id}`;
      replace({ ...card, at: "active", threadId } as KanbanCard);
      return { threadId };
    },
    openPr: async (input) => {
      const card = find(input.id);
      const refusal = state.openPrFailures[card.id];
      if (refusal) throw new Error(refusal);
      const prUrl = `https://forge.test/pr/${card.id}`;
      replace({ ...card, at: "pr", prUrl } as KanbanCard);
      return { prUrl };
    },
    mergePr: async (input) => {
      const card = find(input.id);
      const failure = state.mergeFailures[card.id];
      if (failure) return { merged: false, reason: failure };
      replace({ ...card, at: "done" } as KanbanCard);
      return { merged: true, reason: null };
    },
    closePr: async (input) => {
      const card = find(input.id);
      const reference = input.reference ?? card.prUrl;
      if (!reference)
        return { closed: false, reason: `Card '${card.title}' has no pull request to close.` };
      const failure = state.closePrFailures[card.id];
      if (failure) return { closed: false, reason: failure };
      replace({ ...card, archivedAt: "2026-01-01T00:00:00.000Z" } as unknown as KanbanCard);
      return { closed: true, reason: null };
    },
    // A repo with no CI at all is the fake's default: an empty rollup, not an
    // unreadable one, so the grace window is what decides.
    prChecks: async (input) =>
      state.prChecks[input.id] ?? {
        state: "unknown" as const,
        failing: [],
        unknownReason: "no_checks" as const,
        openedAtMs: null,
      },

    restorePrWorktree: async () => ({ worktreePath: null }),

    syncPrBranch: async (input) => {
      const card = find(input.id);
      const conflict = state.syncConflicts[card.id];
      if (conflict) {
        return {
          synced: false,
          reason: `${conflict.baseBranch} conflicts with ${conflict.headBranch}`,
          conflict,
        };
      }
      delete state.mergeFailures[card.id];
      return { synced: true, reason: null, conflict: null };
    },
    nudgeThread: async (input) => {
      state.nudges.push(input);
    },
    launchHelper: async (input) => {
      const threadId = `helper-thread-${state.helperLaunches.length + 1}`;
      state.helperLaunches.push({ ...input, threadId });
      return { threadId };
    },
    archiveThread: async (input) => {
      state.archivedThreads.push(input.threadId);
    },
    threadReport: async (input) => state.reports[input.threadId] ?? null,
    threadTranscript: async (input) => state.transcripts[input.threadId] ?? null,
    archiveCard: async (input) => {
      const card = find(input.id);
      return replace({
        ...card,
        archivedAt: input.archived === false ? null : "2026-01-01T00:00:00.000Z",
      } as unknown as KanbanCard);
    },
    pendingInputs: async () => [...state.pendingInputs],
    answerPermission: async (input) => {
      state.answers.push(input);
      state.pendingInputs = state.pendingInputs.filter(
        (pending) => pending.requestId !== input.requestId,
      );
    },
    listModels: async () => [
      {
        routeId: "grok/grok-4.5",
        selection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
        },
        instanceId: "grok",
        model: "grok-4.5",
        costTier: 2,
        usable: true,
        note: "",
        options: "",
        optionChoices: [],
        capability: {
          coding: null,
          it: null,
          design: null,
          planning: null,
          effectiveContextTokens: null,
          source: null,
        },
        speed: { medianTurnMs: null, sampleCount: 0, tokensPerSecond: null, throughputSamples: 0 },
        capacity: {
          id: "grok",
          billing: "subscription",
          remainingPercent: null,
          resetsAt: null,
          balanceUsd: null,
          confidence: "unknown",
          detail: "No usage report.",
        },
        usage: {
          lowPercent: null,
          likelyPercent: null,
          highPercent: null,
          confidence: "unknown",
          basis: "No completed observations.",
        },
        meteredPrice: null,
        taskCost: {
          relative: null,
          usdPerTask: null,
          msPerTask: null,
          basis: "unknown" as const,
          taskCount: 0,
          detail: "no turns observed on this route",
        },
      },
    ],
    listProjects: async () => [...state.projects],
    searchProjects: async (input) => {
      const query = input.query.trim().toLowerCase();
      const limit = Math.min(Math.max(1, input.limit ?? 5), 20);
      const slugs = projectSlugs(state.projects);
      const found = state.projects
        .map((project) => {
          const paths =
            query.length === 0
              ? []
              : (state.projectFiles[project.id] ?? []).filter((path) =>
                  path.toLowerCase().includes(query),
                );
          return {
            projectId: project.id,
            slug: slugs.get(project.id) ?? projectSlug(project),
            name: project.name,
            hits: paths.length,
            paths: paths.slice(0, limit),
          };
        })
        .filter((entry) => entry.hits > 0);
      const hits = dropNestedWorkspaceAncestors(found, state.projects).toSorted(
        (left, right) => right.hits - left.hits,
      );
      return { query: input.query.trim(), ambiguous: hits.length > 1, projects: hits };
    },
    listOpenPrs: async (input) =>
      selectPrProjects(state.projects, input).flatMap((project) => [
        ...(state.openPrs[project.id] ?? []),
      ]),
    listOpenIssues: async (input) =>
      selectPrProjects(state.projects, input).flatMap((project) => [
        ...(state.openIssues[project.id] ?? []),
      ]),
    canvasDigest: async () => ({
      docId: DEFAULT_CANVAS_DOC_ID,
      revision: state.canvasShapes.length === 0 ? 0 : 1,
      shapeCount: state.canvasShapes.length,
      untitledCount: 0,
      shapes: [...state.canvasShapes],
      updatedAt: null,
    }),
    canvasDraw: async (input) => {
      state.canvasDrawings.push(input.spec);
      return { id: `injection-${state.canvasDrawings.length}` };
    },
    canvasInbox: async (input) =>
      state.canvasMessages
        .filter((message) => message.deliveredAt === null)
        .map((message) => (input?.includeImages === true ? message : { ...message, image: null })),
    canvasAckMessages: async (input) => {
      state.canvasAcked.push(...input.ids);
      state.canvasMessages = state.canvasMessages.map((message) =>
        input.ids.includes(message.id)
          ? { ...message, deliveredAt: DateTime.makeUnsafe(0) }
          : message,
      );
    },
  };

  return { api, state };
}
