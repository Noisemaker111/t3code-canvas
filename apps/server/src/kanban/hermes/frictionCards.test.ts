import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_BOARD_SETTINGS, type BoardSettings } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  bindFrictionLog,
  listFriction,
  recordFriction,
  restoreFrictionLog,
  unbindFrictionLog,
  type FrictionInput,
} from "../../friction/frictionStore.ts";
import { makeFakeBoardApi } from "./fakeBoardApi.ts";
import {
  restoreHermesBoardFailures,
  resetHermesBrainState,
  runHermesHeartbeat,
} from "./HermesBrain.ts";
import { buildHermesSnapshotBlock, type HermesSnapshot } from "./prompt.ts";

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

const settings = (patch: Partial<BoardSettings> = {}): BoardSettings => ({
  ...DEFAULT_BOARD_SETTINGS,
  ...patch,
});

const papercut = (over: Partial<FrictionInput> = {}): FrictionInput => ({
  source: "agent",
  scope: "harness",
  tool: "apply_patch",
  summary: "apply_patch fails against a rift worktree",
  evidence: "apply_patch: failed to apply hunk",
  workaround: "scripted file edits",
  threadId: "thread-1",
  ...over,
});

const withTempBase = async (use: (baseDir: string) => Promise<void> | void): Promise<void> => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "friction-cards-"));
  try {
    bindFrictionLog(baseDir);
    await use(baseDir);
  } finally {
    unbindFrictionLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

const heartbeat = async (patch: Partial<BoardSettings> = {}) => {
  const { api, state } = makeFakeBoardApi();
  await runHermesHeartbeat({
    api,
    backends: [],
    boardSettings: async () =>
      settings({ hermesBrainEnabled: true, hermesAutoDraftPapercuts: true, ...patch }),
  });
  return state;
};

describe("papercuts in the prompt", () => {
  it("carries counts, threads and the workaround", () => {
    const block = buildHermesSnapshotBlock(
      snapshot({
        papercuts: [
          {
            tool: "apply_patch",
            scope: "upstream",
            summary: "fails against a rift worktree",
            count: 4,
            threads: 2,
            workaround: "scripted file edits",
          },
        ],
      }),
    );
    expect(block).toContain("## PAPERCUTS");
    expect(block).toContain("apply_patch (upstream) 4×, 2 threads");
    expect(block).toContain("workaround: scripted file edits");
  });

  it("stays out of the prompt when there are none", () => {
    expect(buildHermesSnapshotBlock(snapshot())).not.toContain("## PAPERCUTS");
  });
});

describe("friction escalation", () => {
  it("files a card for a guessed failure on the first sighting", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut({ source: "detector", workaround: null }));
      const state = await heartbeat();
      expect(state.cards).toHaveLength(1);
      expect(state.cards[0]?.at).toBe("prompts");
    });
  });

  it("files a card for an agent's own report on the first sighting", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut());
      const state = await heartbeat();
      expect(state.cards).toHaveLength(1);
      expect(state.cards[0]?.at).toBe("prompts");
    });
  });

  it("files nothing while auto-drafting is off", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut({ threadId: "a" }));
      recordFriction(papercut({ threadId: "b" }));
      const state = await heartbeat({ hermesAutoDraftPapercuts: false });
      expect(state.cards).toHaveLength(0);
    });
  });

  it("files one fix card once a fingerprint crosses the bar", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut({ threadId: "a" }));
      recordFriction(papercut({ threadId: "b" }));
      const state = await heartbeat();
      const filed = state.cards.filter((card) => card.title.startsWith("Fix tooling:"));
      expect(filed).toHaveLength(1);
      expect(filed[0]?.at).toBe("prompts");
      expect(filed[0]?.body).toContain("scripted file edits");
    });
  });

  it("does not file the same card twice", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut({ threadId: "a" }));
      recordFriction(papercut({ threadId: "b" }));
      await heartbeat();
      recordFriction(papercut({ threadId: "c" }));
      const state = await heartbeat();
      expect(state.cards.filter((card) => card.title.startsWith("Fix tooling:"))).toHaveLength(0);
    });
  });

  it("routes an upstream papercut to its own card, not a fix-it-here card", async () => {
    await withTempBase(async () => {
      resetHermesBrainState();
      recordFriction(papercut({ scope: "upstream", threadId: "a" }));
      recordFriction(papercut({ scope: "upstream", threadId: "b" }));
      const state = await heartbeat();
      const filed = state.cards.find((card) => card.title.startsWith("Upstream:"));
      expect(filed).toBeDefined();
      expect(filed?.body).toContain("file the issue upstream");
      expect(filed?.body).toContain("not this card's job");
    });
  });
});

describe("board failures across a restart", () => {
  it("rehydrates the consecutive-failure count instead of starting over", async () => {
    await withTempBase((baseDir) => {
      resetHermesBrainState();
      recordFriction({
        source: "board",
        scope: "repo",
        tool: "openPr",
        signature: "board-call openPr (board)",
        summary: "board call openPr keeps failing",
        evidence: "non-zero status",
      });
      recordFriction({
        source: "board",
        scope: "repo",
        tool: "openPr",
        signature: "board-call openPr (board)",
        summary: "board call openPr keeps failing",
        evidence: "non-zero status",
      });
      expect(listFriction()[0]?.count).toBe(2);

      // Install restarts the service; the counter has to come back with it.
      bindFrictionLog(baseDir);
      restoreFrictionLog();
      resetHermesBrainState();
      restoreHermesBoardFailures();
      expect(listFriction()[0]?.count).toBe(2);
    });
  });
});
