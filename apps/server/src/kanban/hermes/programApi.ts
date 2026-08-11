/**
 * The `board.*` object a tick's program actually sees.
 *
 * It is deliberately *not* the MCP toolkit one-for-one. Mirroring the tools
 * made every tick re-derive the same guard/loop/move code: list, find the card,
 * check where it sits, update, launch, retry the merge. Those are verbs, not
 * decisions — so the verbs live here and the program spends its tokens on the
 * decision instead.
 *
 * This narrows what a program can reach; it never widens it. Every method below
 * is a call the old surface already allowed, and each one goes through the same
 * recorder, so the transcript still shows the primitive steps a verb took.
 *
 * @module kanban/hermes/programApi
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CanvasInjectionSpec,
  HermesLaunchPlan,
  type HermesRoutingBrief,
  type CanvasDigest,
  type KanbanCard,
  type ModelSelection,
} from "@t3tools/contracts";

import type { BoardApi, BoardProject } from "./boardApi.ts";
import { recordHermesHelper, runningHermesHelpers } from "./helperStore.ts";
import { MIN_LESSON_CHARS, recordLesson, retireLesson, type Lesson } from "./knowledgeStore.ts";
import { resolveProjectId, unknownProjectMessage } from "./projectRouting.ts";
import { finishCard, type RulePolicy } from "./rulePass.ts";
import { applyValidatedLaunchPlan, validateLaunchPlan } from "./launchPlan.ts";
import { applyKeepAttachmentIds } from "../kanbanAttachments.ts";

export type ProgramOutcome = {
  readonly ok: boolean;
  /** Why a guard refused. Null when the verb did what it says. */
  readonly reason: string | null;
};

export type BoardProgramApi = {
  applyLaunchPlan(input: {
    plan: HermesLaunchPlan;
  }): Promise<ProgramOutcome & { threadIds: ReadonlyArray<string> }>;
  structureCard(input: {
    id: string;
    title?: string;
    body?: string;
    projectId?: string | null;
    modelSelection?: ModelSelection | null;
    /**
     * Attachment ids to keep for launch/thread context. Omitted = leave flags
     * alone. Empty array drops every attachment from later context.
     */
    keepAttachmentIds?: ReadonlyArray<string>;
  }): Promise<ProgramOutcome & { card: KanbanCard | null }>;
  advanceCard(input: {
    id: string;
    projectId?: string;
  }): Promise<ProgramOutcome & { threadId: string | null }>;
  finishCard(input: {
    id: string;
  }): Promise<ProgramOutcome & { prUrl: string | null; merged: boolean }>;
  createCard(input: {
    title: string;
    body: string;
    projectId?: string | null;
    modelSelection?: ModelSelection | null;
  }): Promise<KanbanCard>;
  updateCard(input: {
    id: string;
    title?: string;
    body?: string;
    at?: KanbanCard["at"];
    projectId?: string | null;
    modelSelection?: ModelSelection | null;
  }): Promise<KanbanCard>;
  archiveCard(input: { id: string; archived?: boolean }): Promise<KanbanCard>;
  /**
   * Close a pull request without merging it. `reference` targets a PR the
   * card does not itself own — an orphan-reconcile card closing the PR named
   * in its own body — and defaults to the card's own `prUrl` when omitted.
   */
  closePr(input: {
    id: string;
    reference?: string;
  }): Promise<{ closed: boolean; reason: string | null }>;
  nudgeThread(input: { threadId: string; text: string }): Promise<void>;
  askHelper(input: {
    question: string;
    cardId?: string | null;
    projectId?: string | null;
    modelSelection?: ModelSelection;
    aboutThreadId?: string | null;
  }): Promise<ProgramOutcome & { helperId: string | null }>;
  threadTranscript(input: {
    threadId: string;
    limit?: number;
  }): ReturnType<BoardApi["threadTranscript"]>;
  answerPermission(input: { threadId: string; requestId: string; answer: string }): Promise<void>;
  searchProjects(input: { query: string; limit?: number }): ReturnType<BoardApi["searchProjects"]>;
  askUser(input: {
    cardId: string;
    question: string;
    options?: ReadonlyArray<string>;
  }): Promise<ProgramOutcome>;
  learn(input: {
    lesson: string;
    projectId?: string | null;
    topic?: string;
    evidence?: string;
  }): Promise<ProgramOutcome & { lessonId: string | null }>;
  forget(input: { id: string; reason: string }): Promise<ProgramOutcome>;
  note(input: { text: string }): Promise<void>;
  reply(input: { text: string }): Promise<void>;
  readCanvas(): Promise<CanvasDigest>;
  drawOnCanvas(input: CanvasInjectionSpec): Promise<ProgramOutcome & { id: string | null }>;
};

export type ProgramApiInput = {
  readonly api: BoardApi;
  readonly policy: RulePolicy;
  readonly recordOnly?: boolean;
  /** Compact briefs keyed by source card. Only cards in this tick are present. */
  readonly routingBriefs?: ReadonlyMap<string, HermesRoutingBrief>;
  /** Where a `note` lands. The runtime owns the beat; this is the free text. */
  readonly onNote: (text: string) => void;
  /** Where a `reply` lands — the chat feed, in full. Absent in narrow tests. */
  readonly onReply?: (text: string) => void;
};

/** A diagram past this is a data dump, not an explanation. */
const MAX_DRAWING_NODES = 40;

// Program args are model-authored JS values, not RPC payloads — nothing has
// validated them yet. An unvalidated spec lands in the injection queue and
// replays into every browser, so a junk one used to break the canvas on every
// load until the row was deleted by hand.
const decodeInjectionSpec = Schema.decodeUnknownResult(CanvasInjectionSpec);
const decodeLaunchPlan = Schema.decodeUnknownResult(HermesLaunchPlan);

/** Shorter than this is a topic, and an agent cannot answer a topic. */
const MIN_HELPER_QUESTION_CHARS = 20;
const MIN_USER_QUESTION_CHARS = 10;
const MAX_USER_QUESTION_CHARS = 800;
const MAX_USER_QUESTION_OPTIONS = 6;
const MAX_USER_QUESTION_OPTION_CHARS = 120;

const refused = (reason: string): ProgramOutcome => ({ ok: false, reason });

async function cardById(api: BoardApi, id: string): Promise<KanbanCard | null> {
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  return cards.find((entry) => entry.id === id) ?? null;
}

export function makeProgramApi(input: ProgramApiInput): BoardProgramApi {
  const { api, policy } = input;
  const recordOnly = input.recordOnly === true;
  let projectCache: ReadonlyArray<BoardProject> | null = null;

  /** A slug or an id, resolved to an id. Throws on one the board does not have. */
  const resolveProject = async (value: string | null): Promise<string | null> => {
    if (value === null || value.trim().length === 0) return null;
    projectCache ??= await api.listProjects().catch(() => [] as ReadonlyArray<BoardProject>);
    const resolved = resolveProjectId(projectCache, value);
    if (resolved === null) throw new Error(unknownProjectMessage(projectCache, value));
    return resolved;
  };

  return {
    applyLaunchPlan: async (args) => {
      if (!policy.launchPrompts) {
        return { ...refused("Prompts → Active is off"), threadIds: [] };
      }
      const decoded = decodeLaunchPlan(args.plan);
      if (Result.isFailure(decoded)) {
        return { ...refused("launch plan did not match the typed schema"), threadIds: [] };
      }
      const plan = decoded.success;
      const brief = input.routingBriefs?.get(plan.sourceCardId);
      if (!brief) {
        return { ...refused(`no routing brief for card '${plan.sourceCardId}'`), threadIds: [] };
      }
      try {
        const validated = validateLaunchPlan(plan, brief);
        if (recordOnly) {
          return {
            ok: validated.status === "ready",
            reason: validated.blockedReason,
            threadIds: [],
          };
        }
        const applied = await applyValidatedLaunchPlan(api, validated);
        return { ok: true, reason: null, threadIds: applied.threadIds };
      } catch (cause) {
        return {
          ...refused(cause instanceof Error ? cause.message : String(cause)),
          threadIds: [],
        };
      }
    },

    structureCard: async (args) => {
      if (input.routingBriefs?.has(args.id)) {
        return {
          ...refused("this card has a routing brief — submit one applyLaunchPlan instead"),
          card: null,
        };
      }
      const card = await cardById(api, args.id);
      if (!card) return { ...refused(`card '${args.id}' is gone`), card: null };
      if (card.at !== "prompts") {
        return { ...refused(`card '${args.id}' is in ${card.at}, not Prompts`), card: null };
      }
      let projectId: string | null = null;
      if (args.projectId !== undefined) {
        try {
          projectId = await resolveProject(args.projectId);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return { ...refused(reason), card: null };
        }
      }
      const attachments =
        args.keepAttachmentIds === undefined
          ? undefined
          : applyKeepAttachmentIds(card.attachments ?? [], args.keepAttachmentIds);
      const updated = await api.updateCard({
        id: args.id,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.projectId === undefined ? {} : { projectId }),
        ...(args.modelSelection === undefined ? {} : { modelSelection: args.modelSelection }),
        ...(attachments === undefined ? {} : { attachments }),
        prepStatus: "ready",
      });
      return {
        ok: true,
        reason: null,
        card: updated,
      };
    },

    advanceCard: async (args) => {
      if (input.routingBriefs?.has(args.id)) {
        return {
          ...refused("this card has a routing brief — submit one applyLaunchPlan instead"),
          threadId: null,
        };
      }
      if (!policy.launchPrompts) {
        return { ...refused("Prompts → Active is off"), threadId: null };
      }
      const card = await cardById(api, args.id);
      if (!card) return { ...refused(`card '${args.id}' is gone`), threadId: null };
      if (card.at === "active" && card.threadId) {
        return { ok: true, reason: "already running", threadId: String(card.threadId) };
      }
      if (card.at !== "prompts") {
        return { ...refused(`card '${args.id}' is in ${card.at}`), threadId: null };
      }
      let asked: string | null = null;
      try {
        asked = await resolveProject(args.projectId ?? null);
      } catch (cause) {
        return {
          ...refused(cause instanceof Error ? cause.message : String(cause)),
          threadId: null,
        };
      }
      const projectId = asked ?? card.projectId;
      if (!projectId) return { ...refused("no project — set one first"), threadId: null };
      const launched = await api.launchActive({
        id: args.id,
        ...(asked === null ? {} : { projectId: asked }),
      });
      return { ok: true, reason: null, threadId: launched?.threadId ?? null };
    },

    finishCard: async (args) => {
      const result = await finishCard(api, args.id, { recordOnly });
      return {
        ok: result.merged || result.prUrl !== null,
        reason: result.reason,
        prUrl: result.prUrl,
        merged: result.merged,
      };
    },

    createCard: async (args) => {
      if ((input.routingBriefs?.size ?? 0) > 0) {
        throw new Error("split routing work belongs inside applyLaunchPlan");
      }
      return api.createCard({
        ...args,
        projectId: await resolveProject(args.projectId ?? null),
        at: "prompts",
      });
    },

    // Moving a card out of Active reaps its worktree — that is the store's
    // choke point, and it fires on a plain column write. A program that dragged
    // a finished card to PR itself therefore deleted the uncommitted work
    // seconds before anything could commit it, and openPr then reported an
    // empty worktree. Only `finishCard` may take a card out of Active.
    updateCard: async (args) => {
      if (input.routingBriefs?.has(args.id)) {
        throw new Error("routing-card writes belong inside applyLaunchPlan");
      }
      if (args.at === "pr" || args.at === "done") {
        const card = await cardById(api, args.id);
        if (card?.at === "active") {
          throw new Error(
            `card '${args.id}' is in Active — call board.finishCard to commit, push and open ` +
              `the PR. Writing column '${args.at}' here reaps the worktree and loses the work.`,
          );
        }
      }
      return api.updateCard({
        ...args,
        ...(args.projectId === undefined
          ? {}
          : { projectId: await resolveProject(args.projectId) }),
      });
    },
    archiveCard: (args) => api.archiveCard(args),
    closePr: (args) => api.closePr(args),
    nudgeThread: (args) => api.nudgeThread(args),

    learn: async (args) => {
      const lesson = String(args.lesson ?? "").trim();
      if (lesson.length < MIN_LESSON_CHARS) {
        return { ...refused("a lesson is one usable sentence, not a phrase"), lessonId: null };
      }
      let projectId: string | null = null;
      try {
        projectId = await resolveProject(args.projectId ?? null);
      } catch (cause) {
        return {
          ...refused(cause instanceof Error ? cause.message : String(cause)),
          lessonId: null,
        };
      }
      if (recordOnly)
        return { ok: true, reason: "record-only run did not store it", lessonId: null };
      const stored: Lesson | null = recordLesson({
        lesson,
        projectId,
        source: "hermes",
        ...(args.topic === undefined ? {} : { topic: String(args.topic) }),
        ...(args.evidence === undefined ? {} : { evidence: String(args.evidence) }),
      });
      return stored === null
        ? { ...refused("a lesson is one usable sentence, not a phrase"), lessonId: null }
        : { ok: true, reason: null, lessonId: stored.id };
    },

    forget: async (args) => {
      const reason = String(args.reason ?? "").trim();
      if (reason.length === 0)
        return refused("say why it is wrong — a silent retraction is not a record");
      if (recordOnly) return { ok: true, reason: "record-only run did not retire it" };
      const retired = retireLesson(String(args.id ?? ""), reason);
      return retired === null
        ? refused(`no active lesson '${String(args.id ?? "")}'`)
        : { ok: true, reason: null };
    },

    // Every guard here exists so a program cannot turn one undecided card into
    // a queue of agent sessions: one helper per card, a hard concurrency cap,
    // and a question that has to be a question.
    askHelper: async (args) => {
      const helpers = policy.helpers;
      if (!helpers.enabled) return { ...refused("helper threads are off"), helperId: null };
      const question = String(args.question ?? "").trim();
      if (question.length < MIN_HELPER_QUESTION_CHARS) {
        return { ...refused("a helper needs a real question, not a phrase"), helperId: null };
      }
      const cardId = args.cardId ?? null;
      const card = cardId === null ? null : await cardById(api, cardId);
      if (cardId !== null && !card) {
        return { ...refused(`card '${cardId}' is gone`), helperId: null };
      }
      const running = runningHermesHelpers();
      if (running.length >= helpers.maxConcurrent) {
        return {
          ...refused(`${running.length} helpers already running (cap ${helpers.maxConcurrent})`),
          helperId: null,
        };
      }
      if (cardId !== null && running.some((helper) => helper.cardId === cardId)) {
        return {
          ...refused(`card '${cardId}' already has a helper running — wait for its answer`),
          helperId: null,
        };
      }
      let asked: string | null = null;
      try {
        asked = await resolveProject(args.projectId ?? null);
      } catch (cause) {
        return {
          ...refused(cause instanceof Error ? cause.message : String(cause)),
          helperId: null,
        };
      }
      const projectId = asked ?? card?.projectId ?? null;
      if (!projectId) {
        return { ...refused("no project — a helper runs inside one"), helperId: null };
      }
      const launched = await api.launchHelper({
        question,
        projectId: String(projectId),
        ...(args.modelSelection ? { modelSelection: args.modelSelection } : {}),
        ...(args.aboutThreadId ? { aboutThreadId: args.aboutThreadId } : {}),
      });
      // The dry run stubs writes out to null; say so instead of claiming a helper.
      if (launched === null) {
        return { ...refused("record-only run did not launch a helper"), helperId: null };
      }
      const helper = recordHermesHelper({
        threadId: launched.threadId,
        question,
        cardId,
        projectId: String(projectId),
        askedAt: new Date().toISOString(),
      });
      return { ok: true, reason: null, helperId: helper.id };
    },
    threadTranscript: (args) => api.threadTranscript(args),
    answerPermission: (args) => api.answerPermission(args),
    searchProjects: (args) => api.searchProjects(args),
    askUser: async (args) => {
      if (!input.onReply) return refused("Hermes chat is unavailable");
      const card = await cardById(api, String(args.cardId ?? ""));
      if (!card) return refused(`card '${String(args.cardId ?? "")}' is gone`);
      const question = String(args.question ?? "")
        .trim()
        .slice(0, MAX_USER_QUESTION_CHARS);
      if (question.length < MIN_USER_QUESTION_CHARS) {
        return refused("a user clarification needs a complete question");
      }
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const options = [
        ...new Set(
          rawOptions.map((option) =>
            String(option).trim().slice(0, MAX_USER_QUESTION_OPTION_CHARS),
          ),
        ),
      ]
        .filter((option) => option.length > 0)
        .slice(0, MAX_USER_QUESTION_OPTIONS);
      const choices =
        options.length === 0
          ? ""
          : `\n\nChoices:\n${options.map((option) => `- ${option}`).join("\n")}`;
      input.onReply(
        `I need one detail before I can continue “${card.title}”:\n\n${question}${choices}` +
          "\n\nReply with a choice or your own answer.",
      );
      return { ok: true, reason: null };
    },
    note: async (args) => {
      input.onNote(String(args.text ?? "").trim());
    },

    reply: async (args) => {
      input.onReply?.(String(args.text ?? "").trim());
    },

    readCanvas: () => api.canvasDigest(),

    drawOnCanvas: async (args) => {
      // Edges are the one field a model reasonably omits for a plain list.
      const raw =
        typeof args === "object" && args !== null
          ? { ...args, edges: (args as { edges?: unknown }).edges ?? [] }
          : args;
      const decoded = decodeInjectionSpec(raw);
      if (Result.isFailure(decoded)) {
        const detail =
          decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure);
        return { ...refused(`invalid drawing: ${detail.slice(0, 300)}`), id: null };
      }
      const spec = decoded.success;
      if (spec.nodes.length === 0) {
        return { ...refused("a drawing needs at least one node"), id: null };
      }
      if (spec.nodes.length > MAX_DRAWING_NODES) {
        return {
          ...refused(`${spec.nodes.length} nodes is over the ${MAX_DRAWING_NODES} cap`),
          id: null,
        };
      }
      const keys = new Set(spec.nodes.map((node) => node.key));
      const dangling = spec.edges.find((edge) => !keys.has(edge.from) || !keys.has(edge.to));
      if (dangling) {
        return {
          ...refused(
            `edge ${dangling.from} → ${dangling.to} names a node that is not in this drawing`,
          ),
          id: null,
        };
      }
      const drawn = await api.canvasDraw({ spec });
      return { ok: true, reason: null, id: drawn.id };
    },
  };
}
