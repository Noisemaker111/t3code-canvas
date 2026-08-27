import { describe, expect, it } from "@effect/vitest";

import type { BoardSettings } from "@t3tools/contracts";

import { makeFakeCard } from "./fakeBoardApi.ts";
import { judgmentQueue } from "./judgment.ts";
import { buildHermesSystemPrompt, type HermesSnapshot } from "./prompt.ts";

const settings = {
  hermesAutoMovePromptsToActive: true,
  hermesStuckPrepMs: 120_000,
  hermesAutoFinishActive: true,
  hermesBrainMaxNudges: 3,
} as unknown as BoardSettings;

const snapshotWith = (thread: { lastLine: string | null; tail?: ReadonlyArray<string> }) =>
  ({
    cards: [makeFakeCard({ id: "a1", at: "active", threadId: "t1", body: "Ship the hotbar" })],
    projects: [],
    models: [],
    pendingInputs: [],
    policy: {},
    reports: [],
    threads: [
      {
        cardId: "a1",
        threadId: "t1",
        exists: true,
        turnState: "completed",
        idleForMs: 300_000,
        messageCount: 4,
        ...thread,
      },
    ],
  }) as unknown as HermesSnapshot;

const reviewLine = (lastLine: string | null, tail?: ReadonlyArray<string>): string => {
  const snapshot = snapshotWith(tail === undefined ? { lastLine } : { lastLine, tail });
  const items = judgmentQueue({ snapshot, settings });
  return items.find((item) => item.kind === "review")?.why ?? "";
};

describe("judgmentQueue — a thread that stopped to ask", () => {
  it("puts the question in the queue line, with what to do about it", () => {
    const why = reviewLine("assistant: Should phase 2 reuse that store or get its own?");

    expect(why).toContain("stopped to ask");
    expect(why).toContain("reuse that store");
    // What to do about a question is stated once in the cached system prompt,
    // not re-sent on this card's line every tick.
    expect(buildHermesSystemPrompt()).toContain("Stopped to ask → answer that question");
  });

  it("leaves the plain judge line when the thread just stopped", () => {
    const why = reviewLine("assistant: Changed the parser and stopped.");

    expect(why).toContain("stopped (turn=");
    expect(why).not.toContain("stopped to ask");
  });

  it("does not read a question Hermes asked as the thread asking", () => {
    const why = reviewLine("user: Hermes completion check — is this card's goal finished?");

    expect(why).toContain("stopped (turn=");
    expect(why).not.toContain("stopped to ask");
  });

  it("reads the tail's whole closing, not the clipped lastLine", () => {
    // `lastLine` is cut at 240 chars for liveness, which lands mid-sentence on
    // a real closing and takes the question with it. The tail carries it whole.
    const closing = `assistant: ${"Phase 1 is in.\n".repeat(40)}Should phase 2 reuse that store?`;
    const why = reviewLine(closing.slice(0, 240), [closing]);

    expect(why).toContain("stopped to ask");
    expect(why).toContain("reuse that store");
  });

  it("points the model at the whole closing rather than at the label, once", () => {
    expect(buildHermesSystemPrompt()).toContain("from its whole closing in THREADS");
  });
});
