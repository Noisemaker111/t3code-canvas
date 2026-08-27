import { describe, expect, it } from "@effect/vitest";
import type { HermesTickTranscript } from "@t3tools/contracts";

import { makeFakeCard } from "./fakeBoardApi.ts";
import { collectCardHistory, formatCardHistoryBlock, referencedCardId } from "./messageContext.ts";

const cards = [
  makeFakeCard({ id: "c1", title: "Fix the flashing toast on login" }),
  makeFakeCard({ id: "c2", title: "Ship the deploy docs", prUrl: "https://forge/x/pull/42" }),
];

const tick = (patch: Partial<HermesTickTranscript>): HermesTickTranscript =>
  ({
    id: "tick-1",
    ranAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    tier: "grok",
    model: "grok-4.5",
    attempts: [],
    program: null,
    calls: [],
    logs: [],
    summary: "p1/a0/pr0 · tier grok · 1 action",
    error: null,
    recordOnly: false,
    ...patch,
  }) as HermesTickTranscript;

describe("referencedCardId", () => {
  it("takes an id verbatim", () => {
    expect(referencedCardId({ text: "why is c1 still sitting there?", cards })).toBe("c1");
  });

  it("resolves a PR number to the card that owns it", () => {
    expect(referencedCardId({ text: "what happened to #42?", cards })).toBe("c2");
  });

  it("matches a title by its own words", () => {
    expect(referencedCardId({ text: "why did you route the flashing toast there?", cards })).toBe(
      "c1",
    );
  });

  it("names nothing when the message names nothing", () => {
    expect(referencedCardId({ text: "how are you?", cards })).toBeNull();
  });

  it("refuses a tie rather than attaching the wrong card", () => {
    const twins = [
      makeFakeCard({ id: "a", title: "deploy docs rewrite" }),
      makeFakeCard({ id: "b", title: "deploy docs cleanup" }),
    ];
    expect(referencedCardId({ text: "how is the deploy docs work?", cards: twins })).toBeNull();
  });
});

describe("collectCardHistory", () => {
  it("renders the recorded calls for the asked-about card only", () => {
    const history = collectCardHistory({
      ticks: [
        tick({
          calls: [
            { method: "updateCard", args: { id: "c1", projectId: "proj-1" } },
            { method: "updateCard", args: { id: "c9" } },
          ],
        }),
        tick({ id: "tick-2", calls: [{ method: "launchActive", args: { id: "c9" } }] }),
      ],
      cardIds: new Set(["c1"]),
      cards,
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.cardId).toBe("c1");
    expect(history[0]?.lines).toHaveLength(1);
    expect(formatCardHistoryBlock(history)).toContain("updateCard → ok");
  });

  it("keeps a failure in the record, since that is what a question is about", () => {
    const history = collectCardHistory({
      ticks: [
        tick({ calls: [{ method: "openPr", args: { id: "c2" }, error: "no commits" }] }),
        tick({
          id: "tick-2",
          recordOnly: true,
          calls: [{ method: "mergePr", args: { id: "c2" } }],
        }),
      ],
      cardIds: new Set(["c2"]),
      cards,
    });

    expect(history[0]?.lines.join("\n")).toContain("failed: no commits");
    expect(history[0]?.lines).toHaveLength(1);
  });

  it("says nothing about a card no tick touched", () => {
    expect(collectCardHistory({ ticks: [tick({})], cardIds: new Set(["c1"]), cards })).toEqual([]);
    expect(formatCardHistoryBlock([])).toBeNull();
  });
});
