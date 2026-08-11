import * as NodeCrypto from "node:crypto";

import type { HermesCardOperation } from "@t3tools/contracts";

import {
  BoardOperationStateError,
  boardCallFailure,
  type BoardApi,
  type BoardOperationCoordinator,
} from "./boardApi.ts";
import type { HermesOperationRecord, HermesOperationStore } from "./operationStore.ts";

// A read must never claim an operation: the card's status line renders the
// claim, so a per-tick `prChecks` poll would paint over the real state.
const READ_ONLY_METHODS = new Set<keyof BoardApi>([
  "list",
  "threadReport",
  "threadTranscript",
  "pendingInputs",
  "listModels",
  "listProjects",
  "searchProjects",
  "prChecks",
  "canvasDigest",
  "canvasInbox",
]);

/** The step a card is in, named the way the board face reads it. */
const OPERATION_LABELS: Partial<Record<keyof BoardApi, string>> = {
  updateCard: "Structuring",
  createCard: "Adding card",
  launchActive: "Launching agent",
  openPr: "Opening PR",
  mergePr: "Merging PR",
  closePr: "Closing PR",
  syncPrBranch: "Syncing PR branch",
  restorePrWorktree: "Restoring worktree",
  nudgeThread: "Nudging agent",
  launchHelper: "Asking helper",
  archiveThread: "Archiving thread",
  archiveCard: "Archiving",
  answerPermission: "Answering permission",
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function operationView(operation: HermesOperationRecord): HermesCardOperation {
  return {
    id: operation.id,
    method: operation.method,
    status: operation.status,
    attempt: operation.attempt,
    detail: operation.detail,
    error: operation.error,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
  };
}

function directCardId(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const id = (args as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function makeHermesOperationCoordinator(input: {
  readonly store: HermesOperationStore;
  readonly semanticFingerprint: string;
  readonly cardFingerprints?: ReadonlyMap<string, string>;
  readonly cardIdByThreadId: ReadonlyMap<string, string>;
  readonly leaseOwner: string;
  readonly leaseMs?: number;
  readonly retryLimit?: number;
}): BoardOperationCoordinator {
  return {
    execute: async ({ method, args, invoke }) => {
      if (READ_ONLY_METHODS.has(method)) {
        return { result: await invoke() };
      }

      const threadId =
        args && typeof args === "object" ? (args as Record<string, unknown>)["threadId"] : null;
      const cardId =
        directCardId(args) ??
        (typeof threadId === "string" ? (input.cardIdByThreadId.get(threadId) ?? null) : null);
      const canonicalArgs = stableValue(args ?? null);
      const operationFingerprint =
        (cardId === null ? undefined : input.cardFingerprints?.get(cardId)) ??
        input.semanticFingerprint;
      const idempotencyKey = NodeCrypto.createHash("sha256")
        .update(`${operationFingerprint}\n${String(method)}\n${JSON.stringify(canonicalArgs)}`)
        .digest("hex");
      const detail = OPERATION_LABELS[method] ?? `Run ${String(method)}`;
      const claim = await input.store.claim({
        idempotencyKey,
        cardId,
        method: String(method),
        detail,
        args: canonicalArgs,
        leaseOwner: input.leaseOwner,
        leaseMs: input.leaseMs ?? 65_000,
        ...(input.retryLimit === undefined ? {} : { retryLimit: input.retryLimit }),
      });

      if (claim.kind === "existing") {
        if (claim.operation.status === "applied") {
          // Soft failures (mergePr returned {merged:false}, etc.) used to be
          // stored as applied. Reusing them forever freezes a card on a stale
          // reason (e.g. "not on any branch") and never calls the forge again.
          const stale = boardCallFailure({
            method: String(method),
            result: claim.operation.result,
          });
          if (stale === null) {
            return {
              result: claim.operation.result,
              operation: operationView(claim.operation),
              reused: true,
            };
          }
          // Legacy row: re-run the forge once and re-record correctly below.
          return settleInvocation({
            operationId: claim.operation.id,
            method: String(method),
            invoke,
            store: input.store,
            leaseOwner: input.leaseOwner,
            // complete/fail require running+lease; rewrite via fail path after
            // a fresh invoke by completing only true successes is not enough
            // for a row already marked applied — invoke and return live result
            // without touching the store when we cannot re-claim.
            legacyAppliedSoftFail: true,
          });
        }
        throw new BoardOperationStateError(operationView(claim.operation), {
          refused: true,
          exhausted: claim.operation.status !== "running",
        });
      }

      return settleInvocation({
        operationId: claim.operation.id,
        method: String(method),
        invoke,
        store: input.store,
        leaseOwner: input.leaseOwner,
        legacyAppliedSoftFail: false,
      });
    },
  };
}

async function settleInvocation(input: {
  readonly operationId: string;
  readonly method: string;
  readonly invoke: () => Promise<unknown>;
  readonly store: HermesOperationStore;
  readonly leaseOwner: string;
  readonly legacyAppliedSoftFail: boolean;
}): Promise<{
  result: unknown;
  operation?: HermesCardOperation;
  reused?: boolean;
}> {
  try {
    const result = await input.invoke();
    // mergePr/syncPrBranch/closePr answer soft failure as data. Storing
    // that under status=applied makes every later tick reuse the failure
    // forever (1ms "merge") — record it as failed so retries re-run gh.
    const softFailure = boardCallFailure({ method: input.method, result });
    if (input.legacyAppliedSoftFail) {
      // Old applied soft-fail rows cannot complete/fail (status is applied).
      // Return the live forge result so this tick can merge; next claim still
      // sees applied until deploy rewrites rows — callers also move the card.
      return { result };
    }
    if (softFailure !== null) {
      const failed = await input.store.fail({
        id: input.operationId,
        leaseOwner: input.leaseOwner,
        error: softFailure,
      });
      return { result, operation: operationView(failed) };
    }
    const completed = await input.store.complete({
      id: input.operationId,
      leaseOwner: input.leaseOwner,
      result,
    });
    return { result, operation: operationView(completed) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (input.legacyAppliedSoftFail) throw cause instanceof Error ? cause : new Error(message);
    const failed = await input.store.fail({
      id: input.operationId,
      leaseOwner: input.leaseOwner,
      error: message,
    });
    throw new BoardOperationStateError(operationView(failed));
  }
}
