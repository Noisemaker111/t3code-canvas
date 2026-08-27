/**
 * One Hermes tick: snapshot → one prompt → one program → one execution.
 *
 * One provider serves the whole tick. A bad program is retried once against
 * that same provider with the parse error fed back, then reported.
 *
 * @module kanban/hermes/tick
 */
import type { HermesRoutingBrief, HermesTickCost, HermesTokenUsage } from "@t3tools/contracts";

import {
  HERMES_MODEL,
  addUsage,
  runHermesBackend,
  type HermesBackend,
  type HermesAttempt,
  type HermesImage,
  type HermesMessage,
  type HermesTier,
} from "./backend.ts";
import { estimateTokens } from "./conversation.ts";
import { BOARD_WRITE_METHODS, type BoardApi, type BoardOperationCoordinator } from "./boardApi.ts";
import { HermesProgramError, runHermesProgram, unwrapProgram } from "./executor.ts";
import type { HermesExecutionResult } from "./executor.ts";
import {
  buildHermesSnapshotBlock,
  buildHermesSystemPrompt,
  buildRetryUserPrompt,
  type HermesSnapshot,
} from "./prompt.ts";
import type { RulePolicy } from "./rulePass.ts";

export type HermesTickResult = {
  readonly ranAt: string;
  readonly durationMs: number;
  readonly model: string;
  readonly tier: HermesTier | null;
  /** How the serving tier was asked; null when nothing served. */
  readonly mode: "conversation" | "stateless" | null;
  readonly attempts: ReadonlyArray<HermesAttempt>;
  readonly program: string | null;
  readonly execution: HermesExecutionResult | null;
  readonly summary: string;
  readonly error: string | null;
  readonly recordOnly: boolean;
  readonly cost: HermesTickCost;
};

export type HermesTickInput = {
  readonly api: BoardApi;
  readonly snapshot: HermesSnapshot;
  readonly policy: RulePolicy;
  /** Board writes the deterministic pass already made this tick. */
  readonly ruleActions?: number;
  readonly backends: ReadonlyArray<HermesBackend>;
  /** The one transport this tick asks; null when the selection resolved to none. */
  readonly provider: HermesTier | null;
  /** Why there is no transport. Reported as the tick's error. */
  readonly providerError?: string;
  readonly model?: string | undefined;
  readonly recordOnly?: boolean;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxCalls?: number;
  readonly operations?: BoardOperationCoordinator;
  readonly routingBriefs?: ReadonlyMap<string, HermesRoutingBrief>;
  /**
   * Prior turns plus this tick's delta, for tiers that carry history. A tier
   * that cannot carry one gets the full snapshot instead — it is self-contained
   * (the journal rides inside it), so the fallback loses nothing.
   */
  readonly conversation?: {
    readonly history: ReadonlyArray<HermesMessage>;
    readonly delta: string;
    /** Pictures addressed to Hermes this tick, attached to the delta turn. */
    readonly images?: ReadonlyArray<HermesImage>;
  };
};

/** Compile-only check so a syntax error costs a retry, not a whole execution. */
function compileCheck(source: string): string | null {
  try {
    // eslint-disable-next-line no-new-func -- parse check only; never invoked.
    new Function(`(async () => {\n${unwrapProgram(source)}\n})`);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The tick's own beat. The model used to build this string and call
 * `heartbeat` with it, and the runtime then overwrote it with this one —
 * the model's copy never reached a screen. Counters are the runtime's job;
 * `note()` is the model's.
 */
export function summarize(input: {
  snapshot: HermesSnapshot;
  execution: HermesExecutionResult | null;
  tier: HermesTier | null;
  error: string | null;
  ruleActions?: number;
  modelSkipped?: boolean;
}): string {
  const counts = new Map<string, number>();
  for (const card of input.snapshot.cards) {
    counts.set(card.at, (counts.get(card.at) ?? 0) + 1);
  }
  const board = `p${counts.get("prompts") ?? 0}/a${counts.get("active") ?? 0}/pr${counts.get("pr") ?? 0}`;
  const rules = input.ruleActions ?? 0;
  const rulePart = rules > 0 ? ` · rules ${rules}` : "";
  if (input.error) {
    return `${board}${rulePart} · tier ${input.tier ?? "none"} · failed: ${input.error}`;
  }
  if (input.modelSkipped === true) {
    return `${board}${rulePart} · no model · nothing needed a decision`;
  }
  const writes = countWrites(input.execution);
  const note = input.execution?.note;
  return [
    `${board}${rulePart} · tier ${input.tier ?? "none"} · ${writes} action${writes === 1 ? "" : "s"}`,
    ...(note ? [note] : []),
  ].join(" · ");
}

/** Verb rows carry the intent; the primitives under them are what landed. */
function countWrites(execution: HermesExecutionResult | null): number {
  return (execution?.calls ?? []).filter(
    (call) =>
      call.error === undefined && call.skipped !== true && BOARD_WRITE_METHODS.has(call.method),
  ).length;
}

/** Wall clock the provider spent, retry included — not the whole tick. */
function providerMs(attempts: ReadonlyArray<HermesAttempt>): number {
  return attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
}

export async function runHermesTick(input: HermesTickInput): Promise<HermesTickResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const ranAt = startedAt.toISOString();
  const elapsed = () => Math.max(0, now().getTime() - startedAt.getTime());
  const model = (input.model ?? "").trim() || HERMES_MODEL;
  const recordOnly = input.recordOnly === true;
  const system = buildHermesSystemPrompt();
  const snapshotBlock = buildHermesSnapshotBlock(input.snapshot);
  const statelessUser = snapshotBlock;
  const conversation = input.conversation;

  if (input.provider === null) {
    const error = input.providerError ?? "no Hermes provider is configured";
    return {
      ranAt,
      durationMs: elapsed(),
      model,
      tier: null,
      mode: null,
      attempts: [],
      program: null,
      execution: null,
      summary: summarize({
        snapshot: input.snapshot,
        execution: null,
        tier: null,
        error,
        ...(input.ruleActions === undefined ? {} : { ruleActions: input.ruleActions }),
      }),
      error,
      recordOnly,
      cost: {
        promptChars: 0,
        snapshotChars: snapshotBlock.length,
        programChars: 0,
        modelCalls: 0,
        modelMs: 0,
        executionMs: 0,
      },
    };
  }

  const provider = input.provider;

  const first = await runHermesBackend({
    backends: input.backends,
    provider,
    system,
    user: statelessUser,
    ...(conversation
      ? {
          conversation: {
            history: conversation.history,
            user: conversation.delta,
            ...(conversation.images && conversation.images.length > 0
              ? { images: conversation.images }
              : {}),
          },
        }
      : {}),
    model,
    now: () => now().getTime(),
  });

  const mode = first.mode;
  const historyChars =
    conversation?.history.reduce((sum, message) => sum + message.content.length, 0) ?? 0;
  const sentUser = mode === "conversation" && conversation ? conversation.delta : statelessUser;

  // Sized from the ask that was actually sent. A retry re-sends the snapshot
  // with the bad program appended, so a retried tick is charged for both.
  let promptChars = system.length + sentUser.length + (mode === "conversation" ? historyChars : 0);
  let usage: HermesTokenUsage | null = first.usage;
  let modelCalls = first.attempts.some((attempt) => attempt.outcome !== "skipped") ? 1 : 0;
  let executionMs = 0;

  const cost = (
    attempts: ReadonlyArray<HermesAttempt>,
    program: string | null,
  ): HermesTickCost => ({
    promptChars,
    snapshotChars: snapshotBlock.length,
    programChars: program?.length ?? 0,
    modelCalls,
    modelMs: providerMs(attempts),
    executionMs,
    ...(usage ? { usage } : {}),
    ...(mode === "conversation" && conversation
      ? {
          historyTokens: estimateTokens(conversation.history.map((m) => m.content).join("")),
          deltaTokens: estimateTokens(conversation.delta),
        }
      : {}),
  });

  const fail = (
    error: string,
    tier: HermesTier | null,
    attempts: ReadonlyArray<HermesAttempt>,
    program: string | null,
  ) => ({
    ranAt,
    durationMs: elapsed(),
    model,
    tier,
    mode,
    attempts,
    program,
    execution: null,
    summary: summarize({
      snapshot: input.snapshot,
      execution: null,
      tier,
      error,
      ...(input.ruleActions === undefined ? {} : { ruleActions: input.ruleActions }),
    }),
    error,
    recordOnly,
    cost: cost(attempts, program),
  });

  if (first.text === null || first.tier === null) {
    return fail(
      first.error?.message ?? `${provider} did not answer`,
      first.tier,
      first.attempts,
      null,
    );
  }

  let tier: HermesTier = first.tier;
  let attempts = [...first.attempts];
  let program = unwrapProgram(first.text);
  let parseError = compileCheck(first.text);

  if (parseError !== null) {
    // Same provider, once, with the error fed back — a bad program is a prompt
    // problem, and nothing else is allowed to answer this tick anyway.
    const backend = input.backends.find((entry) => entry.tier === tier);
    if (!backend) return fail(parseError, tier, attempts, program);
    const retryUser = buildRetryUserPrompt({
      snapshotBlock: sentUser,
      badSource: program,
      error: parseError,
    });
    const retry = await runHermesBackend({
      backends: [backend],
      provider: tier,
      system,
      user: retryUser,
      ...(mode === "conversation" && conversation
        ? { conversation: { history: conversation.history, user: retryUser } }
        : {}),
      model,
      now: () => now().getTime(),
    });
    promptChars += system.length + retryUser.length + (mode === "conversation" ? historyChars : 0);
    modelCalls += 1;
    usage = addUsage(usage, retry.usage);
    attempts = [
      ...attempts,
      ...retry.attempts.map((attempt) => ({ ...attempt, detail: `retry: ${attempt.detail}` })),
    ];
    if (retry.text === null) {
      return fail(retry.error?.message ?? parseError, tier, attempts, program);
    }
    program = unwrapProgram(retry.text);
    parseError = compileCheck(retry.text);
    if (parseError !== null) return fail(parseError, tier, attempts, program);
  }

  const executionStartedMs = now().getTime();
  let execution: HermesExecutionResult;
  try {
    execution = await runHermesProgram({
      api: input.api,
      source: program,
      policy: input.policy,
      recordOnly,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxCalls === undefined ? {} : { maxCalls: input.maxCalls }),
      ...(input.operations ? { operations: input.operations } : {}),
      ...(input.routingBriefs ? { routingBriefs: input.routingBriefs } : {}),
    });
  } catch (cause) {
    executionMs = Math.max(0, now().getTime() - executionStartedMs);
    const message =
      cause instanceof HermesProgramError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return fail(message, tier, attempts, program);
  }
  executionMs = Math.max(0, now().getTime() - executionStartedMs);

  return {
    ranAt,
    durationMs: elapsed(),
    model,
    tier,
    mode,
    attempts,
    program,
    execution,
    cost: cost(attempts, program),
    summary: summarize({
      snapshot: input.snapshot,
      execution,
      tier,
      error: execution.error,
      ...(input.ruleActions === undefined ? {} : { ruleActions: input.ruleActions }),
    }),
    error: execution.error,
    recordOnly,
  };
}
