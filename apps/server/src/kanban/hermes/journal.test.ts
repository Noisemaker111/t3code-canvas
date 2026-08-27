import { describe, expect, it } from "@effect/vitest";

import {
  HERMES_JOURNAL_PER_CARD,
  appendJournal,
  formatJournalBlock,
  journalEntriesFromCalls,
  pruneJournal,
  type HermesJournalEntry,
} from "./journal.ts";

const at = "2026-01-01T00:00:00.000Z";

const entry = (cardId: string, action: string, ok = true): HermesJournalEntry => ({
  cardId,
  at,
  action,
  ok,
  error: ok ? null : "boom",
});

describe("journalEntriesFromCalls", () => {
  it("records board writes against the card they touched", () => {
    const entries = journalEntriesFromCalls({
      calls: [
        { method: "updateCard", args: { id: "c1", at: "active" } },
        { method: "nudgeThread", args: { threadId: "t2", text: "keep going" } },
        { method: "createCard", args: { title: "new" }, result: { id: "c9" } },
        { method: "mergePr", args: { id: "c3" }, error: "not mergeable" },
        {
          method: "askUser",
          args: { cardId: "c4", question: "Which project owns this hotbar?" },
        },
      ],
      cardIdByThreadId: new Map([["t2", "c2"]]),
      at,
    });

    expect(entries).toEqual([
      { cardId: "c1", at, action: "updateCard → active", ok: true, error: null },
      { cardId: "c2", at, action: 'nudgeThread "keep going"', ok: true, error: null },
      { cardId: "c9", at, action: "createCard", ok: true, error: null },
      { cardId: "c3", at, action: "mergePr", ok: false, error: "not mergeable" },
      {
        cardId: "c4",
        at,
        action: 'askUser "Which project owns this hotbar?"',
        ok: true,
        error: null,
      },
    ]);
  });

  it("ignores reads and calls the policy skipped", () => {
    const entries = journalEntriesFromCalls({
      calls: [
        { method: "list", args: {} },
        { method: "threadTranscript", args: { threadId: "t1" } },
        { method: "archiveCard", args: { id: "c1" }, skipped: true },
      ],
      cardIdByThreadId: new Map(),
      at,
    });

    expect(entries).toEqual([]);
  });
});

describe("appendJournal", () => {
  it("keeps the newest entries per card and does not starve a quiet card", () => {
    const busy = Array.from({ length: HERMES_JOURNAL_PER_CARD + 4 }, (_, index) =>
      entry("c1", `nudgeThread #${index}`),
    );
    const journal = appendJournal([entry("c2", "createCard")], busy);

    const forC1 = journal.filter((item) => item.cardId === "c1");
    expect(forC1).toHaveLength(HERMES_JOURNAL_PER_CARD);
    expect(forC1[forC1.length - 1]?.action).toBe(`nudgeThread #${HERMES_JOURNAL_PER_CARD + 3}`);
    expect(journal.filter((item) => item.cardId === "c2")).toHaveLength(1);
  });
});

describe("pruneJournal", () => {
  it("forgets cards that left the board", () => {
    const journal = [entry("c1", "mergePr"), entry("c2", "createCard")];
    expect(pruneJournal(journal, new Set(["c1"]))).toEqual([journal[0]]);
  });
});

describe("formatJournalBlock", () => {
  it("renders only the asked-about cards, with the failure reason", () => {
    const journal = [
      entry("c1", "updateCard → active"),
      entry("c1", "mergePr", false),
      entry("c2", "createCard"),
    ];

    const block = formatJournalBlock(journal, new Set(["c1"]));

    expect(block).toContain("- c1");
    expect(block).toContain("updateCard → active → ok");
    expect(block).toContain("mergePr → failed: boom");
    expect(block).not.toContain("c2");
  });

  it("is absent when no queued card has a history", () => {
    expect(formatJournalBlock([entry("c1", "mergePr")], new Set(["c2"]))).toBeNull();
  });
});
