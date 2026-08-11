/**
 * Hermes brain runtime — the one loop, off by default.
 *
 * Nothing here ticks, calls a backend or writes to the board until
 * `boardSettings.hermesBrainEnabled` is true. `dryRun` is the exception: it
 * runs one tick in record-only mode on demand from the settings tab.
 *
 * @module kanban/hermes/HermesBrain
 */
import * as NodeCrypto from "node:crypto";

import type {
  BoardSettings,
  HermesBoardStatus,
  HermesBrainStats,
  HermesCardActivity,
  HermesCardWatch,
  HermesBrainStatus,
  HermesConversationStatus,
  HermesPreflightStatus,
  HermesSpend,
  HermesTickLogEntry,
  HermesTickTranscript,
  HermesTickTrigger,
  KanbanCard,
} from "@t3tools/contracts";

import {
  clearFriction,
  frictionDueForCard,
  frictionFingerprint,
  listFriction,
  recordFriction,
  setFrictionStatus,
  type FrictionEntry,
} from "../../friction/frictionStore.ts";
import { recordDegradation } from "../../health/incidentLog.ts";
import type { LaunchPreflight } from "../../health/preflight.ts";
import type { BudgetDeps } from "../budget/BudgetService.ts";
import { parseAgentReport } from "./agentReport.ts";
import { shouldForceModelForPrStuck } from "./prStuckReason.ts";
import {
  HERMES_MODEL,
  HERMES_TIERS,
  endHermesSessions,
  hermesTransportClaims,
  resolveHermesTransport,
  tierModelId,
  type HermesBackend,
  type HermesTier,
} from "./backend.ts";
import { hermesImagesFromCardAttachments } from "../kanbanAttachments.ts";
import {
  BOARD_WRITE_METHODS,
  boardCallFailure,
  makeBoardRecorder,
  type BoardApi,
  type BoardCallRecord,
} from "./boardApi.ts";
import { hermesChatTurns, hermesRuleChatTurn } from "./chatFeed.ts";
import { appendHermesChat } from "./chatStore.ts";
import { clearCompletionCheckCounts } from "./completionPass.ts";
import {
  appendTurns,
  applyEviction,
  assembleHistory,
  ceilingForModel,
  buildResultTurn,
  conversationTokens,
  emptyHermesConversation,
  hermesSystemPromptVersion,
  planEviction,
  recordInputTokens,
  type HermesCliSessionRecord,
  type HermesConversationState,
  type HermesEvictionPlan,
} from "./conversation.ts";
import {
  deleteHermesConversation,
  readHermesConversation,
  writeHermesConversation,
} from "./conversationStore.ts";
import { collectHermesHelpers } from "./helpers.ts";
import {
  deliverHermesHelpers,
  liveHermesHelpers,
  resetHermesHelpers,
  runningHermesHelpers,
} from "./helperStore.ts";
import { appendJournal, journalEntriesFromCalls, pruneJournal } from "./journal.ts";
import { activeLessons, expireStaleLessons, type Lesson } from "./knowledgeStore.ts";
import { learnFromTickNudges } from "./lessons.ts";
import {
  judgmentQueue,
  modelJudgmentQueue,
  STALLED_REVIEWS,
  type JudgmentItem,
} from "./judgment.ts";
import { collectCardHistory } from "./messageContext.ts";
import { makeHermesOperationCoordinator } from "./operationCoordinator.ts";
import type { HermesOperationStore } from "./operationStore.ts";
import { hermesBoardPolicy } from "./policy.ts";
import {
  boardDigestOf,
  buildHermesDeltaBlock,
  buildHermesSnapshotBlock,
  type HermesSnapshot,
} from "./prompt.ts";
import { rulePolicy, runRulePass } from "./rulePass.ts";
import { boardComponentIds, componentRuleListing, describeComponents } from "../components/seed.ts";
import { buildRoutingBrief } from "./routingBrief.ts";
import { evaluateSpendCap } from "./spendCap.ts";
import { runHermesTick, summarize, type HermesTickResult } from "./tick.ts";
import { appendHermesTick, hermesTickLogPath, readHermesTickLog } from "./tickLogStore.ts";
import {
  addSpend,
  appendHermesUsage,
  emptyHermesSpend,
  hermesUsageLogPath,
  readHermesSpend,
  toUsageRow,
  writeHermesSpend,
} from "./usageLogStore.ts";

export type HermesBrainDeps = {
  readonly api: BoardApi;
  readonly backends: ReadonlyArray<HermesBackend>;
  readonly boardSettings: () => Promise<BoardSettings>;
  /** Absent in trimmed boots; budget routing simply stays off. */
  readonly budget?: BudgetDeps;
  /** Durable mutation receipts. Absent only in narrow unit-test runtimes. */
  readonly operations?: HermesOperationStore;
  /**
   * The box checks. Absent in tests and trimmed boots, where the loop runs
   * ungated exactly as it did before there was a gate.
   */
  readonly preflight?: LaunchPreflight;
  /** Where kanban composer media bytes live. Absent in narrow unit tests. */
  readonly attachmentsDir?: string;
  /**
   * Instance id → driver kind, from `ServerSettings.providerInstances`. Absent
   * in tests and trimmed boots, where built-in instance ids are their driver.
   */
  readonly providerDrivers?: () => Promise<Record<string, string>>;
};

/**
 * The transport the board's `{instanceId, model}` selection resolves to.
 *
 * Every resolution records its reason on the board status, so the chip is the
 * same answer as the tick log rather than a second opinion about it.
 */
async function hermesTransport(deps: HermesBrainDeps, settings: BoardSettings) {
  const drivers = deps.providerDrivers ? await deps.providerDrivers() : {};
  const resolved = resolveHermesTransport({
    selection: { instanceId: settings.hermesBrainInstanceId, model: settings.hermesBrainModel },
    drivers,
    transports: hermesTransportClaims(deps.backends),
  });
  boardStatus = { ...boardStatus, providerError: resolved.reason };
  return resolved;
}

/** Nudge counts per thread, so the cap survives across ticks within a process. */
const nudgeCounts = new Map<string, number>();

/** Ring buffer of recent ticks. Process-local: a restart starts a fresh log. */
const LOG_LIMIT = 30;
const history: HermesTickTranscript[] = [];
let lastTick: HermesTickTranscript | null = null;
let tickSeq = 0;

/** One wall-clock boundary, so ordinary orchestration code does not reach for globals. */
function wallClockMs(): number {
  return Date.now();
}

const stats = {
  since: new Date().toISOString(),
  heartbeats: 0,
  skipped: 0,
  ticks: 0,
  failed: 0,
  writes: 0,
  nudges: 0,
  modelSkipped: 0,
  ruleWrites: 0,
  servedByTier: new Map<HermesTier, number>(),
  ruleFires: new Map<string, { count: number; lastAt: string }>(),
  spend: emptyHermesSpend(),
};

/**
 * One rule fired. Durable like the heartbeat counters — a rule that has never
 * run is the thing a rules dialog most needs to say, and that answer cannot
 * survive only in memory when Install restarts the service.
 */
function recordRuleFire(rule: string): void {
  const previous = stats.ruleFires.get(rule);
  stats.ruleFires.set(rule, {
    count: (previous?.count ?? 0) + 1,
    lastAt: new Date().toISOString(),
  });
}

/**
 * Push the counters to disk. Every tick, because a spend number is only useful
 * as a trend and a trend that dies with the process cannot answer "is this
 * cheaper than last week".
 */
function persistStats(): void {
  writeHermesSpend({
    since: stats.since,
    spend: stats.spend,
    counters: {
      heartbeats: stats.heartbeats,
      skipped: stats.skipped,
      ticks: stats.ticks,
      failed: stats.failed,
      writes: stats.writes,
      nudges: stats.nudges,
      modelSkipped: stats.modelSkipped,
      ruleWrites: stats.ruleWrites,
    },
    servedByTier: Object.fromEntries(stats.servedByTier),
    ruleFires: Object.fromEntries(stats.ruleFires),
  });
}

/** Reload the durable counters, so a restart is not a reset. */
export function restoreHermesSpend(): void {
  const file = readHermesSpend();
  if (!file) return;
  stats.since = file.since;
  stats.spend = file.spend;
  stats.heartbeats = file.counters["heartbeats"] ?? 0;
  stats.skipped = file.counters["skipped"] ?? 0;
  stats.ticks = file.counters["ticks"] ?? 0;
  stats.failed = file.counters["failed"] ?? 0;
  stats.writes = file.counters["writes"] ?? 0;
  stats.nudges = file.counters["nudges"] ?? 0;
  stats.modelSkipped = file.counters["modelSkipped"] ?? 0;
  stats.ruleWrites = file.counters["ruleWrites"] ?? 0;
  stats.ruleFires.clear();
  for (const [rule, fire] of Object.entries(file.ruleFires)) {
    stats.ruleFires.set(rule, fire);
  }
  stats.servedByTier.clear();
  for (const [tier, served] of Object.entries(file.servedByTier)) {
    if ((HERMES_TIERS as ReadonlyArray<string>).includes(tier)) {
      stats.servedByTier.set(tier as HermesTier, served);
    }
  }
}

/**
 * Consecutive-failure memory for board operations, keyed by method+card. A
 * success on the same key clears it. This is how the loop notices its own
 * breakage instead of leaving the user to read tick logs: repeated failures
 * show up in the next prompt (`## BOARD FAILURES`) and, at the threshold, file
 * one fix Draft so the loop can launch a thread at its own bug.
 */
type BoardFailure = {
  method: string;
  cardId: string | null;
  error: string;
  count: number;
  lastAt: string;
  filed: boolean;
};
const boardFailures = new Map<string, BoardFailure>();
const BOARD_FAILURE_LIMIT = 50;
const SELF_FIX_THRESHOLD = 3;

/** Board failures fingerprint on method+card: the error text differs per tick. */
function boardFailureSignature(method: string, cardId: string | null): string {
  return `board-call ${method} ${cardId ?? "(board)"}`;
}

/**
 * Mirror the counter into the friction log. The Map is the working set for the
 * tick; this is what makes it survive a restart — and Install restarts the
 * service, so an in-memory-only counter reset before a chronic failure could
 * ever reach the threshold.
 */
function persistBoardFailure(entry: BoardFailure): void {
  recordFriction({
    source: "board",
    scope: "repo",
    tool: entry.method,
    signature: boardFailureSignature(entry.method, entry.cardId),
    summary: `board call ${entry.method} keeps failing`,
    evidence: entry.error,
    ...(entry.cardId === null ? {} : { cardId: entry.cardId }),
    at: entry.lastAt,
  });
}

function forgetBoardFailure(method: string, cardId: string | null): void {
  clearFriction(
    frictionFingerprint({
      scope: "repo",
      tool: method,
      signature: boardFailureSignature(method, cardId),
    }),
  );
}

/**
 * Rehydrate the consecutive-failure counter from the friction log at boot.
 * `filed` is read back from the entry's status so a restart cannot re-file a
 * card that already exists.
 */
export function restoreHermesBoardFailures(): void {
  for (const entry of listFriction()) {
    if (entry.source !== "board") continue;
    const cardId = entry.cardIds[entry.cardIds.length - 1] ?? null;
    boardFailures.set(`${entry.tool}:${cardId ?? "-"}`, {
      method: entry.tool,
      cardId,
      error: entry.evidence ?? "",
      count: entry.count,
      lastAt: entry.lastSeenAt,
      filed: entry.status === "carded",
    });
  }
}

export function trackBoardFailures(transcript: HermesTickTranscript): void {
  let hadCallFailure = false;
  for (const call of transcript.calls) {
    if (call.skipped === true) continue;
    // A refusal is the coordinator declining to run the call, not the board
    // failing it again. Counting it would inflate "failed 5×" out of one attempt.
    if (call.refused === true) continue;
    if (!BOARD_WRITE_METHODS.has(call.method)) continue;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const cardId =
      typeof args["id"] === "string"
        ? args["id"]
        : typeof args["threadId"] === "string"
          ? args["threadId"]
          : null;
    const key = `${call.method}:${cardId ?? "-"}`;
    if (call.error === undefined) {
      boardFailures.delete(key);
      forgetBoardFailure(call.method, cardId);
      continue;
    }
    hadCallFailure = true;
    const entry = boardFailures.get(key) ?? {
      method: call.method,
      cardId,
      error: call.error,
      count: 0,
      lastAt: transcript.ranAt,
      filed: false,
    };
    entry.count += 1;
    entry.error = call.error.slice(0, 500);
    entry.lastAt = transcript.ranAt;
    boardFailures.delete(key);
    boardFailures.set(key, entry);
    persistBoardFailure(entry);
  }
  if (transcript.error === null) {
    boardFailures.delete("tick:-");
    forgetBoardFailure("tick", null);
  } else if (hadCallFailure) {
    // The failing call above already explains this tick; one card is enough.
  } else {
    const entry = boardFailures.get("tick:-") ?? {
      method: "tick",
      cardId: null,
      error: transcript.error,
      count: 0,
      lastAt: transcript.ranAt,
      filed: false,
    };
    entry.count += 1;
    entry.error = transcript.error.slice(0, 500);
    entry.lastAt = transcript.ranAt;
    boardFailures.delete("tick:-");
    boardFailures.set("tick:-", entry);
    persistBoardFailure(entry);
  }
  while (boardFailures.size > BOARD_FAILURE_LIMIT) {
    const oldest = boardFailures.keys().next();
    if (oldest.done) break;
    boardFailures.delete(oldest.value);
  }
}

export function repeatedBoardFailures(): ReadonlyArray<{
  method: string;
  cardId: string | null;
  count: number;
  error: string;
}> {
  return [...boardFailures.values()]
    .filter((entry) => entry.count >= 2)
    .map(({ method, cardId, count, error }) => ({ method, cardId, count, error }));
}

function selfFixTitle(method: string): string {
  return `Fix board loop: ${method} keeps failing`;
}

/**
 * File one fix Draft per failing method once the threshold is crossed. Dedup is
 * by title against unarchived cards, so a restart cannot double-file.
 */
async function fileSelfFixCards(api: BoardApi, transcript: HermesTickTranscript): Promise<void> {
  if (transcript.recordOnly) return;
  const due = [...boardFailures.values()].filter(
    (entry) => entry.count >= SELF_FIX_THRESHOLD && !entry.filed && entry.method !== "createCard",
  );
  if (due.length === 0) return;
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  for (const entry of due) {
    entry.filed = true;
    setFrictionStatus(
      frictionFingerprint({
        scope: "repo",
        tool: entry.method,
        signature: boardFailureSignature(entry.method, entry.cardId),
      }),
      "carded",
    );
    const title = selfFixTitle(entry.method);
    const exists = cards.some(
      (card) => card.title === title && !card.archivedAt && card.at !== "done",
    );
    if (exists) continue;
    const where = entry.cardId ? ` (card ${entry.cardId})` : "";
    await api
      .createCard({
        title,
        body: [
          "Mission",
          `The board loop's \`${entry.method}\` call${where} has failed ${entry.count} ticks in a row. Fix the underlying cause so the loop completes without a human.`,
          "",
          "Last error:",
          "```",
          entry.error,
          "```",
          "",
          "Work to do",
          "- Diagnose the failure — Settings → Hermes → Tick log has each attempt.",
          "- Fix the root cause in vps-code and cover it with a focused test.",
          "",
          "Done when",
          `- \`${entry.method}\` succeeds on the live board.`,
        ].join("\n"),
        at: "prompts",
      })
      .catch(() => undefined);
  }
}

/** The papercuts worth a line in the prompt: every open one, first sighting included. */
const PROMPT_PAPERCUT_LIMIT = 8;

function promptPapercuts(): ReadonlyArray<{
  tool: string;
  scope: string;
  summary: string;
  count: number;
  threads: number;
  workaround: string | null;
}> {
  return listFriction()
    .filter((entry) => entry.source !== "board" && entry.status === "open")
    .slice(0, PROMPT_PAPERCUT_LIMIT)
    .map((entry) => ({
      tool: entry.tool,
      scope: entry.scope,
      summary: entry.summary,
      count: entry.count,
      threads: entry.threadIds.length,
      workaround: entry.workaround,
    }));
}

/** Lessons worth a line in the tick prompt — the most-repeated first. */
const PROMPT_KNOWLEDGE_LIMIT = 12;

/**
 * What Hermes is shown of its own knowledge. Expiry runs here rather than on a
 * schedule of its own: the tick is the only thing that reads this file, so a
 * lesson that has aged out never reaches a prompt, and no timer exists to fail.
 */
function promptKnowledge(): ReadonlyArray<Lesson> {
  expireStaleLessons();
  return [...activeLessons()]
    .sort(
      (a, b) => b.learnedCount - a.learnedCount || b.lastLearnedAt.localeCompare(a.lastLearnedAt),
    )
    .slice(0, PROMPT_KNOWLEDGE_LIMIT);
}

function papercutCardTitle(entry: FrictionEntry): string {
  return entry.scope === "upstream"
    ? `Upstream: ${entry.tool} — ${entry.summary}`
    : `Fix tooling: ${entry.tool} — ${entry.summary}`;
}

/**
 * File one Draft per open fingerprint — first sighting included — so friction
 * gets scheduled instead of remembered. Only runs when `hermesAutoDraftPapercuts` is
 * on. Dedup is by fingerprint in the friction log *and* by title against the
 * board, so neither a restart nor a hand-made card double-files.
 *
 * An `upstream` papercut is a bug in someone else's tool. Its card says so, and
 * its Done-when is a vendored patch plus a filed issue — never "fixed here",
 * and never a nudge back into the thread that found it.
 */
async function fileFrictionCards(api: BoardApi): Promise<void> {
  const due = frictionDueForCard();
  if (due.length === 0) return;
  const cards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  for (const entry of due) {
    const title = papercutCardTitle(entry);
    setFrictionStatus(entry.fingerprint, "carded");
    if (cards.some((card) => card.title === title && !card.archivedAt && card.at !== "done")) {
      continue;
    }
    const upstream = entry.scope === "upstream";
    const threads = entry.threadIds.length > 1 ? ` across ${entry.threadIds.length} threads` : "";
    await api
      .createCard({
        title,
        body: [
          "Mission",
          upstream
            ? `\`${entry.tool}\` is broken upstream and agents keep working around it (${entry.count}×${threads}). Carry a patch in this repo and file the issue upstream — do not wait on the fix.`
            : `\`${entry.tool}\` broke under ${entry.count} agent run${entry.count === 1 ? "" : "s"}${threads} and was worked around each time. Fix it so the next run does not pay for it again.`,
          "",
          "Evidence:",
          "```",
          entry.evidence ?? entry.summary,
          "```",
          ...(entry.context["failedCommand"]
            ? ["", `Command that failed: \`${entry.context["failedCommand"]}\``]
            : []),
          ...(entry.workaround ? ["", `What agents did instead: ${entry.workaround}`] : []),
          "",
          "Work to do",
          upstream
            ? "- Reproduce it against the vendored copy, patch it there, and open the upstream issue."
            : "- Reproduce it, fix the root cause, and cover it with a focused test.",
          `- Threads that hit it: ${entry.threadIds.join(", ") || "(none recorded)"}.`,
          "",
          "Done when",
          upstream
            ? "- The vendored patch lands and the upstream issue is filed. Fixing it upstream is not this card's job."
            : `- \`${entry.tool}\` works in a fresh worktree and the papercut stops recurring.`,
        ].join("\n"),
        at: "prompts",
      })
      .catch(() => undefined);
  }
}

async function runSelfHeal(api: BoardApi, transcript: HermesTickTranscript): Promise<void> {
  if (transcript.recordOnly) return;
  trackBoardFailures(transcript);
  await fileSelfFixCards(api, transcript);
}

/**
 * The one persisted Hermes conversation. First tick sends the full snapshot;
 * every later tick sends only the delta, and after execution a compact result
 * turn is appended so the next tick's context contains what happened.
 */
let conversation: HermesConversationState | null = null;

/** The transport the last tick asked. A change ends the session it left open. */
let servingTier: HermesTier | null = null;
let servingModel: string | null = null;

/** Reload the conversation on boot. Corrupt or outdated history keeps the journal. */
export function restoreHermesConversation(
  backends: ReadonlyArray<Pick<HermesBackend, "tier" | "adoptSession">> = [],
): void {
  const read = readHermesConversation();
  if (!read) {
    conversation = null;
    return;
  }
  if ("corrupt" in read) {
    conversation = emptyHermesConversation({ journal: read.journal });
    writeHermesConversation(conversation);
    return;
  }
  if (read.state.systemPromptVersion !== hermesSystemPromptVersion()) {
    // The system prompt changed under the history; the old turns argue with it.
    // The journal is a record of calls, not of prompts, so it carries over.
    conversation = emptyHermesConversation({ journal: read.state.journal });
    writeHermesConversation(conversation);
    return;
  }
  conversation = read.state;
  const saved = read.state.cliSession;
  if (!saved) return;
  // The agent this history lives in may still be running. Hand its id back to
  // the transport that owns it; the first send reattaches, and a resume that
  // fails is already a recorded degradation with a full re-send behind it.
  backends
    .find((backend) => backend.tier === saved.tier)
    ?.adoptSession?.({ id: saved.id, model: saved.model });
}

export function hermesConversationStatus(): HermesConversationStatus {
  return {
    turns: conversation?.turns.length ?? 0,
    estTokens: conversation ? conversationTokens(conversation) : 0,
    journalEntries: conversation?.journal.length ?? 0,
    lastEvictionAt: conversation?.lastEvictionAt ?? null,
    lastEvictionReason: conversation?.lastEvictionReason ?? null,
    startedAt: conversation?.startedAt ?? null,
  };
}

/**
 * Wipe the history. The CLI sessions holding it go with it — a session that
 * outlived its record would answer the next tick out of a memory nobody can
 * see.
 */
export async function resetHermesConversation(
  backends: ReadonlyArray<Pick<HermesBackend, "endSession">> = [],
): Promise<void> {
  conversation = null;
  deleteHermesConversation();
  await endHermesSessions(backends);
}

/** The model every tier asks for — the key a per-model ceiling is stored under. */
function hermesModelId(settings: BoardSettings): string {
  return settings.hermesBrainModel.trim() || HERMES_MODEL;
}

function queuedCardIds(queue: ReadonlyArray<JudgmentItem>): ReadonlySet<string> {
  return new Set(
    queue.map((item) => item.cardId).filter((cardId): cardId is string => cardId !== null),
  );
}

function logEviction(plan: HermesEvictionPlan, before: number, at: string): void {
  console.log(
    JSON.stringify({
      evt: "hermes.conversation.evict",
      at,
      reason: plan.reason,
      turnsBefore: before,
      turnsAfter: conversation?.turns.length ?? 0,
      journalEntries: conversation?.journal.length ?? 0,
      // A ceiling cut goes through a live decision: one card has been queued for
      // the whole conversation, which is a stuck card, not a busy board.
      ...(plan.reason === "ceiling" ? { stuck: true } : {}),
    }),
  );
}

/**
 * Cut the history at a boundary the board just handed us. A tick where nothing
 * needs a decision is the cheapest, most correct place to drop everything — no
 * decision is in flight, and a settled board is not about to send a delta.
 * Never throws.
 */
export async function settleHermesConversation(
  queue: ReadonlyArray<JudgmentItem>,
  settings: BoardSettings,
  backends: ReadonlyArray<Pick<HermesBackend, "endSession">> = [],
): Promise<void> {
  const state = conversation;
  if (!state) return;
  const plan = planEviction({
    state,
    queuedCardIds: queuedCardIds(queue),
    ceilingTokens: ceilingForModel(settings.hermesContextCeilings, hermesModelId(settings)),
  });
  if (!plan) return;
  const at = new Date().toISOString();
  const before = state.turns.length;
  conversation = applyEviction(state, plan, at);
  logEviction(plan, before, at);
  writeHermesConversation(conversation);
  // Same eviction, both transports: an HTTP tier stops re-sending the dropped
  // turns, a CLI tier loses the session that was holding them.
  await endHermesSessions(backends);
}

/**
 * Fold what a tick did back into the conversation. A conversational tick
 * appends its user turn, program and results; a stateless fallback tick
 * appends only a result turn, so the history still knows what happened.
 * Never throws — a conversation problem must not fail a tick.
 */
/** The serving transport's session, as the record that survives a restart. */
function servingCliSession(
  backends: ReadonlyArray<Pick<HermesBackend, "tier" | "sessionId">>,
): HermesCliSessionRecord | null {
  if (servingTier === null || servingModel === null) return null;
  const id = backends.find((backend) => backend.tier === servingTier)?.sessionId?.() ?? null;
  return id === null ? null : { tier: servingTier, model: servingModel, id };
}

async function noteTickInConversation(input: {
  readonly snapshot: HermesSnapshot;
  readonly settings: BoardSettings;
  readonly result: HermesTickResult;
  readonly delta: string | null;
  readonly cardIdByThreadId: ReadonlyMap<string, string>;
  readonly backends: ReadonlyArray<Pick<HermesBackend, "tier" | "endSession" | "sessionId">>;
}): Promise<void> {
  const state = conversation;
  const { result } = input;
  if (!state || result.recordOnly) return;
  const at = result.ranAt;
  const calls = result.execution?.calls ?? [];
  // What this tick was asked about. It is what makes these turns evictable
  // later: they close when none of these cards is queued any more.
  const cards = [...queuedCardIds(input.snapshot.judgment ?? [])];
  if (result.mode === "conversation" && input.delta !== null && result.program !== null) {
    conversation = appendTurns(
      state,
      [
        {
          role: "user",
          kind: state.turns.length === 0 || state.resnapshot ? "snapshot" : "delta",
          content: input.delta,
          at,
          cards,
        },
        {
          role: "assistant",
          kind: "program",
          content: `\`\`\`js\n${result.program}\n\`\`\``,
          at,
          cards,
        },
        {
          role: "user",
          kind: "result",
          content: buildResultTurn({ calls, error: result.error }),
          at,
          cards,
        },
      ],
      boardDigestOf(input.snapshot),
    );
  } else if (result.mode === "stateless" && result.tier !== null) {
    // The digest stays put: the history has not seen this board state, so the
    // next conversational delta reports everything since the last one it did.
    conversation = appendTurns(state, [
      {
        role: "user",
        kind: "result",
        content: buildResultTurn({ calls, error: result.error, stateless: true }),
        at,
        cards,
      },
    ]);
  } else {
    return;
  }

  // The journal first: it is what makes eviction safe, so it must already hold
  // this tick's calls before any turn is dropped.
  const live = new Set(
    input.snapshot.cards.filter((card) => !card.archivedAt).map((card) => card.id as string),
  );
  conversation = {
    ...recordInputTokens(conversation, result.cost.usage?.inputTokens),
    journal: pruneJournal(
      appendJournal(
        conversation.journal,
        journalEntriesFromCalls({ calls, cardIdByThreadId: input.cardIdByThreadId, at }),
      ),
      live,
    ),
  };

  // The cards asked about this tick are still queued as far as this tick knows,
  // so only the backstop can fire here. The boundary cut happens on the next
  // quiet tick, via `settleHermesConversation`.
  const plan = planEviction({
    state: conversation,
    queuedCardIds: new Set(cards),
    ceilingTokens: ceilingForModel(
      input.settings.hermesContextCeilings,
      hermesModelId(input.settings),
    ),
  });
  if (plan) {
    const before = conversation.turns.length;
    conversation = applyEviction(conversation, plan, at);
    logEviction(plan, before, at);
  } else {
    conversation = { ...conversation, cliSession: servingCliSession(input.backends) };
  }
  writeHermesConversation(conversation);
  if (plan) await endHermesSessions(input.backends);
}

let lastSemanticFingerprint: string | null = null;
let lastSemanticAtMs: number | null = null;
const UNCHANGED_ACTIONABLE_RECHECK_MS = 15 * 60_000;

/** When the running loop expects to fire next; null when nothing is looping. */
let nextTickAt: string | null = null;

/** Threads seen on the last snapshot — the denominator for nudges per card. */
let lastThreadCount = 0;

/** In-repo degradation proxies the budget table reads. */
export function hermesTickHealth(): {
  ticks: number;
  failed: number;
  nudges: number;
  cardsWithThreads: number;
} {
  return {
    ticks: stats.ticks,
    failed: stats.failed,
    nudges: stats.nudges,
    cardsWithThreads: lastThreadCount,
  };
}

/**
 * Board-chip snapshot. Synchronous because the WS list handler cannot await
 * settings; the layer pushes the switch in whenever board settings change.
 */
let boardStatus: HermesBoardStatus = {
  enabled: false,
  running: false,
  busy: false,
  intervalMs: 60_000,
  model: HERMES_MODEL,
  lastHeartbeatAt: null,
  lastModelAt: null,
  lastSkipReason: null,
  lastSkipIsBoxBlock: false,
  lastBeatAt: null,
  lastSummary: null,
  lastTier: null,
  nextTickAt: null,
  lastError: null,
  providerError: null,
  consecutiveFailures: 0,
  pipelineIdle: false,
  cardActivity: [],
  cardWatch: [],
  nextModelCheckAt: null,
};

/** True from the moment a tick starts until it settles, however long that is. */
let tickInFlight = false;

/**
 * Hard wall clock for one locked tick. Provider backends already time out
 * (≈3m ACP/Codex), but recovery/list/helpers can hang without a bound — live
 * saw `busy: true` for an hour after a codex timeout with no further ticks.
 * When this fires the lock releases so the loop can schedule again, and the
 * live CLI session is ended so the orphaned `codex app-server` (wrapped in
 * `systemd-run … --scope`) cannot keep running under a released lock.
 */
// ACP open+prompt is 3m each; recovery and rules are cheap. Eight minutes is
// long enough for a real model turn and short enough that a hung CLI cannot
// park the board chip on "working" for an hour.
const DEFAULT_TICK_WALL_CLOCK_MS = 8 * 60_000;
let tickWallClockMs = DEFAULT_TICK_WALL_CLOCK_MS;
let tickLockGeneration = 0;
/** Epoch of the tick allowed to commit board/tick-log state; bumped on abandon. */
let tickCommitEpoch = 0;

/** Test seam: shrink the wall clock so abandon/cleanup can be asserted quickly. */
export function setHermesTickWallClockMsForTest(ms: number | null): void {
  tickWallClockMs = ms === null ? DEFAULT_TICK_WALL_CLOCK_MS : ms;
}

/** The last box check pass. Null until the loop has run one. */
let lastPreflight: HermesPreflightStatus | null = null;

/**
 * Run the box checks before Hermes is asked to spend anything.
 *
 * Every failure this catches is one the board would otherwise discover at the
 * most expensive moment: a card that ran to completion and then could not open
 * its pull request because the box has no authenticated forge CLI, no git
 * identity, or no writable disk. The underlying pass fixes what is safe to fix
 * and caches for 30s, so calling it per heartbeat costs nothing.
 *
 * `null` when the box is fit to work — including when no checks are wired.
 */
async function runBoxPreflight(deps: HermesBrainDeps): Promise<string | null> {
  if (!deps.preflight) return null;
  const block = await deps.preflight.check().catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { checkId: "preflight", detail: `the box checks could not run: ${detail}` };
  });
  lastPreflight = {
    ok: block === null,
    at: new Date().toISOString(),
    checkId: block?.checkId ?? null,
    detail: block?.detail ?? null,
  };
  return block === null
    ? null
    : `box check ${block.checkId} is failing: ${block.detail} — fix it in Settings → VPS`;
}

export class HermesTickInFlightError extends Error {
  constructor() {
    super("A Hermes heartbeat or semantic tick is already running.");
    this.name = "HermesTickInFlightError";
  }
}

async function withTickLock<A>(
  run: (tick: { readonly epoch: number; readonly ownsBoard: () => boolean }) => Promise<A>,
  options: {
    /** Kill the live Hermes CLI so an abandoned tick cannot keep app-servers. */
    readonly onWallClock?: () => void | Promise<void>;
  } = {},
): Promise<A> {
  if (tickInFlight) throw new HermesTickInFlightError();
  tickInFlight = true;
  const generation = ++tickLockGeneration;
  const epoch = ++tickCommitEpoch;
  const ownsBoard = () => tickCommitEpoch === epoch;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wallClockHit = false;
  const runPromise = run({ epoch, ownsBoard });
  try {
    return await Promise.race([
      runPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          wallClockHit = true;
          // Abandon this epoch before unlocking so a late ProcessExitedError
          // transcript cannot overwrite the wall-clock lastError, and so a
          // newer tick's in-flight flag stays intact.
          tickCommitEpoch += 1;
          tickLockGeneration += 1;
          tickInFlight = false;
          const detail = `Hermes tick exceeded ${Math.round(tickWallClockMs / 60_000)}m wall clock — lock released so the loop can recover`;
          void Promise.resolve(options.onWallClock?.())
            .catch(() => undefined)
            .finally(() => reject(new Error(detail)));
        }, tickWallClockMs);
      }),
    ]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (detail.includes("wall clock")) {
      boardStatus = {
        ...boardStatus,
        lastError: detail,
        consecutiveFailures: boardStatus.consecutiveFailures + 1,
        lastHeartbeatAt: new Date().toISOString(),
      };
      console.error(JSON.stringify({ evt: "hermes.tick.wall_clock", detail }));
    }
    throw cause;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (wallClockHit) {
      // Killing the CLI makes the orphaned run reject; do not surface that as
      // an unhandled rejection after the lock already moved on.
      void runPromise.catch(() => undefined);
    } else if (tickLockGeneration === generation) {
      tickInFlight = false;
    }
  }
}

export function hermesBoardStatus(): HermesBoardStatus {
  return {
    ...boardStatus,
    running: nextTickAt !== null || tickInFlight,
    busy: tickInFlight,
    nextTickAt,
    nextModelCheckAt:
      lastSemanticAtMs === null
        ? null
        : new Date(lastSemanticAtMs + UNCHANGED_ACTIONABLE_RECHECK_MS).toISOString(),
  };
}

export function setHermesBoardConfig(input: {
  enabled: boolean;
  intervalMs: number;
  model: string;
  pipelineIdle: boolean;
}): void {
  // Nothing refreshes the queue while the loop is off, so a kept watch would
  // freeze a card's status at whatever the last live tick thought.
  if (!input.enabled) cardWatch.clear();
  boardStatus = {
    ...boardStatus,
    ...input,
    ...(input.enabled ? {} : { cardWatch: [] }),
  };
}

const COLUMN_LABELS: Record<string, string> = {
  draft: "Draft",
  prompts: "Prompts",
  active: "Active",
  pr: "PR",
  done: "Done",
};

function updateVerb(args: Record<string, unknown>): string {
  const column = args["column"];
  if (typeof column === "string") return `moved to ${COLUMN_LABELS[column] ?? column}`;
  if (typeof args["body"] === "string" || typeof args["title"] === "string") return "structured";
  if (args["modelSelection"] !== undefined) return "picked a model";
  return "updated";
}

/**
 * What the tick did, card by card. This is the only honest answer to "did my
 * prompt land?" — the heartbeat summary counts actions, it does not name cards.
 */
export function collectCardActivity(
  tick: HermesTickTranscript,
  cardIdByThreadId: ReadonlyMap<string, string>,
): ReadonlyArray<HermesCardActivity> {
  const byCard = new Map<string, HermesCardActivity>();
  for (const call of tick.calls) {
    if (call.skipped === true) continue;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const id = typeof args["id"] === "string" ? args["id"] : null;
    const threadId = typeof args["threadId"] === "string" ? args["threadId"] : null;
    const cardId =
      call.method === "createCard"
        ? ((call.result as { id?: unknown } | null)?.id ?? null)
        : (id ?? (threadId === null ? null : (cardIdByThreadId.get(threadId) ?? null)));
    if (typeof cardId !== "string") continue;

    // A call whose result says "did not apply" (a refused merge, a conflicted
    // sync) must not become an "ok" receipt — that is how a card stuck on an
    // unmergeable PR wore a "Hermes merged" badge.
    const failure = boardCallFailure(call);
    const ok = failure === null;
    const action =
      call.method === "updateCard"
        ? updateVerb(args)
        : call.method === "createCard"
          ? "created"
          : call.method === "launchActive"
            ? "launched"
            : call.method === "openPr"
              ? "opened a PR"
              : call.method === "mergePr"
                ? ok
                  ? "merged"
                  : "merge the PR"
                : call.method === "syncPrBranch"
                  ? ok
                    ? "synced the PR branch"
                    : "sync the PR branch"
                  : call.method === "archiveCard"
                    ? "archived"
                    : call.method === "nudgeThread"
                      ? "nudged the agent"
                      : call.method === "answerPermission"
                        ? "answered a question"
                        : null;
    if (action === null) continue;
    byCard.set(cardId, { cardId, action, at: tick.ranAt, ok });
  }
  return [...byCard.values()];
}

/** Rolling per-card record of what Hermes last did, newest write wins. */
const cardActivity = new Map<string, HermesCardActivity>();
const CARD_ACTIVITY_LIMIT = 100;

function rememberCardActivity(entries: ReadonlyArray<HermesCardActivity>): void {
  for (const entry of entries) {
    cardActivity.delete(entry.cardId);
    cardActivity.set(entry.cardId, entry);
  }
  while (cardActivity.size > CARD_ACTIVITY_LIMIT) {
    const oldest = cardActivity.keys().next();
    if (oldest.done) break;
    cardActivity.delete(oldest.value);
  }
  boardStatus = { ...boardStatus, cardActivity: [...cardActivity.values()] };
}

/**
 * Cards the loop is still undecided about, and how many model looks each has
 * survived unchanged. Without this an Active card whose agent stopped is mute:
 * the queue re-offers it every recheck, the model declines to move it, and the
 * board shows a card that looks finished and never leaves the column.
 */
const cardWatch = new Map<string, HermesCardWatch>();

/** Fruitless looks per card, for the queue lines the model reads. */
export function hermesCardReviews(): ReadonlyMap<string, number> {
  return new Map([...cardWatch].map(([cardId, watch]) => [cardId, watch.reviews]));
}

/**
 * Rebuilt from the queue every heartbeat, so a card that left it is dropped.
 * `judged` is true only for a tick that actually asked a model: a look counts
 * against a card when it survived one and nothing on the board moved for it.
 */
function syncCardWatch(input: {
  readonly queue: ReadonlyArray<JudgmentItem>;
  readonly judged: boolean;
  readonly judgedCardIds?: ReadonlySet<string>;
  readonly atIso: string;
  readonly movedCardIds?: ReadonlySet<string>;
}): void {
  const next = new Map<string, HermesCardWatch>();
  for (const item of input.queue) {
    const cardId = item.cardId;
    if (cardId === null) continue;
    const previous = cardWatch.get(cardId);
    const moved = input.movedCardIds?.has(cardId) === true;
    const judged =
      input.judged && (input.judgedCardIds === undefined || input.judgedCardIds.has(cardId));
    const reviews = moved ? 0 : (previous?.reviews ?? 0) + (judged ? 1 : 0);
    const lastReviewAt = judged ? input.atIso : (previous?.lastReviewAt ?? null);
    next.set(cardId, {
      cardId,
      kind: item.kind,
      why: item.why,
      reviews,
      // A card Hermes just moved starts its clock over: it is queued again for
      // the next step, not parked on the one that never happened.
      sinceAt: moved ? input.atIso : (previous?.sinceAt ?? input.atIso),
      lastReviewAt: moved ? null : lastReviewAt,
      stalled: reviews >= STALLED_REVIEWS,
    });
  }
  cardWatch.clear();
  for (const [cardId, watch] of next) cardWatch.set(cardId, watch);
  boardStatus = { ...boardStatus, cardWatch: [...cardWatch.values()] };
}

/** A beat from a tick, or from an agent calling `board.heartbeat`. */
export function recordHermesBeat(input: {
  summary: string;
  beatAtIso: string;
  tier?: HermesTier | null;
}): HermesBoardStatus {
  const summary = input.summary.trim();
  boardStatus = {
    ...boardStatus,
    lastBeatAt: input.beatAtIso,
    lastSummary: summary.length > 0 ? summary.slice(0, 240) : "beat",
    lastTier: input.tier ?? boardStatus.lastTier,
  };
  return hermesBoardStatus();
}

export function lastHermesTick(): HermesTickTranscript | null {
  return lastTick;
}

/** Full transcript by id, for the settings log's expand-a-row fetch. */
export function hermesTickById(id: string): HermesTickTranscript | null {
  return history.find((tick) => tick.id === id) ?? null;
}

/** Board-mutating calls that actually landed. `list`/`heartbeat` are reads. */
function writeCount(tick: HermesTickTranscript): number {
  return tick.calls.filter(
    (call) =>
      BOARD_WRITE_METHODS.has(call.method) && call.error === undefined && call.skipped !== true,
  ).length;
}

function toLogEntry(tick: HermesTickTranscript): HermesTickLogEntry {
  return {
    id: tick.id,
    ranAt: tick.ranAt,
    durationMs: tick.durationMs,
    tier: tick.tier,
    model: tick.model,
    summary: tick.summary,
    error: tick.error,
    recordOnly: tick.recordOnly,
    ...(tick.trigger === undefined ? {} : { trigger: tick.trigger }),
    ...(tick.wakeReason === undefined ? {} : { wakeReason: tick.wakeReason }),
    callCount: tick.calls.length,
    writeCount: writeCount(tick),
    ...(tick.modelSkipped === undefined ? {} : { modelSkipped: tick.modelSkipped }),
    ...(tick.ruleActions === undefined ? {} : { ruleActions: tick.ruleActions }),
    attempts: tick.attempts,
    ...(tick.cost === undefined ? {} : { cost: tick.cost }),
  };
}

/** One structured line per tick into journald — `journalctl -u t3j -g hermes.tick`. */
function logTick(tick: HermesTickTranscript): void {
  console.log(
    JSON.stringify({
      evt: "hermes.tick",
      id: tick.id,
      ranAt: tick.ranAt,
      durationMs: tick.durationMs,
      tier: tick.tier,
      model: tick.model,
      recordOnly: tick.recordOnly,
      trigger: tick.trigger ?? "interval",
      ...(tick.wakeReason === undefined ? {} : { wakeReason: tick.wakeReason }),
      calls: tick.calls.length,
      writes: writeCount(tick),
      summary: tick.summary,
      ...(tick.cost
        ? {
            modelCalls: tick.cost.modelCalls,
            modelMs: tick.cost.modelMs,
            executionMs: tick.cost.executionMs,
            promptChars: tick.cost.promptChars,
            snapshotChars: tick.cost.snapshotChars,
            programChars: tick.cost.programChars,
            ...(tick.cost.historyTokens === undefined
              ? {}
              : { historyTokens: tick.cost.historyTokens, deltaTokens: tick.cost.deltaTokens }),
            inputTokens: tick.cost.usage?.inputTokens ?? null,
            cachedInputTokens: tick.cost.usage?.cachedInputTokens ?? null,
            outputTokens: tick.cost.usage?.outputTokens ?? null,
            usd: tick.cost.usage?.usd ?? null,
            ...(tick.cost.usage?.generationId === undefined
              ? {}
              : { generationId: tick.cost.usage.generationId }),
          }
        : {}),
      ...(tick.budget
        ? {
            plannedTasks: tick.budget.plannedTasks,
            estimatedInputTokens: tick.budget.estimate.chargedInputTokens,
            actualInputTokens: tick.budget.actual?.chargedInputTokens ?? null,
            driftPercent: tick.budget.driftPercent,
          }
        : {}),
      ...(tick.error === null ? {} : { error: tick.error }),
      attempts: tick.attempts.map((attempt) => `${attempt.tier}:${attempt.outcome}`),
    }),
  );
}

/** Rehydrate the in-memory log from disk so a restart does not blind the panel. */
export function restoreHermesTickLog(): void {
  const restored = readHermesTickLog(LOG_LIMIT);
  if (restored.length === 0) return;
  history.length = 0;
  history.push(...[...restored].reverse());
  const newestReal = history.find((tick) => !tick.recordOnly);
  lastTick = newestReal ?? null;
  if (newestReal) {
    const parsed = Date.parse(newestReal.ranAt);
    lastSemanticAtMs = Number.isFinite(parsed) ? parsed : null;
    boardStatus = { ...boardStatus, lastModelAt: newestReal.ranAt };
  }
  const seq = history
    .map((tick) => Number.parseInt(tick.id.replace(/^tick-/, ""), 10))
    .filter((value) => Number.isFinite(value));
  tickSeq = seq.length > 0 ? Math.max(...seq) : 0;
}

function record(
  tick: HermesTickTranscript,
  options: { readonly keepInLog?: boolean; readonly ownsBoard?: () => boolean } = {},
): void {
  // A wall-clock-abandoned tick must not overwrite lastError / the tick log
  // with the ProcessExitedError that killing its CLI produced.
  if (options.ownsBoard && !options.ownsBoard()) return;
  const keepInLog = options.keepInLog !== false;
  if (keepInLog) {
    history.unshift(tick);
    if (history.length > LOG_LIMIT) history.length = LOG_LIMIT;
  }
  logTick(tick);
  if (keepInLog) appendHermesTick(tick, LOG_LIMIT);
  if (tick.recordOnly) return;
  lastTick = tick;
  stats.ticks += 1;
  if (tick.error) stats.failed += 1;
  if (tick.modelSkipped === true) stats.modelSkipped += 1;
  stats.ruleWrites += tick.ruleActions ?? 0;
  stats.writes += writeCount(tick);
  if (tick.tier) stats.servedByTier.set(tick.tier, (stats.servedByTier.get(tick.tier) ?? 0) + 1);
  stats.spend = addSpend(stats.spend, tick);
  // Every tick, quiet ones included: a rules-only tick costing nothing is the
  // measurement that makes the expensive ones mean something.
  appendHermesUsage(toUsageRow(tick, BOARD_WRITE_METHODS));
  persistStats();
}

function snapshotStats(): HermesBrainStats {
  return {
    since: stats.since,
    heartbeats: stats.heartbeats,
    skipped: stats.skipped,
    ticks: stats.ticks,
    failed: stats.failed,
    writes: stats.writes,
    nudges: stats.nudges,
    modelSkipped: stats.modelSkipped,
    ruleWrites: stats.ruleWrites,
    rules: [...stats.ruleFires].map(([rule, fire]) => ({
      rule,
      fired: fire.count,
      lastFiredAt: fire.lastAt,
    })),
    servedByTier: HERMES_TIERS.map((tier) => ({
      tier,
      served: stats.servedByTier.get(tier) ?? 0,
    })),
    spend: stats.spend,
    usageLogPath: hermesUsageLogPath(),
  };
}

function toTranscript(result: HermesTickResult): HermesTickTranscript {
  tickSeq += 1;
  return {
    id: `tick-${tickSeq}`,
    ranAt: result.ranAt,
    durationMs: result.durationMs,
    model: result.model,
    tier: result.tier,
    attempts: result.attempts.map((attempt) => ({
      tier: attempt.tier,
      outcome: attempt.outcome,
      detail: attempt.detail,
      durationMs: attempt.durationMs,
      ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
    })),
    program: result.program,
    calls: (result.execution?.calls ?? []).map(toTranscriptCall),
    logs: [...(result.execution?.logs ?? [])],
    summary: result.summary,
    error: result.error,
    recordOnly: result.recordOnly,
    cost: result.cost,
  };
}

/**
 * Transcript entries a stopped thread carries into the prompt. Enough to hold
 * an exchange — the ask, the answer, and what came before it.
 */
const THREAD_TAIL_ENTRIES = 6;

/** Earlier tail entries, where only the gist is wanted. */
const TAIL_ENTRY_CHARS = 600;

/**
 * The agent's last word, in full. Judging a stopped thread means reading what
 * it actually said, and a closing clipped to a couple of sentences is where
 * the decision — the question it asked, the fork it named — gets cut off. Only
 * the newest entry gets this; the ones before it are context and stay clipped.
 */
const CLOSING_CHARS = 4000;

const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text;

/**
 * The tail of a stopped thread, newest entry verbatim. Line breaks survive in
 * that one: a closing is a written answer, and flattening a list of options
 * into one paragraph is how a fork stops reading as a fork.
 */
function threadTail(
  entries: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): ReadonlyArray<string> {
  return entries.map((entry, index) =>
    index === entries.length - 1
      ? `${entry.role}: ${clip(entry.text.trim(), CLOSING_CHARS)}`
      : `${entry.role}: ${clip(flatten(entry.text), TAIL_ENTRY_CHARS)}`,
  );
}

/** Read everything one prompt needs, in parallel, before spending a token. */
export async function collectSnapshot(
  api: BoardApi,
  settings: BoardSettings,
): Promise<HermesSnapshot> {
  const [cards, projects, models, pendingInputs, canvas, inbox] = await Promise.all([
    api.list(),
    api.listProjects(),
    api.listModels(),
    api.pendingInputs(),
    api.canvasDigest().catch(() => null),
    api.canvasInbox().catch(() => []),
  ]);

  const activeWithThreads = cards.filter((card) => card.at === "active" && card.threadId);
  const cardsWithThreads = cards.filter(
    (card) => card.threadId && card.at !== "done" && card.archivedAt === null,
  );
  const reports = (
    await Promise.all(
      activeWithThreads.map(async (card) => {
        const threadId = String(card.threadId);
        const report = await api.threadReport({ threadId });
        if (!report) return null;
        const parsed = parseAgentReport(report.text);
        return {
          cardId: card.id as string,
          threadId,
          done: parsed.done,
          remaining: parsed.remaining,
          blocked: parsed.blocked,
          nudges: nudgeCounts.get(threadId) ?? 0,
        };
      }),
    )
  ).filter((report): report is NonNullable<typeof report> => report !== null);

  // Liveness for every threaded card, report or not: a card with no closing
  // report is exactly the one that looks invisible and sits there for days.
  const threads = (
    await Promise.all(
      cardsWithThreads.map(async (card) => {
        const threadId = String(card.threadId);
        const transcript = await api.threadTranscript({ threadId, limit: THREAD_TAIL_ENTRIES });
        if (!transcript) return null;
        const last = transcript.entries[transcript.entries.length - 1];
        // A stopped thread is what [review] judges, so it carries a real tail;
        // a running one only needs to look alive.
        const stopped = !transcript.exists || transcript.turnState !== "running";
        const tail = stopped ? threadTail(transcript.entries) : [];
        return {
          cardId: card.id as string,
          threadId,
          exists: transcript.exists,
          turnState: transcript.turnState,
          idleForMs: transcript.idleForMs,
          messageCount: transcript.messageCount,
          lastLine: last ? `${last.role}: ${last.text.slice(0, 240)}` : null,
          ...(tail.length > 0 ? { tail } : {}),
        };
      }),
    )
  ).filter((thread): thread is NonNullable<typeof thread> => thread !== null);

  lastThreadCount = threads.length;

  const helpers = liveHermesHelpers();

  return {
    cards,
    projects,
    models,
    pendingInputs,
    policy: { ...hermesBoardPolicy(settings), maxNudgesPerCard: settings.hermesBrainMaxNudges },
    boardRules: describeComponents(boardComponentIds(cards), {
      settings,
      policy: {
        finishActive: rulePolicy(settings).autoFinishActive,
        mergeWhenGreen: rulePolicy(settings).autoMergeWhenGreen,
        conflictReturn: rulePolicy(settings).conflictReturn,
      },
    }),
    reports,
    threads,
    ...(helpers.length > 0 ? { helpers } : {}),
    ...(inbox.length > 0
      ? {
          canvasMessages: inbox.map((message) => ({
            id: message.id,
            authorKind: message.authorKind,
            authorId: message.authorId,
            text: message.text,
            hasImage: message.image !== null,
          })),
        }
      : {}),
  };
}

function semanticReason(snapshot: HermesSnapshot): string | null {
  if (snapshot.pendingInputs.length > 0) return "A coding thread is waiting for an answer.";
  if ((snapshot.helpers ?? []).some((helper) => helper.status !== "running" && !helper.delivered)) {
    return "A helper thread came back with an answer.";
  }
  if (snapshot.canvasMessages && snapshot.canvasMessages.length > 0) {
    return "A canvas message is addressed to Hermes.";
  }

  const policy = snapshot.policy as {
    structureDrafts?: boolean;
    autoLaunch?: boolean;
  };
  if (
    snapshot.cards.some(
      (card) =>
        card.at === "prompts" &&
        (card.prepStatus === "untouched" ||
          card.prepStatus === "failed" ||
          card.prepStatus === null ||
          card.prepStatus === undefined) &&
        card.body.trim().length > 0,
    ) &&
    policy.structureDrafts === true
  ) {
    return "A Prompt needs structuring.";
  }
  if (
    policy.autoLaunch === true &&
    snapshot.cards.some(
      (card) => card.at === "prompts" && card.prepStatus === "ready" && card.body.trim().length > 0,
    )
  ) {
    return "A Prompt is ready for launch.";
  }
  if (snapshot.reports.length > 0) return "A coding agent has a report to process.";
  if (
    snapshot.threads.some(
      (thread) =>
        snapshot.cards.some((card) => card.id === thread.cardId && card.at === "active") &&
        (!thread.exists || thread.turnState !== "running"),
    )
  ) {
    return "An Active coding thread stopped or disappeared.";
  }
  if (snapshot.cards.some((card) => card.at === "pr")) {
    return "A pull request card needs reconciliation.";
  }
  return null;
}

/** Card-only fingerprint for the rule pass's operation coordinator, which runs before a full `HermesSnapshot` exists this tick. */
function cardsFingerprint(cards: ReadonlyArray<KanbanCard>): string {
  const stable = cards.map(({ hermesOperation: _hermesOperation, ...card }) => card);
  return NodeCrypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function cardFingerprints(cards: ReadonlyArray<KanbanCard>): ReadonlyMap<string, string> {
  return new Map(
    cards.map(
      ({ hermesOperation: _hermesOperation, ...card }) =>
        [
          String(card.id),
          NodeCrypto.createHash("sha256").update(JSON.stringify(card)).digest("hex"),
        ] as const,
    ),
  );
}

function semanticFingerprint(snapshot: HermesSnapshot): string {
  const stable = {
    cards: snapshot.cards.map(({ hermesOperation: _hermesOperation, ...card }) => card),
    projects: snapshot.projects,
    models: snapshot.models,
    pendingInputs: snapshot.pendingInputs,
    policy: snapshot.policy,
    boardRules: snapshot.boardRules,
    reports: snapshot.reports,
    threads: snapshot.threads.map(({ idleForMs: _idleForMs, ...thread }) => thread),
    // Ids only. A picture's bytes never reach a fingerprint, and the caption
    // cannot change once posted, so the id is the whole of what moved.
    canvasMessages: (snapshot.canvasMessages ?? []).map((message) => message.id),
    // Status, not elapsed time: a helper that is still running must not make
    // every heartbeat look like new work.
    helpers: (snapshot.helpers ?? []).map((helper) => `${helper.id}:${helper.status}`),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export type HermesHeartbeatDecision = {
  readonly runModel: boolean;
  readonly reason: string;
  readonly fingerprint: string | null;
};

export function decideHermesHeartbeat(
  snapshot: HermesSnapshot,
  nowMs = wallClockMs(),
): HermesHeartbeatDecision {
  const reason = semanticReason(snapshot);
  if (reason === null) {
    return {
      runModel: false,
      reason: "No actionable cards or pending questions.",
      fingerprint: null,
    };
  }

  const fingerprint = semanticFingerprint(snapshot);
  const unchanged = fingerprint === lastSemanticFingerprint;
  const recheckDue =
    lastSemanticAtMs === null || nowMs - lastSemanticAtMs >= UNCHANGED_ACTIONABLE_RECHECK_MS;
  // PR cards left after the rule pass must not sit in green "model skipped"
  // forever — force a model tick so something can merge, sync, or escalate.
  if (
    shouldForceModelForPrStuck({
      semanticReason: reason,
      fingerprintUnchanged: unchanged,
      recheckDue,
      rulesSettledWithoutClearingPr: unchanged && snapshot.cards.some((c) => c.at === "pr"),
    })
  ) {
    return {
      runModel: true,
      reason: `${reason} Rules did not clear it — model must decide.`,
      fingerprint,
    };
  }
  if (unchanged && !recheckDue) {
    return {
      runModel: false,
      reason: `No actionable change. ${reason}`,
      fingerprint,
    };
  }
  return { runModel: true, reason, fingerprint };
}

function recordNudges(result: HermesTickResult): void {
  if (result.recordOnly) return;
  for (const call of result.execution?.calls ?? []) {
    if (call.method !== "nudgeThread" || call.error !== undefined) continue;
    const threadId = (call.args as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string") continue;
    nudgeCounts.set(threadId, (nudgeCounts.get(threadId) ?? 0) + 1);
    stats.nudges += 1;
  }
}

const MIN_STUCK_PREP_MS = 30_000;

function cardAgeMs(card: KanbanCard, nowMs: number): number {
  const updatedAt = (card as { updatedAt?: unknown }).updatedAt;
  const parsed = Date.parse(typeof updatedAt === "string" ? updatedAt : "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

/** The rules get their own budget; a program's cap is untouched by them. */
const RULE_CALL_LIMIT = 96;

export type HermesRulePassOutcome = {
  readonly logs: ReadonlyArray<string>;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly actions: number;
  readonly conflicts: ReadonlyArray<{ readonly cardId: string; readonly reason: string }>;
  readonly durationMs: number;
};

/**
 * The deterministic pass, before a token is spent. Supersedes the old recovery
 * pass: it still unsticks drafts and requeues thread-less Active cards, and it
 * also makes the moves the policies already decided. Writes go through a
 * recorder, so they land in the same transcript — and the same card receipts —
 * as a program's.
 */
export async function runRecoveryPass(
  deps: Pick<HermesBrainDeps, "api" | "operations">,
  settings: BoardSettings,
  options: { readonly recordOnly?: boolean } = {},
): Promise<HermesRulePassOutcome> {
  const { api } = deps;
  const recordOnly = options.recordOnly === true;
  const startedMs = wallClockMs();
  const calls: BoardCallRecord[] = [];
  // A rule's own writes (openPr above all) must not retry every heartbeat
  // forever: without a coordinator here, a refused PR looped at full tick
  // speed with no backoff. The fingerprint is card-only and taken before any
  // rule runs, since the full snapshot this tick will ask a model with does
  // not exist yet.
  const preRuleCards = await api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  const operations = deps.operations
    ? makeHermesOperationCoordinator({
        store: deps.operations,
        semanticFingerprint: cardsFingerprint(preRuleCards),
        cardFingerprints: cardFingerprints(preRuleCards),
        cardIdByThreadId: new Map(
          preRuleCards
            .filter((card) => card.threadId)
            .map((card) => [String(card.threadId), card.id as string]),
        ),
        leaseOwner: `hermes-rules:${process.pid}:${wallClockMs()}`,
      })
    : undefined;
  const recorder = makeBoardRecorder({
    api,
    recordOnly,
    maxCalls: RULE_CALL_LIMIT,
    calls,
    ...(operations ? { operations } : {}),
  });
  const rules = await runRulePass({ api: recorder.api, settings, recordOnly }).catch(
    (cause: unknown) => ({
      actions: [],
      logs: [`rules failed: ${cause instanceof Error ? cause.message : String(cause)}`],
      conflicts: [],
      holds: [],
    }),
  );
  // Reading a helper's answer is deterministic, so it belongs here rather than
  // in a program: the loop should never spend a model call to notice one came
  // back. A dry run leaves helpers alone — settling one is a real write.
  const helpers = recordOnly
    ? { settled: [], logs: [] }
    : await collectHermesHelpers({
        api: recorder.api,
        helpers: runningHermesHelpers(),
        timeoutMs: rulePolicy(settings).helpers.timeoutMs,
      }).catch((cause: unknown) => ({
        settled: [],
        logs: [`helpers failed: ${cause instanceof Error ? cause.message : String(cause)}`],
      }));
  // A dry run is not a firing: the counter has to mean "this rule moved the
  // board", or the rules dialog reports work nobody did.
  if (!recordOnly) {
    for (const action of rules.actions) {
      if (action.ok) recordRuleFire(action.rule);
    }
    persistStats();
  }
  return {
    logs: [...rules.logs, ...helpers.logs],
    calls,
    actions: rules.actions.filter((action) => action.ok).length,
    conflicts: rules.conflicts,
    durationMs: Math.max(0, wallClockMs() - startedMs),
  };
}

function toTranscriptCall(call: BoardCallRecord): HermesTickTranscript["calls"][number] {
  return {
    method: call.method,
    args: call.args,
    ...(call.result === undefined ? {} : { result: call.result }),
    ...(call.error === undefined ? {} : { error: call.error }),
    ...(call.skipped === undefined ? {} : { skipped: call.skipped }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
  };
}

/**
 * A tick the rules settled on their own. It is a first-class row in the log —
 * same transcript shape, no tier, no program — so "Hermes did nothing" and
 * "Hermes had nothing to decide" never look alike.
 */
function recordSkippedTick(input: {
  readonly snapshot: HermesSnapshot;
  readonly settings: BoardSettings;
  readonly rules: HermesRulePassOutcome;
  readonly recordOnly: boolean;
  readonly trigger?: HermesTickTrigger;
  readonly wakeReason?: string;
  readonly ownsBoard?: () => boolean;
}): HermesTickTranscript {
  tickSeq += 1;
  const ranAt = new Date().toISOString();
  const summary = summarize({
    snapshot: input.snapshot,
    execution: null,
    tier: null,
    error: null,
    ruleActions: input.rules.actions,
    modelSkipped: true,
  });
  const conflictLogs = input.rules.conflicts.map(
    (conflict) => `needs you: ${conflict.cardId} — ${conflict.reason}`,
  );
  const transcript: HermesTickTranscript = {
    id: `tick-${tickSeq}`,
    ranAt,
    durationMs: input.rules.durationMs,
    model: input.settings.hermesBrainModel.trim() || HERMES_MODEL,
    tier: null,
    attempts: [],
    program: null,
    calls: input.rules.calls.map(toTranscriptCall),
    logs: [...input.rules.logs, ...conflictLogs],
    summary,
    error: null,
    recordOnly: input.recordOnly,
    modelSkipped: true,
    ruleActions: input.rules.actions,
    trigger: input.trigger ?? "manual",
    ...(input.wakeReason === undefined ? {} : { wakeReason: input.wakeReason }),
    // A free tick is still a measurement — it is the denominator that says how
    // often the rules kept the model out of it.
    cost: {
      promptChars: 0,
      snapshotChars: 0,
      programChars: 0,
      modelCalls: 0,
      modelMs: 0,
      executionMs: input.rules.durationMs,
    },
  };
  const quiet = input.rules.actions === 0 && input.rules.conflicts.length === 0;
  const ownsBoard = input.ownsBoard ?? (() => true);
  record(transcript, { keepInLog: !quiet || input.recordOnly, ownsBoard });
  if (!ownsBoard()) return transcript;
  if (!transcript.recordOnly) {
    appendHermesChat(
      hermesRuleChatTurn({
        at: ranAt,
        tickId: transcript.id,
        calls: input.rules.calls,
        logs: conflictLogs,
        actions: input.rules.actions,
      }),
    );
    const cardIdByThreadId = new Map(
      input.snapshot.cards
        .filter((card) => card.threadId)
        .map((card) => [String(card.threadId), card.id as string]),
    );
    rememberCardActivity(collectCardActivity(transcript, cardIdByThreadId));
    boardStatus = { ...boardStatus, lastError: null, consecutiveFailures: 0 };
    recordHermesBeat({ summary, beatAtIso: ranAt, tier: null });
  }
  return transcript;
}

/** Recorded ticks scanned to answer "what did you do to this card". */
const CARD_HISTORY_SCAN = 120;

/**
 * The record for a card someone asked about, and only that card: every other
 * queue item is answered by the live board, and history nobody asked for is
 * prompt paid for on every tick.
 */
function cardHistoryForQueue(
  queue: ReadonlyArray<JudgmentItem>,
  cards: ReadonlyArray<KanbanCard>,
): ReturnType<typeof collectCardHistory> {
  const asked = new Set(
    queue
      .filter((item) => item.kind === "message")
      .map((item) => item.cardId)
      .filter((cardId): cardId is string => cardId !== null),
  );
  if (asked.size === 0) return [];
  const logged = readHermesTickLog(CARD_HISTORY_SCAN);
  return collectCardHistory({
    ticks: logged.length > 0 ? logged : history,
    cardIds: asked,
    cards,
  });
}

async function markStructureCardsFailed(
  api: BoardApi,
  cardIds: ReadonlyArray<string>,
): Promise<void> {
  await Promise.all(
    cardIds.map((id) => api.updateCard({ id, prepStatus: "failed" }).catch(() => undefined)),
  );
}

/**
 * After a structure claim, any card still at prep=processing did not land
 * ready — mark failed so the face is "Failed · Structuring", not a lie.
 */
async function markUnfinishedStructureFailed(input: {
  readonly api: BoardApi;
  readonly structureCardIds: ReadonlyArray<string>;
  readonly result: HermesTickResult;
}): Promise<void> {
  const cards = await input.api.list().catch(() => [] as ReadonlyArray<KanbanCard>);
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const fail: string[] = [];
  for (const id of input.structureCardIds) {
    const card = byId.get(id);
    if (!card || card.at !== "prompts") continue;
    if (card.prepStatus === "ready") continue;
    if (card.prepStatus !== "processing") continue;
    // A successful structure write should have set ready. If it did not, the
    // still-processing card must fail rather than remain claimed forever.
    fail.push(id);
  }
  // Transport/program death with no writes: fail every claimed structure card.
  if (input.result.error !== null || input.result.execution === null) {
    for (const id of input.structureCardIds) {
      const card = byId.get(id);
      if (card?.at === "prompts" && card.prepStatus === "processing") fail.push(id);
    }
  }
  await markStructureCardsFailed(input.api, [...new Set(fail)]);
}

async function runPreparedTick(
  deps: HermesBrainDeps,
  settings: BoardSettings,
  snapshot: HermesSnapshot,
  rules: HermesRulePassOutcome,
  options: {
    readonly recordOnly?: boolean;
    readonly judgment?: ReadonlyArray<JudgmentItem>;
    readonly trigger?: HermesTickTrigger;
    readonly wakeReason?: string;
    /** False after wall-clock abandon — suppress tick-log / board commits. */
    readonly ownsBoard?: () => boolean;
  } = {},
): Promise<HermesTickTranscript> {
  const ownsBoard = options.ownsBoard ?? (() => true);
  // The board may have work the rules already settled. Asking a tier here buys
  // a program that re-derives what they just did and calls it a tick.
  const pendingQueue =
    options.judgment ?? judgmentQueue({ snapshot, settings, reviewsByCardId: hermesCardReviews() });
  const queue = modelJudgmentQueue(pendingQueue, hermesCardReviews());
  if (queue.length === 0) {
    if (options.recordOnly !== true && ownsBoard()) {
      syncCardWatch({ queue: pendingQueue, judged: false, atIso: new Date().toISOString() });
    }
    // Nothing is mid-decision: the boundary the history should be cut at.
    if (options.recordOnly !== true && ownsBoard()) {
      await settleHermesConversation(queue, settings, deps.backends);
    }
    const skipped = recordSkippedTick({
      snapshot,
      settings,
      rules,
      recordOnly: options.recordOnly === true,
      ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
      ...(options.wakeReason === undefined ? {} : { wakeReason: options.wakeReason }),
      ownsBoard,
    });
    if (ownsBoard()) await runSelfHeal(deps.api, skipped);
    return skipped;
  }

  const semantic = semanticFingerprint(snapshot);
  const cardIdByThreadId = new Map(
    snapshot.cards
      .filter((card) => card.threadId)
      .map((card) => [String(card.threadId), card.id as string]),
  );
  const operations = deps.operations
    ? makeHermesOperationCoordinator({
        store: deps.operations,
        semanticFingerprint: semantic,
        cardFingerprints: cardFingerprints(snapshot.cards),
        cardIdByThreadId,
        leaseOwner: `hermes:${process.pid}:${wallClockMs()}`,
      })
    : undefined;
  const failures = repeatedBoardFailures();
  const papercuts = promptPapercuts();
  const knowledge = promptKnowledge();
  const cardHistory = cardHistoryForQueue(queue, snapshot.cards);
  // A real tick joins the conversation; a dry run reads it without touching it.
  if (options.recordOnly !== true && conversation === null) {
    conversation = emptyHermesConversation({ startedAt: new Date().toISOString() });
  }
  const convo = conversation;
  const routedCards = queue
    .filter((item) => item.kind === "structure" || item.kind === "route")
    .map((item) => snapshot.cards.find((card) => card.id === item.cardId))
    .filter((card): card is KanbanCard => card !== undefined);
  const routingBriefs = routedCards.map((card) =>
    buildRoutingBrief({
      card,
      projects: snapshot.projects,
      models: snapshot.models.map((model) => ({
        ...model,
        selection: {
          ...model.selection,
          options: model.selection.options ?? [],
        },
        note: model.note ?? "",
        options: model.options ?? "",
        meteredPrice: model.meteredPrice ?? null,
        taskCost: model.taskCost ?? {
          relative: null,
          usdPerTask: null,
          msPerTask: null,
          basis: "unknown" as const,
          taskCount: 0,
          detail: "no turns observed on this route",
        },
        optionChoices: model.optionChoices ?? [],
      })),
      threads: snapshot.threads.map((thread) => {
        const owner = snapshot.cards.find((candidate) => candidate.id === thread.cardId);
        const selection = owner?.modelSelection;
        return {
          cardId: thread.cardId,
          threadId: thread.threadId,
          title: owner?.title ?? "Untitled thread",
          summary: thread.lastLine ?? `${thread.turnState}; ${thread.messageCount} messages`,
          projectId: owner?.projectId ?? null,
          contextUsedPercent: null,
          compatibleRouteIds: selection
            ? [`${String(selection.instanceId)}/${selection.model}`]
            : [],
        };
      }),
      cards: snapshot.cards,
      // Per-route owner rules already live beside each route; do not send a
      // duplicate policy copy in the same brief.
      naturalLanguageRules: [],
      rosterEnforced: settings.modelRosterEnforced === true,
    }),
  );

  const asked: HermesSnapshot = {
    ...snapshot,
    ...(routingBriefs.length > 0 ? { routingBriefs } : {}),
    judgment: queue,
    ruleLog: rules.logs,
    ...(convo && convo.journal.length > 0 ? { journal: convo.journal } : {}),
    ...(cardHistory.length > 0 ? { cardHistory } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ...(papercuts.length > 0 ? { papercuts } : {}),
    ...(knowledge.length > 0 ? { knowledge } : {}),
  };
  // After an eviction no retained turn carries the board state a delta would
  // diff against, so the snapshot is re-derived from the database instead.
  const delta = convo
    ? convo.turns.length === 0 || convo.resnapshot
      ? buildHermesSnapshotBlock(asked)
      : buildHermesDeltaBlock(asked, convo.boardDigest)
    : null;
  // Bytes are fetched only when a caption said there are some, and only here:
  // the snapshot and the tick transcript carry the caption, never the picture.
  const pictured = (asked.canvasMessages ?? []).filter((message) => message.hasImage);
  const canvasImages =
    pictured.length === 0
      ? []
      : (await deps.api.canvasInbox({ includeImages: true }).catch(() => []))
          .filter((message) => message.image !== null)
          .map((message) => ({
            mediaType: message.image?.mediaType ?? "image/png",
            data: message.image?.data ?? "",
          }))
          .filter((image) => image.data.length > 0);
  const cardImages =
    deps.attachmentsDir && asked.cards.some((card) => (card.attachments ?? []).length > 0)
      ? asked.cards.flatMap((card) =>
          hermesImagesFromCardAttachments({
            attachmentsDir: deps.attachmentsDir!,
            attachments: card.attachments ?? [],
          }),
        )
      : [];
  const images = [...canvasImages, ...cardImages];

  const transport = await hermesTransport(deps, settings);
  // A changed selection is a changed brain: whatever the old transport was
  // still holding is history this tick is not entitled to.
  if (transport.tier !== servingTier) {
    await endHermesSessions(deps.backends.filter((backend) => backend.tier !== transport.tier));
    servingTier = transport.tier;
  }
  const tierModel =
    transport.tier === null ? transport.model : tierModelId(transport.tier, transport.model);
  servingModel = tierModel;

  // Structure state machine: only claim "Structuring" once Hermes is about to
  // spend a model tick on these cards (not on every submit).
  const structureCardIds = queue
    .filter((item) => item.kind === "structure" && item.cardId)
    .map((item) => item.cardId as string);
  if (options.recordOnly !== true && structureCardIds.length > 0) {
    await Promise.all(
      structureCardIds.map((id) =>
        deps.api.updateCard({ id, prepStatus: "processing" }).catch(() => undefined),
      ),
    );
  }

  let result: HermesTickResult;
  try {
    result = await runHermesTick({
      api: deps.api,
      snapshot: asked,
      policy: rulePolicy(settings),
      backends: deps.backends,
      provider: transport.tier,
      ...(transport.reason === null ? {} : { providerError: transport.reason }),
      model: tierModel,
      ...(options.recordOnly === true ? { recordOnly: true } : {}),
      ...(operations ? { operations } : {}),
      ...(routingBriefs.length > 0
        ? { routingBriefs: new Map(routingBriefs.map((brief) => [brief.cardId, brief])) }
        : {}),
      ...(convo && delta !== null
        ? {
            conversation: {
              history: assembleHistory(convo),
              delta,
              ...(images.length > 0 ? { images } : {}),
            },
          }
        : {}),
    });
  } catch (cause) {
    if (options.recordOnly !== true && structureCardIds.length > 0) {
      await markStructureCardsFailed(deps.api, structureCardIds);
    }
    throw cause;
  }

  // Fail loud: if structure was claimed but this tick never landed ready
  // (timeout, empty program, refuse), mark failed so the badge is not eternal
  // "Queued · Structuring" and the next judgment can retry.
  if (options.recordOnly !== true && structureCardIds.length > 0) {
    await markUnfinishedStructureFailed({
      api: deps.api,
      structureCardIds,
      result,
    });
  }

  // Delivered once the turn that carried them actually ran. A dry run leaves
  // them in the inbox — otherwise a "what would you do" quietly eats the mail.
  if (options.recordOnly !== true && (asked.canvasMessages ?? []).length > 0) {
    await deps.api
      .canvasAckMessages({ ids: (asked.canvasMessages ?? []).map((message) => message.id) })
      .catch(() => undefined);
  }
  await noteTickInConversation({
    cardIdByThreadId,
    settings,
    snapshot: asked,
    result,
    delta,
    backends: deps.backends,
  });
  recordNudges(result);
  // The loop watching itself repeat: a correction typed into a second thread is
  // no longer about one card, and from here it ships with every later launch
  // into that project instead of being typed a third time.
  if (options.recordOnly !== true) {
    learnFromTickNudges({
      calls: result.execution?.calls ?? [],
      cards: asked.cards.map((card) => ({
        id: card.id as string,
        threadId:
          card.threadId === null || card.threadId === undefined ? null : String(card.threadId),
        projectId:
          card.projectId === null || card.projectId === undefined ? null : String(card.projectId),
      })),
      at: result.ranAt,
    });
  }
  const ticked = toTranscript(result);
  const transcript = {
    ...ticked,
    calls: [...rules.calls.map(toTranscriptCall), ...ticked.calls],
    logs: [...rules.logs, ...ticked.logs],
    ruleActions: rules.actions,
    trigger: options.trigger ?? "manual",
    ...(options.wakeReason === undefined ? {} : { wakeReason: options.wakeReason }),
    // The rules ran before the model and their board calls are in this
    // transcript, so their time belongs in this tick's execution total.
    cost: {
      ...result.cost,
      executionMs: result.cost.executionMs + rules.durationMs,
    },
  };
  record(transcript, { ownsBoard });
  if (!ownsBoard()) return transcript;
  if (!transcript.recordOnly) {
    appendHermesChat(
      hermesChatTurns({
        at: transcript.ranAt,
        tickId: transcript.id,
        tier: transcript.tier,
        delta,
        note: result.execution?.note ?? null,
        replies: result.execution?.replies ?? [],
        program: transcript.program,
        calls: result.execution?.calls ?? [],
        logs: result.execution?.logs ?? [],
        error: transcript.error,
      }),
    );
    // Only after a tick that actually ran. A tick that died before its program
    // executed never showed the answer, and an answer shown once is gone.
    if (transcript.error === null) {
      deliverHermesHelpers((asked.helpers ?? []).map((helper) => helper.id));
    }
    const activity = collectCardActivity(transcript, cardIdByThreadId);
    rememberCardActivity(activity);
    syncCardWatch({
      queue: pendingQueue,
      judged: true,
      judgedCardIds: new Set(queue.flatMap((item) => (item.cardId === null ? [] : [item.cardId]))),
      atIso: transcript.ranAt,
      movedCardIds: new Set(activity.filter((entry) => entry.ok).map((entry) => entry.cardId)),
    });
    boardStatus = {
      ...boardStatus,
      lastModelAt: transcript.ranAt,
      lastSkipReason: null,
      lastSkipIsBoxBlock: false,
      lastError: transcript.error,
      consecutiveFailures: transcript.error ? boardStatus.consecutiveFailures + 1 : 0,
    };
    recordHermesBeat({
      summary: transcript.summary,
      beatAtIso: transcript.ranAt,
      tier: transcript.tier,
    });
  }
  await runSelfHeal(deps.api, transcript);
  return transcript;
}

export async function runOneTick(
  deps: HermesBrainDeps,
  options: {
    readonly recordOnly?: boolean;
    readonly trigger?: HermesTickTrigger;
    readonly wakeReason?: string;
  } = {},
): Promise<HermesTickTranscript> {
  return withTickLock(
    async ({ ownsBoard }) => {
      await deps.operations?.recoverExpired();
      const settings = await deps.boardSettings();
      const rules = await runRecoveryPass(deps, settings, options);
      const snapshot = await collectSnapshot(deps.api, settings);
      const transcript = await runPreparedTick(deps, settings, snapshot, rules, {
        ...options,
        ownsBoard,
      });
      // Recorded only once the tick actually looked at the board: rules
      // settling it alone (modelSkipped) and a tier answering (even with a
      // program that then failed) both count. Only a real model consultation
      // where no tier served at all — tier null, modelSkipped not true — must
      // not be recorded, or a fingerprint stamped before the tick could still
      // fail would mark real pending work as "already looked at" for the
      // unchanged-recheck window even though nothing moved.
      const tickReallyRan = transcript.modelSkipped === true || transcript.tier !== null;
      if (ownsBoard() && options.recordOnly !== true && tickReallyRan) {
        lastSemanticFingerprint = semanticFingerprint(snapshot);
        lastSemanticAtMs = wallClockMs();
      }
      return transcript;
    },
    { onWallClock: () => endHermesSessions(deps.backends) },
  );
}

export type HermesHeartbeatResult = {
  readonly checkedAt: string;
  readonly ranModel: boolean;
  readonly reason: string;
  readonly transcript: HermesTickTranscript | null;
};

export async function runHermesHeartbeat(
  deps: HermesBrainDeps,
  now = new Date(),
  options: { readonly trigger?: HermesTickTrigger; readonly wakeReason?: string } = {},
): Promise<HermesHeartbeatResult> {
  const checkedAt = now.toISOString();
  return withTickLock(
    async ({ ownsBoard }) => {
      stats.heartbeats += 1;
      await deps.operations?.recoverExpired(now);
      const settings = await deps.boardSettings();
      // Every heartbeat, not only the ones that produce a transcript: an idle
      // board still has to file the friction its agents already reported.
      if (settings.hermesAutoDraftPapercuts) await fileFrictionCards(deps.api);
      const rules = await runRecoveryPass(deps, settings);
      const snapshot = await collectSnapshot(deps.api, settings);
      const cap = evaluateSpendCap({
        capUsd: (settings as { hermesDailyUsdCap?: number }).hermesDailyUsdCap ?? 0,
        nowMs: now.getTime(),
      });
      const boxBlock = await runBoxPreflight(deps);
      // Resolved on every beat, not only on the beats that reach a model: a
      // brain pointed at a provider this box cannot drive fails every tick it
      // takes, and an idle board would otherwise read green until the next card
      // arrives to prove otherwise.
      await hermesTransport(deps, settings);
      // Rules already ran above, so a capped or unfit box still merges, requeues
      // and resets stuck prep — only the model stops. Launching a card onto a box
      // that cannot open a pull request is the one thing worth not paying for.
      const decision: HermesHeartbeatDecision = cap.blocked
        ? { runModel: false, reason: cap.reason ?? "daily spend cap reached", fingerprint: null }
        : boxBlock !== null
          ? { runModel: false, reason: boxBlock, fingerprint: null }
          : decideHermesHeartbeat(snapshot, now.getTime());
      if (!decision.runModel) {
        // The cheapest tick on the board is also the right place to cut history.
        const parked = judgmentQueue({
          snapshot,
          settings,
          reviewsByCardId: hermesCardReviews(),
        });
        await settleHermesConversation(parked, settings, deps.backends);
        // A skipped heartbeat still refreshes the queue on the board: a card the
        // model is not being asked about must not read as one it is working on.
        syncCardWatch({ queue: parked, judged: false, atIso: checkedAt });
        stats.skipped += 1;
        boardStatus = {
          ...boardStatus,
          lastHeartbeatAt: checkedAt,
          lastSkipReason: decision.reason,
          lastSkipIsBoxBlock: boxBlock !== null,
        };
        console.log(
          JSON.stringify({
            evt: "hermes.heartbeat",
            checkedAt,
            ranModel: false,
            reason: decision.reason,
            recovery: rules.logs,
          }),
        );
        // Only when the rules actually did something. An idle board stays the
        // cheap path it was: a heartbeat, no transcript, no tick counted.
        if (rules.actions > 0 || rules.conflicts.length > 0) {
          const skipped = recordSkippedTick({
            snapshot,
            settings,
            rules,
            recordOnly: false,
            trigger: options.trigger ?? "interval",
            ...(options.wakeReason === undefined ? {} : { wakeReason: options.wakeReason }),
            ownsBoard,
          });
          await runSelfHeal(deps.api, skipped);
        }
        return { checkedAt, ranModel: false, reason: decision.reason, transcript: null };
      }

      boardStatus = {
        ...boardStatus,
        lastHeartbeatAt: checkedAt,
        lastSkipReason: null,
        lastSkipIsBoxBlock: false,
      };

      const transcript = await runPreparedTick(deps, settings, snapshot, rules, {
        trigger: options.trigger ?? "interval",
        ...(options.wakeReason === undefined ? {} : { wakeReason: options.wakeReason }),
        ownsBoard,
      });
      // Recorded only once the tick actually looked at the board: rules
      // settling it alone (modelSkipped) and a tier answering (even with a
      // program that then failed) both count. Only a real model consultation
      // where no tier served at all — tier null, modelSkipped not true — must
      // not be recorded, or a fingerprint stamped before the tick could still
      // fail would mark real pending work as "already looked at" for the
      // unchanged-recheck window even though nothing moved.
      if (ownsBoard() && (transcript.modelSkipped === true || transcript.tier !== null)) {
        lastSemanticFingerprint = decision.fingerprint;
        lastSemanticAtMs = now.getTime();
      }
      // The rules may have settled everything the fingerprint flagged.
      const ranModel = transcript.modelSkipped !== true;
      const reason = ranModel ? decision.reason : `Rules settled it. ${decision.reason}`;
      if (!ranModel) {
        stats.skipped += 1;
        boardStatus = { ...boardStatus, lastSkipReason: reason };
      }
      console.log(
        JSON.stringify({
          evt: "hermes.heartbeat",
          checkedAt,
          ranModel,
          reason,
          tickId: transcript.id,
        }),
      );
      return { checkedAt, ranModel, reason, transcript: ranModel ? transcript : null };
    },
    { onWallClock: () => endHermesSessions(deps.backends) },
  ).catch((cause: unknown) => {
    if (cause instanceof HermesTickInFlightError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    stats.failed += 1;
    boardStatus = {
      ...boardStatus,
      lastHeartbeatAt: checkedAt,
      lastError: detail,
      consecutiveFailures: boardStatus.consecutiveFailures + 1,
    };
    console.log(
      JSON.stringify({ evt: "hermes.heartbeat", checkedAt, ranModel: false, error: detail }),
    );
    throw cause;
  });
}

export async function hermesBrainStatus(deps: HermesBrainDeps): Promise<HermesBrainStatus> {
  const settings = await deps.boardSettings();
  const transport = await hermesTransport(deps, settings);
  const model = transport.model;
  // Every transport is probed, not just the chosen one: the panel needs to say
  // which the box could serve from before the owner switches to one.
  const byTier = new Map(deps.backends.map((backend) => [backend.tier, backend]));
  const tiers = await Promise.all(
    HERMES_TIERS.map(async (tier) => {
      const backend = byTier.get(tier);
      const availability = backend
        ? await backend.available().catch(() => ({ available: false, detail: "probe failed" }))
        : { available: false, detail: "no backend" };
      return {
        tier,
        enabled: tier === transport.tier,
        available: availability.available,
        detail: availability.detail,
        model: tierModelId(tier, model),
      };
    }),
  );
  let componentCards: ReadonlyArray<KanbanCard>;
  try {
    componentCards = await deps.api.list();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    recordDegradation({
      id: "hermes.status-components",
      title: "Hermes status could not list board component rules",
      detail: `The board could not be read: ${detail}`,
    });
    componentCards = [];
  }

  return {
    enabled: settings.hermesBrainEnabled,
    running: nextTickAt !== null || tickInFlight,
    busy: tickInFlight,
    instanceId: settings.hermesBrainInstanceId,
    provider: transport.tier,
    providerError: transport.reason,
    model,
    intervalMs: settings.hermesBrainIntervalMs,
    maxNudges: settings.hermesBrainMaxNudges,
    nextTickAt,
    lastHeartbeatAt: boardStatus.lastHeartbeatAt,
    lastModelAt: boardStatus.lastModelAt,
    lastSkipReason: boardStatus.lastSkipReason,
    tiers,
    transports: hermesTransportClaims(deps.backends),
    lastTick,
    log: history.map(toLogEntry),
    logPath: hermesTickLogPath(),
    // What each column actually runs, built the same way the tick builds it.
    // The dialog renders this instead of a list maintained by hand.
    componentRules: componentRuleListing(boardComponentIds(componentCards), {
      settings,
      policy: {
        finishActive: rulePolicy(settings).autoFinishActive,
        mergeWhenGreen: rulePolicy(settings).autoMergeWhenGreen,
        conflictReturn: rulePolicy(settings).conflictReturn,
      },
    }),
    stats: snapshotStats(),
    conversation: hermesConversationStatus(),
    preflight: lastPreflight,
  };
}

/** Coalesce a burst of board writes (drag, then edit, then send) into one tick. */
const WAKE_DEBOUNCE_MS = 750;

/** Floor between tick starts, so typing into the board cannot bill per keystroke. */
const WAKE_MIN_GAP_MS = 5_000;

/** Set by the running loop; null whenever Hermes is off. */
let wakeRunningLoop: ((reason: string) => void) | null = null;

/**
 * A board event Hermes should act on now, not on the next beat — a composer
 * send, a card dropped into a column it owns. No-op when the loop is off, so
 * callers can fire it unconditionally.
 */
export function requestHermesWake(reason: string): void {
  wakeRunningLoop?.(reason);
}

/**
 * Start the loop. Returns a stop function. The caller must only call this when
 * `hermesBrainEnabled` is true — the switch is the gate, not this function.
 */
export function startHermesBrainLoop(
  deps: HermesBrainDeps,
  input: { readonly intervalMs: number; readonly onError?: (detail: string) => void },
): () => void {
  const intervalMs = Math.max(10_000, input.intervalMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingWake: string | null = null;
  let armedWake: string | null = null;
  let lastTickStartedMs = 0;
  // Not the `tickInFlight` lock: this one only decides whether a wake is held
  // for after the running tick, and the loop must not hold the lock itself.
  let tickRunning = false;

  // Self-scheduling, not setInterval: an ACP tier can take minutes, and a fixed
  // interval then fires into a tick that is still running. Those skipped beats
  // are what made the chip flap between live and starting.
  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    nextTickAt = new Date(wallClockMs() + delayMs).toISOString();
    timer = setTimeout(tick, delayMs);
  };

  const wakeDelayMs = () =>
    Math.max(WAKE_DEBOUNCE_MS, lastTickStartedMs + WAKE_MIN_GAP_MS - wallClockMs());

  const scheduleNext = () => {
    const wake = pendingWake;
    pendingWake = null;
    armedWake = wake;
    schedule(wake === null ? intervalMs : wakeDelayMs());
  };

  const wake = (reason: string) => {
    if (stopped) return;
    // A tick already reading the board will see this write; asking it to run
    // again afterwards is what keeps a mid-tick send from waiting a full beat.
    if (tickRunning) {
      pendingWake ??= reason;
      return;
    }
    const delayMs = wakeDelayMs();
    const alreadySooner =
      armedWake !== null &&
      nextTickAt !== null &&
      Date.parse(nextTickAt) <= wallClockMs() + delayMs;
    if (alreadySooner) return;
    armedWake = reason;
    schedule(delayMs);
  };

  function tick(): void {
    if (stopped) return;
    const reason = armedWake;
    armedWake = null;
    nextTickAt = null;
    tickRunning = true;
    lastTickStartedMs = wallClockMs();
    void runHermesHeartbeat(deps, new Date(), {
      trigger: reason === null ? "interval" : "wake",
      ...(reason === null ? {} : { wakeReason: reason }),
    })
      .catch((cause: unknown) => {
        if (cause instanceof HermesTickInFlightError) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        input.onError?.(detail);
      })
      .finally(() => {
        tickRunning = false;
        scheduleNext();
      });
  }

  // Check the box before the first beat, not after the first card fails on it:
  // the panel shows a verdict from the moment the switch goes on. Not awaited —
  // the first tick re-reads the same cached pass and gates on it.
  void runBoxPreflight(deps).then((block) => {
    console.log(JSON.stringify({ evt: "hermes.preflight", ok: block === null, reason: block }));
  });

  scheduleNext();
  wakeRunningLoop = wake;
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    nextTickAt = null;
    pendingWake = null;
    armedWake = null;
    if (wakeRunningLoop === wake) wakeRunningLoop = null;
  };
}

/** Test seam: the nudge cap is process-global state. */
export function resetHermesBrainState(): void {
  nudgeCounts.clear();
  clearCompletionCheckCounts();
  resetHermesHelpers();
  boardFailures.clear();
  conversation = null;
  servingTier = null;
  servingModel = null;
  lastTick = null;
  history.length = 0;
  tickSeq = 0;
  lastSemanticFingerprint = null;
  lastSemanticAtMs = null;
  nextTickAt = null;
  tickInFlight = false;
  tickLockGeneration = 0;
  tickCommitEpoch = 0;
  tickWallClockMs = DEFAULT_TICK_WALL_CLOCK_MS;
  lastPreflight = null;
  cardActivity.clear();
  cardWatch.clear();
  boardStatus = {
    ...boardStatus,
    cardWatch: [],
    nextModelCheckAt: null,
    lastHeartbeatAt: null,
    lastModelAt: null,
    lastSkipReason: null,
    lastSkipIsBoxBlock: false,
    lastBeatAt: null,
    lastSummary: null,
    lastTier: null,
    lastError: null,
    consecutiveFailures: 0,
    cardActivity: [],
  };
  stats.since = new Date().toISOString();
  stats.heartbeats = 0;
  stats.skipped = 0;
  stats.ticks = 0;
  stats.failed = 0;
  stats.writes = 0;
  stats.nudges = 0;
  stats.modelSkipped = 0;
  stats.ruleWrites = 0;
  stats.ruleFires.clear();
  stats.servedByTier.clear();
  stats.spend = emptyHermesSpend();
}
