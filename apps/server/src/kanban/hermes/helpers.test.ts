import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import type { BoardSettings } from "@t3tools/contracts";
import { DEFAULT_BOARD_SETTINGS } from "@t3tools/contracts";

import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import {
  bindHermesHelpers,
  liveHermesHelpers,
  deliverHermesHelpers,
  recordHermesHelper,
  resetHermesHelpers,
  restoreHermesHelpers,
  runningHermesHelpers,
  unbindHermesHelpers,
  type HermesHelper,
} from "./helperStore.ts";
import { collectHermesHelpers, formatHelperBlock } from "./helpers.ts";
import { judgmentQueue } from "./judgment.ts";
import { makeProgramApi } from "./programApi.ts";
import type { HermesSnapshot } from "./prompt.ts";

const policy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "review it" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

const settings: BoardSettings = DEFAULT_BOARD_SETTINGS;

const ask = (partial: Partial<Parameters<typeof recordHermesHelper>[0]> = {}) =>
  recordHermesHelper({
    threadId: "t-helper",
    question: "Did the agent finish the migration on this card?",
    cardId: "c1",
    projectId: "p1",
    askedAt: new Date().toISOString(),
    ...partial,
  });

const transcript = (partial: {
  turnState: string;
  entries?: Array<{ at: string; role: string; text: string }>;
  exists?: boolean;
}) => ({
  threadId: "t-helper",
  title: "Helper",
  exists: partial.exists ?? true,
  archived: false,
  turnState: partial.turnState,
  lastActivityAt: null,
  idleForMs: 0,
  messageCount: partial.entries?.length ?? 0,
  entries: partial.entries ?? [],
});

const snapshotWith = (helpers: ReadonlyArray<HermesHelper>): HermesSnapshot => ({
  cards: [makeFakeCard({ id: "c1", at: "prompts", body: "do a thing" })],
  projects: [],
  models: [],
  pendingInputs: [],
  policy: {},
  reports: [],
  threads: [],
  helpers,
});

describe("helper threads", () => {
  it("holds a card out of the judgment queue while its helper is running", () => {
    resetHermesHelpers();
    const helper = ask();

    expect(
      judgmentQueue({ snapshot: snapshotWith([]), settings }).map((item) => item.kind),
    ).toEqual(["structure"]);
    expect(judgmentQueue({ snapshot: snapshotWith([helper]), settings })).toEqual([]);
  });

  it("queues an answered helper once and never again", () => {
    resetHermesHelpers();
    const answered: HermesHelper = {
      ...ask(),
      status: "answered",
      answer: "Yes — the migration ran and the tests pass.",
      settledAt: new Date().toISOString(),
    };

    const queue = judgmentQueue({ snapshot: snapshotWith([answered]), settings });
    expect(queue.map((item) => item.kind)).toContain("helper");
    expect(queue[0]?.cardId).toBe("c1");

    const delivered = judgmentQueue({
      snapshot: snapshotWith([{ ...answered, delivered: true }]),
      settings,
    });
    expect(delivered.map((item) => item.kind)).not.toContain("helper");
  });

  it("settles a stopped helper on its last assistant message and archives the thread", async () => {
    resetHermesHelpers();
    const helper = ask();
    const { api, state } = makeFakeBoardApi();
    state.transcripts[helper.threadId] = transcript({
      turnState: "completed",
      entries: [
        { at: "2026-01-01T00:00:00.000Z", role: "user", text: "the question" },
        { at: "2026-01-01T00:01:00.000Z", role: "assistant", text: "No. The tests never ran." },
      ],
    });

    const collected = await collectHermesHelpers({
      api,
      helpers: runningHermesHelpers(),
      timeoutMs: 900_000,
    });

    expect(collected.settled).toEqual([
      { id: helper.id, status: "answered", answer: "No. The tests never ran." },
    ]);
    expect(state.archivedThreads).toEqual([helper.threadId]);
    expect(liveHermesHelpers()[0]?.answer).toBe("No. The tests never ran.");
  });

  it("leaves a running helper alone until it times out", async () => {
    resetHermesHelpers();
    const helper = ask({ askedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const { api } = makeFakeBoardApi();
    const { api: fresh, state } = makeFakeBoardApi();
    api.threadTranscript = async () => transcript({ turnState: "running" });
    fresh.threadTranscript = async () => transcript({ turnState: "running" });

    const patient = await collectHermesHelpers({
      api,
      helpers: runningHermesHelpers(),
      timeoutMs: 60 * 60_000,
    });
    expect(patient.settled).toEqual([]);

    const abandoned = await collectHermesHelpers({
      api: fresh,
      helpers: runningHermesHelpers(),
      timeoutMs: 15 * 60_000,
    });
    expect(abandoned.settled[0]?.status).toBe("failed");
    expect(abandoned.settled[0]?.id).toBe(helper.id);
    expect(state.archivedThreads).toEqual([helper.threadId]);
  });

  it("fails a helper whose thread is gone", async () => {
    resetHermesHelpers();
    ask();
    const { api } = makeFakeBoardApi();
    api.threadTranscript = async () => null;

    const collected = await collectHermesHelpers({
      api,
      helpers: runningHermesHelpers(),
      timeoutMs: 900_000,
    });
    expect(collected.settled[0]?.status).toBe("failed");
  });

  it("renders a running helper as waiting and an answer in full", () => {
    resetHermesHelpers();
    const running = ask({ threadId: "t-run" });
    const answered: HermesHelper = {
      ...ask({ threadId: "t-done", cardId: "c2" }),
      status: "answered",
      answer: "The repo's gate is `pnpm test`.",
    };

    const block = formatHelperBlock([running, answered]) ?? "";
    expect(block).toContain("[running");
    expect(block).toContain("[ANSWERED]");
    expect(block).toContain("The repo's gate is `pnpm test`.");
    expect(formatHelperBlock([{ ...answered, delivered: true }])).toBe(null);
  });
});

describe("board.askHelper", () => {
  const program = (api: ReturnType<typeof makeFakeBoardApi>["api"]) =>
    makeProgramApi({ api, policy, onNote: () => {} });

  it("launches one helper and hands it the thread it is about", async () => {
    resetHermesHelpers();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", projectId: "p1", threadId: "t1" })],
    });

    const result = await program(api).askHelper({
      question: "Read this thread and say whether the card's Done-when is satisfied.",
      cardId: "c1",
      aboutThreadId: "t1",
    });

    expect(result.ok).toBe(true);
    expect(state.helperLaunches).toEqual([
      {
        question: "Read this thread and say whether the card's Done-when is satisfied.",
        projectId: "p1",
        aboutThreadId: "t1",
        threadId: "helper-thread-1",
      },
    ]);
    expect(runningHermesHelpers()).toHaveLength(1);
  });

  it("refuses a second helper on the same card, and anything past the cap", async () => {
    resetHermesHelpers();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({ id: "c1", at: "active", projectId: "p1" }),
        makeFakeCard({ id: "c2", at: "active", projectId: "p1" }),
        makeFakeCard({ id: "c3", at: "active", projectId: "p1" }),
      ],
    });
    const question = "Which project does this composer text belong to?";

    expect((await program(api).askHelper({ question, cardId: "c1" })).ok).toBe(true);
    const duplicate = await program(api).askHelper({ question, cardId: "c1" });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toContain("already has a helper");

    expect((await program(api).askHelper({ question, cardId: "c2" })).ok).toBe(true);
    const capped = await program(api).askHelper({ question, cardId: "c3" });
    expect(capped.ok).toBe(false);
    expect(capped.reason).toContain("cap 2");
    expect(state.helperLaunches).toHaveLength(2);
  });

  it("refuses a card with no project and a question that is not one", async () => {
    resetHermesHelpers();
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts" })],
    });

    expect((await program(api).askHelper({ question: "hmm?", cardId: "c1" })).reason).toContain(
      "real question",
    );
    expect(
      (await program(api).askHelper({ question: "Which project owns this text?", cardId: "c1" }))
        .reason,
    ).toContain("no project");
  });

  it("stays off when helpers are disabled", async () => {
    resetHermesHelpers();
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", projectId: "p1" })],
    });
    const off = makeProgramApi({
      api,
      policy: { ...policy, helpers: { ...policy.helpers, enabled: false } },
      onNote: () => {},
    });

    expect((await off.askHelper({ question: "Is this card done yet?", cardId: "c1" })).ok).toBe(
      false,
    );
    expect(state.helperLaunches).toEqual([]);
  });
});

describe("helper store", () => {
  it("survives a restart, and delivery is what retires an answer", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-helpers-"));
    try {
      resetHermesHelpers();
      bindHermesHelpers(dir);
      const helper = ask();
      deliverHermesHelpers([helper.id]);

      resetHermesHelpers();
      restoreHermesHelpers();
      expect(runningHermesHelpers().map((entry) => entry.id)).toEqual([helper.id]);

      // Delivery only retires a settled helper: a running one is still the
      // reason its card is out of the queue.
      expect(liveHermesHelpers()).toHaveLength(1);
    } finally {
      unbindHermesHelpers();
      resetHermesHelpers();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
