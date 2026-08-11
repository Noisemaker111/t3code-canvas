import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HERMES_CONVERSATION_KEEP_TURNS,
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
  type HermesConversationTurn,
} from "./conversation.ts";
import {
  bindHermesConversation,
  hermesConversationPath,
  readHermesConversation,
  unbindHermesConversation,
  writeHermesConversation,
} from "./conversationStore.ts";
import { makeFakeCard } from "./fakeBoardApi.ts";
import { boardDigestOf, buildHermesDeltaBlock, type HermesSnapshot } from "./prompt.ts";

const snapshot = (partial: Partial<HermesSnapshot> = {}): HermesSnapshot => ({
  cards: [],
  projects: [{ id: "proj-1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: null }],
  models: [
    {
      routeId: "grok/grok-4.5",
      selection: {
        instanceId: "grok" as HermesSnapshot["models"][number]["selection"]["instanceId"],
        model: "grok-4.5",
      },
      instanceId: "grok",
      model: "grok-4.5",
      costTier: 2,
      usable: true,
      capability: {
        coding: null,
        it: null,
        design: null,
        planning: null,
        effectiveContextTokens: null,
        source: null,
      },
      speed: { medianTurnMs: null, sampleCount: 0, tokensPerSecond: null, throughputSamples: 0 },
      capacity: {
        id: "grok",
        billing: "subscription",
        remainingPercent: null,
        resetsAt: null,
        balanceUsd: null,
        confidence: "unknown",
        detail: "No usage report.",
      },
      usage: {
        lowPercent: null,
        likelyPercent: null,
        highPercent: null,
        confidence: "unknown",
        basis: "No completed observations.",
      },
      meteredPrice: null,
    },
  ],
  pendingInputs: [],
  policy: { autoLaunch: true },
  reports: [],
  threads: [],
  ...partial,
});

const turn = (
  role: "user" | "assistant",
  content: string,
  kind: HermesConversationTurn["kind"] = "delta",
  cards: ReadonlyArray<string> = [],
): HermesConversationTurn => ({
  role,
  kind,
  content,
  at: "2026-01-01T00:00:00.000Z",
  cards,
});

const busy = new Set(["c1"]);

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-conv-"));
  try {
    bindHermesConversation(baseDir);
    return use(baseDir);
  } finally {
    unbindHermesConversation();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

describe("buildHermesDeltaBlock", () => {
  it("reports only what moved since the last digest", () => {
    const before = snapshot({
      cards: [
        makeFakeCard({ id: "c1", at: "prompts", body: "task one" }),
        makeFakeCard({ id: "c2", at: "active", threadId: "t2" }),
      ],
    });
    const digest = boardDigestOf(before);
    const after = snapshot({
      cards: [
        makeFakeCard({ id: "c1", at: "active", threadId: "t1", body: "task one" }),
        makeFakeCard({ id: "c2", at: "active", threadId: "t2" }),
        makeFakeCard({ id: "c3", at: "prompts", body: "brand new ask" }),
      ],
    });

    const delta = buildHermesDeltaBlock(after, digest);

    expect(delta).toContain("changed: c1 [active]");
    expect(delta).toContain("appeared: c3 [prompts]");
    expect(delta).not.toContain("c2 [active]");
    expect(delta).not.toContain("## BOARD\n");
  });

  it("marks a card that left the board and sends bodies only for new queued cards", () => {
    const before = snapshot({ cards: [makeFakeCard({ id: "c1", at: "pr" })] });
    const digest = boardDigestOf(before);
    const after = snapshot({
      cards: [makeFakeCard({ id: "c2", at: "prompts", body: "structure me please" })],
      judgment: [{ kind: "structure", cardId: "c2", threadId: null, why: "raw Draft" }],
    });

    const delta = buildHermesDeltaBlock(after, digest);

    expect(delta).toContain("gone: c1");
    expect(delta).toContain("## NEEDS A DECISION");
    expect(delta).toContain("structure me please");
  });
});

describe("buildResultTurn", () => {
  it("feeds back each call with ok or the failure reason", () => {
    const result = buildResultTurn({
      calls: [
        { method: "advanceCard", args: { id: "c1" } },
        { method: "mergePr", args: { id: "c2" }, error: "not mergeable" },
        { method: "list", args: {}, skipped: true },
      ],
      error: null,
    });

    expect(result).toContain('advanceCard {"id":"c1"} → ok');
    expect(result).toContain("mergePr");
    expect(result).toContain("failed: not mergeable");
    expect(result).not.toContain("list");
  });

  it("a merge refused as data reads failed, so the next tick does not think it landed", () => {
    const result = buildResultTurn({
      calls: [
        {
          method: "mergePr",
          args: { id: "c2" },
          result: { merged: false, reason: "Could not merge: not mergeable" },
        },
      ],
      error: null,
    });

    expect(result).toContain("mergePr");
    expect(result).toContain("failed: Could not merge: not mergeable");
    expect(result).not.toContain("→ ok");
  });

  it("says when a stateless fallback tick made the calls", () => {
    const result = buildResultTurn({ calls: [], error: "chain died", stateless: true });
    expect(result).toContain("stateless fallback");
    expect(result).toContain("tick error: chain died");
  });
});

describe("planEviction", () => {
  it("cuts the whole history when nothing needs a decision", () => {
    const state = appendTurns(emptyHermesConversation(), [
      turn("user", "x".repeat(20_000), "delta", ["c1"]),
    ]);

    expect(planEviction({ state, queuedCardIds: new Set() })).toEqual({
      reason: "settled",
      keepFrom: 1,
    });
  });

  it("leaves a small settled history alone — the snapshot would cost more", () => {
    const state = appendTurns(emptyHermesConversation(), [turn("user", "tiny", "delta", ["c1"])]);

    expect(planEviction({ state, queuedCardIds: new Set() })).toBeNull();
  });

  it("holds mid-decision, however big the history gets", () => {
    // The old design cut here — at a counter, straight through a live decision.
    const state = recordInputTokens(
      appendTurns(emptyHermesConversation(), [turn("user", "x".repeat(200_000), "delta", ["c1"])]),
      500_000,
    );

    expect(planEviction({ state, queuedCardIds: busy })?.reason).not.toBe("settled");
  });

  it("over the ceiling, drops the leading turns whose decisions closed", () => {
    const state = recordInputTokens(
      appendTurns(emptyHermesConversation(), [
        turn("user", "about c9", "delta", ["c9"]),
        turn("assistant", "program for c9", "program", ["c9"]),
        turn("user", "still deciding c1", "delta", ["c1"]),
      ]),
      30_000,
    );

    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 24_000 })).toEqual({
      reason: "resolved",
      keepFrom: 2,
    });
  });

  it("falls back to the counter only when every turn is still live, and says so", () => {
    const turns = Array.from({ length: 20 }, (_, index) =>
      turn("user", `turn ${index}`, "delta", ["c1"]),
    );
    const state = recordInputTokens(appendTurns(emptyHermesConversation(), turns), 30_000);

    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 24_000 })).toEqual({
      reason: "ceiling",
      keepFrom: 20 - HERMES_CONVERSATION_KEEP_TURNS,
    });
  });

  it("does nothing under the ceiling while work is in flight", () => {
    const state = appendTurns(emptyHermesConversation(), [turn("user", "hi", "delta", ["c1"])]);

    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 24_000 })).toBeNull();
  });

  it("with no ceiling configured, never cuts mid-decision however big it gets", () => {
    // The default. A 400k–1M window does not want a number picked for it, and
    // an overflow is the provider's own compaction to handle.
    const state = recordInputTokens(
      appendTurns(emptyHermesConversation(), [
        turn("user", "x".repeat(40_000), "delta", ["c9"]),
        turn("user", "x".repeat(40_000), "delta", ["c1"]),
      ]),
      900_000,
    );

    expect(planEviction({ state, queuedCardIds: busy })).toBeNull();
    // The boundary cut still works — it is not gated on a ceiling at all.
    expect(planEviction({ state, queuedCardIds: new Set() })?.reason).toBe("settled");
  });

  it("honours a per-model ceiling, so Claude at 400k is not cut at 24k", () => {
    const state = recordInputTokens(
      appendTurns(emptyHermesConversation(), [
        turn("user", "closed", "delta", ["c9"]),
        turn("user", "live", "delta", ["c1"]),
      ]),
      120_000,
    );

    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 400_000 })).toBeNull();
    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 100_000 })?.reason).toBe(
      "resolved",
    );
  });
});

describe("ceilingForModel", () => {
  it("is opt-in: an unset or non-positive model has no backstop", () => {
    expect(ceilingForModel({}, "x-ai/grok-4.5")).toBeNull();
    expect(ceilingForModel({ "x-ai/grok-4.5": 0 }, "x-ai/grok-4.5")).toBeNull();
    expect(ceilingForModel({ "anthropic/claude-opus-4": 400_000 }, "x-ai/grok-4.5")).toBeNull();
  });

  it("reads the ceiling for the model that is actually serving", () => {
    const ceilings = { "anthropic/claude-opus-4": 400_000, "x-ai/grok-4.5": 250_000 };
    expect(ceilingForModel(ceilings, "anthropic/claude-opus-4")).toBe(400_000);
    expect(ceilingForModel(ceilings, " x-ai/grok-4.5 ")).toBe(250_000);
  });

  it("prefers the provider's own token count over the chars/4 estimate", () => {
    const state = appendTurns(emptyHermesConversation(), [
      turn("user", "short", "delta", ["c9"]),
      turn("user", "live", "delta", ["c1"]),
    ]);
    expect(planEviction({ state, queuedCardIds: busy, ceilingTokens: 24_000 })).toBeNull();
    // The estimate says a handful of tokens; the ask actually cost 30k, because
    // the system prompt and this tick's delta ride along with the history.
    expect(
      planEviction({
        state: recordInputTokens(state, 30_000),
        queuedCardIds: busy,
        ceilingTokens: 24_000,
      }),
    ).toEqual({ reason: "resolved", keepFrom: 1 });
  });
});

describe("applyEviction", () => {
  it("drops turns without summarizing, and asks for a fresh snapshot", () => {
    const turns = Array.from({ length: 20 }, (_, index) =>
      turn("user", `turn ${index}`, "delta", ["c1"]),
    );
    const state = appendTurns(recordInputTokens(emptyHermesConversation(), 30_000), turns, {
      c1: "draft|card c1|t=-|prep=untouched|pr=-",
    });

    const evicted = applyEviction(
      state,
      { reason: "ceiling", keepFrom: 14 },
      "2026-01-02T00:00:00.000Z",
    );

    expect(evicted.turns).toHaveLength(HERMES_CONVERSATION_KEEP_TURNS);
    expect(evicted.turns[0]?.content).toBe("turn 14");
    expect(evicted.lastEvictionAt).toBe("2026-01-02T00:00:00.000Z");
    expect(evicted.lastEvictionReason).toBe("ceiling");
    expect(conversationTokens(evicted)).toBeLessThan(conversationTokens(state));
    // The dropped turns described board state, so the next tick re-reads it.
    expect(evicted.resnapshot).toBe(true);
    expect(evicted.boardDigest).toEqual({});
    expect(evicted.lastInputTokens).toBeNull();
  });

  it("carries the journal through, because a re-read cannot recover it", () => {
    const journal = [
      {
        cardId: "c1",
        at: "2026-01-01T00:00:00.000Z",
        action: "mergePr",
        ok: false,
        error: "dirty",
      },
    ];
    const state = appendTurns(emptyHermesConversation({ journal }), [turn("user", "hi")]);

    expect(
      applyEviction(state, { reason: "settled", keepFrom: 1 }, "2026-01-02T00:00:00.000Z").journal,
    ).toEqual(journal);
  });

  it("never leaves the history opening on an assistant turn", () => {
    // A stateless tick appends one turn, so a cut does not land on a
    // delta/program/result boundary by itself.
    const state = appendTurns(emptyHermesConversation(), [
      turn("user", "delta"),
      turn("assistant", "program", "program"),
      turn("user", "result", "result"),
      turn("assistant", "program", "program"),
    ]);

    const evicted = applyEviction(
      state,
      { reason: "ceiling", keepFrom: 3 },
      "2026-01-02T00:00:00.000Z",
    );

    expect(evicted.turns).toEqual([]);
    expect(assembleHistory(evicted)).toEqual([]);
  });

  it("assembles the history as the turns alone, so the cached prefix never moves", () => {
    const state = appendTurns(
      emptyHermesConversation({
        journal: [
          {
            cardId: "c1",
            at: "2026-01-01T00:00:00.000Z",
            action: "mergePr",
            ok: true,
            error: null,
          },
        ],
      }),
      [turn("user", "## BOARD")],
    );

    expect(assembleHistory(state)).toEqual([{ role: "user", content: "## BOARD" }]);
  });
});

describe("conversationStore", () => {
  it("round-trips the state across a restart", () => {
    withTempBase(() => {
      const state = appendTurns(
        emptyHermesConversation({
          journal: [
            {
              cardId: "c1",
              at: "2026-01-01T00:00:00.000Z",
              action: "updateCard → active",
              ok: true,
              error: null,
            },
          ],
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
        [
          turn("user", "## BOARD\n(cards)", "snapshot"),
          turn("assistant", "```js\nawait board.note({ text: 'x' });\n```", "program"),
        ],
        { c1: "draft|card c1|t=-|prep=untouched|pr=-" },
      );
      writeHermesConversation(state);

      const read = readHermesConversation();

      expect(read && "state" in read ? read.state : null).toEqual(state);
    });
  });

  it("reports a corrupt file but salvages the journal", () => {
    withTempBase(() => {
      const journal = [
        { cardId: "c1", at: "2026-01-01T00:00:00.000Z", action: "mergePr", ok: true, error: null },
      ];
      writeHermesConversation(
        appendTurns(emptyHermesConversation({ journal }), [turn("user", "hello")]),
      );
      const path = hermesConversationPath();
      NodeFS.appendFileSync(String(path), "{not json\n", "utf8");

      const read = readHermesConversation();

      expect(read).toEqual({ corrupt: true, journal });
    });
  });

  it("reads a v3 file, which is v4 with no session to reattach to", () => {
    withTempBase(() => {
      writeHermesConversation(appendTurns(emptyHermesConversation(), [turn("user", "hello")]));
      const path = String(hermesConversationPath());
      const lines = NodeFS.readFileSync(path, "utf8").split("\n");
      const meta = JSON.parse(String(lines[0])) as Record<string, unknown>;
      delete meta.cliSession;
      NodeFS.writeFileSync(path, [JSON.stringify({ ...meta, v: 3 }), ...lines.slice(1)].join("\n"));

      const read = readHermesConversation();

      expect(read && "state" in read ? read.state.turns : null).toHaveLength(1);
      expect(read && "state" in read ? read.state.cliSession : "missing").toBeNull();
    });
  });

  it("does not migrate an older file — its turns carry no cards to cut at", () => {
    withTempBase(() => {
      writeHermesConversation(emptyHermesConversation());
      const path = String(hermesConversationPath());
      const lines = NodeFS.readFileSync(path, "utf8").split("\n");
      const meta = JSON.parse(String(lines[0])) as Record<string, unknown>;
      NodeFS.writeFileSync(
        path,
        `${JSON.stringify({ ...meta, v: 1, memory: "c1 is mid-review" })}\n`,
        "utf8",
      );

      expect(readHermesConversation()).toEqual({ corrupt: true, journal: [] });
    });
  });

  it("returns null when nothing was ever written", () => {
    withTempBase(() => {
      expect(readHermesConversation()).toBeNull();
    });
  });

  it("stamps the system prompt version so a prompt change reseeds", () => {
    withTempBase(() => {
      writeHermesConversation(emptyHermesConversation());
      const read = readHermesConversation();
      expect(read && "state" in read ? read.state.systemPromptVersion : null).toBe(
        hermesSystemPromptVersion(),
      );
    });
  });
});
