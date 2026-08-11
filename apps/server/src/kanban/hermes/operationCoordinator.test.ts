import { describe, expect, it } from "vite-plus/test";

import { makeBoardRecorder } from "./boardApi.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { makeHermesOperationCoordinator } from "./operationCoordinator.ts";
import type {
  HermesOperationClaim,
  HermesOperationRecord,
  HermesOperationStore,
} from "./operationStore.ts";

function memoryStore(): HermesOperationStore {
  const byKey = new Map<string, HermesOperationRecord>();
  const findById = (id: string) => [...byKey.values()].find((entry) => entry.id === id);
  return {
    claim: async (input): Promise<HermesOperationClaim> => {
      const existing = byKey.get(input.idempotencyKey);
      if (existing) {
        const retryable = existing.status === "failed" || existing.status === "interrupted";
        if (!retryable || existing.attempt + 1 > (input.retryLimit ?? 3)) {
          return { kind: "existing", operation: existing };
        }
        const rearmed = {
          ...existing,
          status: "running",
          attempt: existing.attempt + 1,
          error: null,
          leaseOwner: input.leaseOwner,
          finishedAt: null,
        } as unknown as HermesOperationRecord;
        byKey.set(input.idempotencyKey, rearmed);
        return { kind: "claimed", operation: rearmed };
      }
      const operation = {
        id: `op-${byKey.size + 1}`,
        idempotencyKey: input.idempotencyKey,
        cardId: input.cardId,
        method: input.method,
        status: "running",
        attempt: 1,
        detail: input.detail,
        args: input.args,
        result: null,
        error: null,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
      } as unknown as HermesOperationRecord;
      byKey.set(input.idempotencyKey, operation);
      return { kind: "claimed", operation };
    },
    complete: async (input) => {
      const current = findById(input.id);
      if (!current) throw new Error("missing operation");
      const completed = {
        ...current,
        status: "applied",
        result: input.result,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: "2026-01-01T00:00:01.000Z",
      } as unknown as HermesOperationRecord;
      byKey.set(current.idempotencyKey, completed);
      return completed;
    },
    fail: async (input) => {
      const current = findById(input.id);
      if (!current) throw new Error("missing operation");
      const failed = {
        ...current,
        status: "failed",
        error: input.error,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: "2026-01-01T00:00:01.000Z",
      } as unknown as HermesOperationRecord;
      byKey.set(current.idempotencyKey, failed);
      return failed;
    },
    recoverExpired: async () => 0,
    rearmForRetry: async () => {
      let count = 0;
      for (const [key, entry] of byKey) {
        if (entry.status !== "failed" && entry.status !== "interrupted") continue;
        if (entry.attempt === 0) continue;
        byKey.set(key, { ...entry, attempt: 0 });
        count += 1;
      }
      return count;
    },
  };
}

describe("Hermes operation coordinator", () => {
  it("executes a semantic mutation once and reuses its durable result", async () => {
    const board = makeFakeBoardApi({ cards: [makeFakeCard({ id: "card-1" })] });
    let writes = 0;
    const updateCard = board.api.updateCard;
    board.api.updateCard = async (input) => {
      writes += 1;
      return updateCard(input);
    };
    const operations = makeHermesOperationCoordinator({
      store: memoryStore(),
      semanticFingerprint: "snapshot-a",
      cardIdByThreadId: new Map(),
      leaseOwner: "worker-1",
    });
    const recorder = makeBoardRecorder({ api: board.api, operations });

    const first = await recorder.api.updateCard({ id: "card-1", body: "structured" });
    const second = await recorder.api.updateCard({ id: "card-1", body: "structured" });

    expect(first.body).toBe("structured");
    expect(second.body).toBe("structured");
    expect(writes).toBe(1);
    expect(recorder.calls[0]?.operation?.status).toBe("applied");
    expect(recorder.calls[1]?.reused).toBe(true);
  });

  it("retries a failed mutation to the limit, then refuses without invoking", async () => {
    const board = makeFakeBoardApi({ cards: [makeFakeCard({ id: "card-2" })] });
    let writes = 0;
    board.api.updateCard = async () => {
      writes += 1;
      throw new Error("database unavailable");
    };
    const operations = makeHermesOperationCoordinator({
      store: memoryStore(),
      semanticFingerprint: "snapshot-b",
      cardIdByThreadId: new Map(),
      leaseOwner: "worker-1",
    });
    const recorder = makeBoardRecorder({ api: board.api, operations });

    for (let round = 0; round < 4; round += 1) {
      await expect(recorder.api.updateCard({ id: "card-2", body: "x" })).rejects.toThrow(
        /database unavailable/,
      );
    }

    expect(writes).toBe(3);
    expect(recorder.calls[2]?.operation?.attempt).toBe(3);
    expect(recorder.calls[2]?.refused).toBeUndefined();
    expect(recorder.calls[3]?.refused).toBe(true);
    expect(recorder.calls[3]?.error).toMatch(/will not be retried/);
  });

  it("keeps one retry budget when unrelated board state changes", async () => {
    const board = makeFakeBoardApi({ cards: [makeFakeCard({ id: "card-pr" })] });
    const store = memoryStore();
    let writes = 0;
    const attempts: Array<number | undefined> = [];
    const refused: Array<boolean | undefined> = [];
    board.api.openPr = async () => {
      writes += 1;
      throw new Error("git push refused");
    };

    for (let round = 0; round < 4; round += 1) {
      const operations = makeHermesOperationCoordinator({
        store,
        semanticFingerprint: `whole-board-${round}`,
        cardFingerprints: new Map([["card-pr", "unchanged-card"]]),
        cardIdByThreadId: new Map(),
        leaseOwner: `worker-${round}`,
      });
      const recorder = makeBoardRecorder({ api: board.api, operations });
      await expect(recorder.api.openPr({ id: "card-pr" })).rejects.toThrow(
        /git push refused|will not/,
      );
      attempts.push(recorder.calls[0]?.operation?.attempt);
      refused.push(recorder.calls[0]?.refused);
    }

    expect(writes).toBe(3);
    expect(attempts).toEqual([1, 2, 3, 3]);
    expect(refused).toEqual([undefined, undefined, undefined, true]);
  });

  it("does not freeze mergePr soft failures as applied forever", async () => {
    const board = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-pr", at: "pr", prUrl: "https://github.com/o/r/pull/1" })],
    });
    let merges = 0;
    board.api.mergePr = async () => {
      merges += 1;
      if (merges === 1) {
        return {
          merged: false,
          reason: "GitHub CLI command failed: could not determine current branch",
        };
      }
      return { merged: true, reason: null };
    };
    const operations = makeHermesOperationCoordinator({
      store: memoryStore(),
      semanticFingerprint: "snapshot-pr",
      cardIdByThreadId: new Map(),
      leaseOwner: "worker-1",
    });
    const recorder = makeBoardRecorder({ api: board.api, operations });

    const first = await recorder.api.mergePr({ id: "card-pr" });
    expect(first.merged).toBe(false);
    expect(recorder.calls[0]?.operation?.status).toBe("failed");

    const second = await recorder.api.mergePr({ id: "card-pr" });
    expect(second.merged).toBe(true);
    expect(merges).toBe(2);
  });
});
