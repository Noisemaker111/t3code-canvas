import { describe, expect, it } from "@effect/vitest";

import { makeFakeCard } from "./fakeBoardApi.ts";
import type { JudgmentItem } from "./judgment.ts";
import { buildHermesDeltaBlock, buildHermesSnapshotBlock, type HermesSnapshot } from "./prompt.ts";

const CLOSING = [
  "Phase 1 is in: the hotbar reads from the inventory store.",
  "",
  "Before phase 2, which way do you want it?",
  "- reuse that store, which couples the two panels",
  "- give the hotbar its own, which duplicates the sync",
].join("\n");

const snapshot = (): HermesSnapshot =>
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
        lastLine: `assistant: ${CLOSING.slice(0, 40)}`,
        tail: [`assistant: ${CLOSING}`],
      },
    ],
  }) as unknown as HermesSnapshot;

const judgment: ReadonlyArray<JudgmentItem> = [
  { kind: "review", cardId: "a1", threadId: "t1", why: "Active thread stopped to ask" },
];

/** Every line of the closing, as THREADS should indent it. */
const indented = CLOSING.split("\n")
  .filter(Boolean)
  .map((line, index) => (index === 0 ? `  | assistant: ${line}` : `  | ${line}`));

describe("THREADS", () => {
  it("carries the whole closing, line breaks and all", () => {
    const block = buildHermesSnapshotBlock(snapshot());

    // Each line indented as its own line — a fork laid out as two options has
    // to still read as two options.
    for (const line of indented) expect(block).toContain(line);
  });

  it("shows the delta turn the same thread block as the full snapshot", () => {
    // [review] judges from this block. Two turns showing different amounts of
    // the thread is the model deciding on less than it had last tick.
    const block = buildHermesDeltaBlock({ ...snapshot(), judgment } as HermesSnapshot, {});

    for (const line of indented) expect(block).toContain(line);
  });
});
