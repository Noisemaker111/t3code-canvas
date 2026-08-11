import { describe, expect, it } from "vite-plus/test";
import type { HermesCardWatch, KanbanPrChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  BOTTOM_ABOVE_CAPTURE_BAR,
  BOTTOM_ABOVE_DROP_ZONE,
  CAPTURE_BAR_HEIGHT_VAR,
  boardNeedsLiveQueueClock,
  clientAutoSkillsEnabled,
  countQueuedCards,
  describeCardQueue,
  describePrChecks,
  formatTimeInColumn,
  isLiveHermesWorking,
  listOrphanedProcessingDraftIds,
  listUntouchedDraftIds,
  planBoardHermesClientPass,
  prepStatusAfterSkillsFailure,
  prepStatusAfterSkillsPromote,
  prepStatusAfterSkillsStayInDraft,
  prepStatusOf,
  resolveBoardSkillInstanceId,
  resolveBoardSkillModelSelection,
  type BoardHermesCardSlice,
  type BoardQueueContext,
} from "./KanbanBoard.logic";

function draft(
  id: string,
  prepStatus: BoardHermesCardSlice["prepStatus"] = "untouched",
): BoardHermesCardSlice {
  return { id, at: "prompts", prepStatus };
}

function prompts(id: string): BoardHermesCardSlice {
  return { id, at: "prompts", prepStatus: "ready" };
}

const empty = new Set<string>();

const idleQueue: Omit<BoardQueueContext, "nowMs"> = {
  brainEnabled: false,
  autoStructureDrafts: false,
  autoMoveDraftsToPrompts: false,
  autoLaunchPrompts: false,
  usageBlocked: false,
};

describe("boardNeedsLiveQueueClock", () => {
  it("stays off when Hermes is idle and no badges need relative time", () => {
    expect(boardNeedsLiveQueueClock([draft("a")], idleQueue)).toBe(false);
  });

  it("turns on for queued countdown when Hermes automation is live", () => {
    expect(
      boardNeedsLiveQueueClock([draft("a")], {
        ...idleQueue,
        brainEnabled: true,
        autoStructureDrafts: true,
        nextTickAtMs: Date.parse("2026-07-30T00:01:00.000Z"),
      }),
    ).toBe(true);
  });

  it("turns on when a durable Hermes operation is on a card", () => {
    expect(
      boardNeedsLiveQueueClock(
        [
          {
            id: "a",
            at: "prompts",
            prepStatus: "ready",
            hermesOperation: {
              id: "op-1",
              method: "updateCard",
              status: "applied",
              attempt: 1,
              detail: "Update card",
              error: null,
              startedAt: DateTime.makeUnsafe("2026-07-30T00:00:00.000Z"),
              finishedAt: DateTime.makeUnsafe("2026-07-30T00:00:01.000Z"),
            },
          },
        ],
        idleQueue,
      ),
    ).toBe(true);
  });
});

describe("prepStatusOf", () => {
  it("defaults missing prep to untouched", () => {
    expect(prepStatusOf({})).toBe("untouched");
    expect(prepStatusOf({ prepStatus: null })).toBe("untouched");
  });
});

describe("isLiveHermesWorking", () => {
  it("ignores stale prepStatus — only live in-tab jobs count", () => {
    expect(isLiveHermesWorking(false)).toBe(false);
    expect(isLiveHermesWorking(true)).toBe(true);
  });
});

describe("listOrphanedProcessingDraftIds", () => {
  it("finds processing drafts with no live skill job after refresh", () => {
    const cards = [
      draft("a", "processing"),
      draft("b", "processing"),
      draft("c", "untouched"),
      prompts("d"),
    ];
    expect(listOrphanedProcessingDraftIds(cards, new Set(["b"]))).toEqual(["a"]);
  });

  it("returns empty when every processing draft still has a live job", () => {
    expect(listOrphanedProcessingDraftIds([draft("a", "processing")], new Set(["a"]))).toEqual([]);
  });
});

describe("listUntouchedDraftIds", () => {
  it("skips ready and processing drafts so refresh does not re-run skills", () => {
    const cards = [
      draft("new", "untouched"),
      draft("done", "ready"),
      draft("running", "processing"),
      prompts("q"),
    ];
    expect(
      listUntouchedDraftIds(cards, { liveSkillJobIds: empty, sessionStartedIds: empty }),
    ).toEqual(["new"]);
  });

  it("skips ids already started this session or with a live job", () => {
    const cards = [draft("a"), draft("b"), draft("c")];
    expect(
      listUntouchedDraftIds(cards, {
        liveSkillJobIds: new Set(["b"]),
        sessionStartedIds: new Set(["c"]),
      }),
    ).toEqual(["a"]);
  });
});

describe("prepStatus after skill pipeline", () => {
  it("marks stay-in-draft success as ready (not untouched)", () => {
    expect(prepStatusAfterSkillsStayInDraft()).toBe("ready");
  });

  it("marks promote success as ready", () => {
    expect(prepStatusAfterSkillsPromote()).toBe("ready");
  });

  it("returns failed runs to untouched so auto-skills can retry", () => {
    expect(prepStatusAfterSkillsFailure()).toBe("untouched");
  });
});

describe("resolveBoardSkillInstanceId", () => {
  it("prefers the board skills model over brain and text-gen", () => {
    expect(
      resolveBoardSkillInstanceId({
        hermesInstanceId: "cursor",
        hermesModel: "grok-4.5",
        hermesBrainInstanceId: "claude",
        hermesBrainModel: "opus",
        textGenerationInstanceId: "claude",
      }),
    ).toBe("cursor");
  });

  it("falls back to Hermes brain when skills model is unset", () => {
    expect(
      resolveBoardSkillInstanceId({
        hermesInstanceId: null,
        hermesModel: null,
        hermesBrainInstanceId: "cursor",
        hermesBrainModel: "grok-4.5",
        textGenerationInstanceId: "claude",
      }),
    ).toBe("cursor");
  });

  it("does not use brain instance without a brain model", () => {
    expect(
      resolveBoardSkillInstanceId({
        hermesBrainInstanceId: "cursor",
        hermesBrainModel: "",
        textGenerationInstanceId: "claude",
      }),
    ).toBe("claude");
  });

  it("returns codex when nothing is configured", () => {
    expect(resolveBoardSkillInstanceId({})).toBe("codex");
  });
});

describe("resolveBoardSkillModelSelection", () => {
  it("uses brain selection when skills model is empty", () => {
    expect(
      resolveBoardSkillModelSelection({
        hermesBrainInstanceId: "cursor",
        hermesBrainModel: "grok-4.5",
        textGeneration: { instanceId: "claude", model: "opus" },
      }),
    ).toEqual({ instanceId: "cursor", model: "grok-4.5" });
  });
});

describe("clientAutoSkillsEnabled", () => {
  it("stays off while Hermes brain is enabled", () => {
    expect(clientAutoSkillsEnabled({ brainEnabled: true, structureDrafts: true })).toBe(false);
  });

  it("runs only when brain is off and structure drafts is on", () => {
    expect(clientAutoSkillsEnabled({ brainEnabled: false, structureDrafts: true })).toBe(true);
    expect(clientAutoSkillsEnabled({ brainEnabled: false, structureDrafts: false })).toBe(false);
  });
});

describe("planBoardHermesClientPass", () => {
  it("clears orphaned processing first and does not start skills in the same pass", () => {
    const action = planBoardHermesClientPass({
      cards: [draft("stale", "processing"), draft("fresh", "untouched")],
      liveSkillJobIds: empty,
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(action).toEqual({
      kind: "clear_orphaned_processing",
      cardIds: ["stale"],
    });
  });

  it("after orphans are gone, auto-starts skills only on untouched drafts", () => {
    const action = planBoardHermesClientPass({
      cards: [
        draft("fresh", "untouched"),
        draft("already", "ready"),
        draft("live", "processing"),
        prompts("p"),
      ],
      liveSkillJobIds: new Set(["live"]),
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(action).toEqual({
      kind: "start_auto_skills",
      cardIds: ["fresh"],
    });
  });

  it("promotes untouched drafts when auto-apply is on but there is no skill pipeline", () => {
    const action = planBoardHermesClientPass({
      cards: [draft("a"), draft("b", "ready")],
      liveSkillJobIds: empty,
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: false,
    });
    expect(action).toEqual({
      kind: "promote_untouched_without_skills",
      cardIds: ["a"],
    });
  });

  it("noops when auto-apply skills is off", () => {
    expect(
      planBoardHermesClientPass({
        cards: [draft("a")],
        liveSkillJobIds: empty,
        sessionStartedIds: empty,
        autoApplySkills: false,
        usageBlocked: false,
        hasSkillPipeline: true,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("returns usage_blocked when auto-skills would run but usage is blocked", () => {
    expect(
      planBoardHermesClientPass({
        cards: [draft("a")],
        liveSkillJobIds: empty,
        sessionStartedIds: empty,
        autoApplySkills: true,
        usageBlocked: true,
        hasSkillPipeline: true,
      }),
    ).toEqual({ kind: "usage_blocked", cardIds: ["a"] });
  });

  it("noops on usage block when there is no untouched work to skill", () => {
    expect(
      planBoardHermesClientPass({
        cards: [draft("a", "ready")],
        liveSkillJobIds: empty,
        sessionStartedIds: empty,
        autoApplySkills: true,
        usageBlocked: true,
        hasSkillPipeline: true,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("noops on usage block when auto-apply is off (brain owns structuring)", () => {
    expect(
      planBoardHermesClientPass({
        cards: [draft("a")],
        liveSkillJobIds: empty,
        sessionStartedIds: empty,
        autoApplySkills: false,
        usageBlocked: true,
        hasSkillPipeline: true,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("simulates refresh: stale processing → clear; next pass starts skills once", () => {
    const afterRefresh = [
      draft("mid-job", "processing"),
      draft("hermes-new", "untouched"),
      draft("skills-done-stay-draft", "ready"),
    ];

    const pass1 = planBoardHermesClientPass({
      cards: afterRefresh,
      liveSkillJobIds: empty,
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(pass1).toEqual({
      kind: "clear_orphaned_processing",
      cardIds: ["mid-job"],
    });

    const pass2Cards = [
      draft("mid-job", "untouched"),
      draft("hermes-new", "untouched"),
      draft("skills-done-stay-draft", "ready"),
    ];
    const pass2 = planBoardHermesClientPass({
      cards: pass2Cards,
      liveSkillJobIds: empty,
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(pass2).toEqual({
      kind: "start_auto_skills",
      cardIds: ["mid-job", "hermes-new"],
    });

    // Session remembers started ids — third pass must not re-fire the same cards.
    const pass3 = planBoardHermesClientPass({
      cards: pass2Cards,
      liveSkillJobIds: empty,
      sessionStartedIds: new Set(["mid-job", "hermes-new"]),
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(pass3).toEqual({ kind: "noop" });
  });

  it("does not treat a ready clarification draft as needing Hermes on reload", () => {
    const action = planBoardHermesClientPass({
      cards: [draft("clarify-mission", "ready")],
      liveSkillJobIds: empty,
      sessionStartedIds: empty,
      autoApplySkills: true,
      usageBlocked: false,
      hasSkillPipeline: true,
    });
    expect(action).toEqual({ kind: "noop" });
    expect(isLiveHermesWorking(false)).toBe(false);
  });
});

const ALL_OFF: BoardQueueContext = {
  brainEnabled: false,
  autoStructureDrafts: false,
  autoMoveDraftsToPrompts: false,
  autoLaunchPrompts: false,
  usageBlocked: false,
};

describe("describeCardQueue", () => {
  it("shows a Draft queued for the brain when Hermes structures drafts", () => {
    const state = describeCardQueue({
      card: draft("d1"),
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, brainEnabled: true, autoStructureDrafts: true },
    });
    expect(state).toMatchObject({ label: "Queued · Waiting", tone: "queued" });
  });

  it("says Structuring only while prep is processing", () => {
    const state = describeCardQueue({
      card: { ...draft("d1"), prepStatus: "processing" },
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, brainEnabled: true, autoStructureDrafts: true },
    });
    expect(state).toMatchObject({ label: "Structuring", tone: "running" });
  });

  it("fails loud when structure did not land", () => {
    const state = describeCardQueue({
      card: { ...draft("d1"), prepStatus: "failed" },
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, brainEnabled: true, autoStructureDrafts: true },
    });
    expect(state).toMatchObject({ label: "Failed · Structuring", tone: "blocked" });
  });

  // The countdown is a promise about the next tick. A failing box check or a
  // brain with no transport means no tick takes the card, ever.
  it("names the block instead of counting down to a tick that will not run", () => {
    const state = describeCardQueue({
      card: draft("d1"),
      hasLiveSkillJob: false,
      context: {
        ...ALL_OFF,
        brainEnabled: true,
        autoStructureDrafts: true,
        loopBlocked: "box check forge.cli is failing: neither gh nor glab is on PATH.",
      },
    });
    expect(state).toMatchObject({ label: "Hermes blocked · Waiting", tone: "blocked" });
    expect(state?.title).toContain("forge.cli");
  });

  it("says Hermes is idle when it is on but every Draft policy is off", () => {
    const state = describeCardQueue({
      card: draft("d1"),
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, brainEnabled: true },
    });
    expect(state).toMatchObject({ label: "Hermes idle", tone: "idle" });
  });

  it("shows the in-tab auto-skill queue while the brain is off", () => {
    const state = describeCardQueue({
      card: draft("d1"),
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, autoStructureDrafts: true },
    });
    expect(state).toMatchObject({ label: "Queued · auto-skills", tone: "queued" });
  });

  it("marks auto-skills blocked on usage caps", () => {
    const state = describeCardQueue({
      card: draft("d1"),
      hasLiveSkillJob: false,
      context: { ...ALL_OFF, autoStructureDrafts: true, usageBlocked: true },
    });
    expect(state).toMatchObject({ label: "Auto-skills paused", tone: "blocked" });
  });

  it("shows a skilled Draft as ready for the user, not queued", () => {
    expect(
      describeCardQueue({
        card: draft("d1", "ready"),
        hasLiveSkillJob: false,
        context: { ...ALL_OFF, autoStructureDrafts: true },
      }),
    ).toMatchObject({ label: "Ready", tone: "idle" });
  });

  it("calls a Draft manual when nothing will pick it up", () => {
    expect(
      describeCardQueue({ card: draft("d1"), hasLiveSkillJob: false, context: ALL_OFF }),
    ).toMatchObject({ label: "Manual", tone: "idle" });
  });

  it("names the in-tab skill job as the card's one status", () => {
    expect(
      describeCardQueue({
        card: draft("d1"),
        hasLiveSkillJob: true,
        context: { ...ALL_OFF, brainEnabled: true, autoStructureDrafts: true },
      }),
    ).toMatchObject({ label: "Applying skills", tone: "running" });
  });

  it("covers ready Prompts for launch while the brain is on", () => {
    expect(
      describeCardQueue({
        card: prompts("p1"),
        hasLiveSkillJob: false,
        context: { ...ALL_OFF, brainEnabled: true, autoLaunchPrompts: true },
      }),
    ).toMatchObject({ label: "Queued · Launching agent", tone: "queued" });
    expect(
      describeCardQueue({ card: prompts("p1"), hasLiveSkillJob: false, context: ALL_OFF }),
    ).toMatchObject({ label: "Ready", tone: "idle" });
  });
});

describe("describeCardQueue countdown and receipts", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const queuing: BoardQueueContext = {
    ...ALL_OFF,
    brainEnabled: true,
    autoStructureDrafts: true,
    nowMs,
  };

  it("puts the wait on the badge so the card answers when, not just whether", () => {
    expect(
      describeCardQueue({
        card: draft("d1"),
        hasLiveSkillJob: false,
        context: { ...queuing, nextTickAtMs: nowMs + 38_000 },
      }),
    ).toMatchObject({ label: "Queued · Waiting · 38s" });
  });

  it("says now while a tick is in flight", () => {
    expect(
      describeCardQueue({
        card: draft("d1"),
        hasLiveSkillJob: false,
        context: { ...queuing, busy: true, nextTickAtMs: null },
      }),
    ).toMatchObject({ label: "Queued · Waiting · now" });
  });

  it("shows what Hermes did to the card, and for how long", () => {
    const context: BoardQueueContext = {
      ...queuing,
      activityByCardId: new Map([
        [
          "d1",
          {
            cardId: "d1",
            action: "moved to Prompts",
            at: "2025-12-31T23:59:55.000Z",
            ok: true,
          },
        ],
      ]),
    };
    expect(describeCardQueue({ card: draft("d1"), hasLiveSkillJob: false, context })).toMatchObject(
      { label: "Moved to Prompts · just now", tone: "applied" },
    );

    const stale = { ...context, nowMs: nowMs + 30 * 60_000 };
    expect(
      describeCardQueue({ card: draft("d1"), hasLiveSkillJob: false, context: stale }),
    ).toMatchObject({ tone: "queued" });
  });

  it("surfaces a failed Hermes call on the card it failed on", () => {
    expect(
      describeCardQueue({
        card: prompts("p1"),
        hasLiveSkillJob: false,
        context: {
          ...queuing,
          activityByCardId: new Map([
            ["p1", { cardId: "p1", action: "launched", at: "2026-01-01T00:00:00.000Z", ok: false }],
          ]),
        },
      }),
    ).toMatchObject({ label: "Failed · launched", tone: "blocked" });
  });

  it("shows durable applying and applied receipts after a refresh", () => {
    const running = {
      ...draft("d1"),
      hermesOperation: {
        id: "op-1",
        method: "updateCard",
        status: "running",
        attempt: 1,
        detail: "Update card",
        error: null,
        startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        finishedAt: null,
      } as NonNullable<BoardHermesCardSlice["hermesOperation"]>,
    };
    expect(
      describeCardQueue({ card: running, hasLiveSkillJob: false, context: queuing }),
    ).toMatchObject({ label: "Structuring", tone: "running" });

    const applied = {
      ...running,
      hermesOperation: {
        ...running.hermesOperation,
        status: "applied",
        finishedAt: DateTime.makeUnsafe("2025-12-31T23:59:55.000Z"),
      } as NonNullable<BoardHermesCardSlice["hermesOperation"]>,
    };
    expect(
      describeCardQueue({ card: applied, hasLiveSkillJob: false, context: queuing }),
    ).toMatchObject({ label: "Structured · just now", tone: "applied" });
  });

  it("keeps durable failure and interruption states visible", () => {
    for (const status of ["failed", "interrupted"] as const) {
      const card = {
        ...prompts("p1"),
        hermesOperation: {
          id: `op-${status}`,
          method: "launchActive",
          status,
          attempt: 1,
          detail: "Launch coding agent",
          error: status === "failed" ? "provider unavailable" : "server restarted",
          startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
          finishedAt: DateTime.makeUnsafe("2026-01-01T00:00:01.000Z"),
        } as NonNullable<BoardHermesCardSlice["hermesOperation"]>,
      };
      expect(describeCardQueue({ card, hasLiveSkillJob: false, context: queuing })).toMatchObject({
        tone: "blocked",
      });
    }
  });
});

describe("describeCardQueue on Active cards", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const active = (id: string): BoardHermesCardSlice => ({ id, at: "active" });
  const watch = (patch: Partial<HermesCardWatch> = {}): HermesCardWatch => ({
    cardId: "a1",
    kind: "review",
    why: "Active thread stopped (turn=none) — judge from the transcript; no readable report",
    reviews: 0,
    sinceAt: "2025-12-31T23:50:00.000Z",
    lastReviewAt: null,
    stalled: false,
    ...patch,
  });
  const withWatch = (entry: HermesCardWatch): BoardQueueContext => ({
    ...ALL_OFF,
    brainEnabled: true,
    nowMs,
    watchByCardId: new Map([[entry.cardId, entry]]),
  });

  it("says nothing while the agent is still working", () => {
    expect(
      describeCardQueue({
        card: active("a1"),
        hasLiveSkillJob: false,
        context: { ...ALL_OFF, brainEnabled: true, nowMs },
      }),
    ).toBeNull();
  });

  it("shows the queue entry once the thread stops", () => {
    expect(
      describeCardQueue({
        card: active("a1"),
        hasLiveSkillJob: false,
        context: { ...withWatch(watch()), nextTickAtMs: nowMs + 12_000 },
      }),
    ).toMatchObject({ label: "Queued · Judging transcript · 12s", tone: "queued" });
  });

  it("counts the looks that changed nothing, and when the next one lands", () => {
    expect(
      describeCardQueue({
        card: active("a1"),
        hasLiveSkillJob: false,
        context: {
          ...withWatch(watch({ reviews: 2, lastReviewAt: "2025-12-31T23:58:00.000Z" })),
          nextModelCheckAtMs: nowMs + 9 * 60_000,
        },
      }),
    ).toMatchObject({ label: "Judging transcript · looked 2× · 9m", tone: "queued" });
  });

  it("escalates a card Hermes keeps judging and never moves", () => {
    expect(
      describeCardQueue({
        card: active("a1"),
        hasLiveSkillJob: false,
        context: withWatch(watch({ reviews: 4, stalled: true })),
      }),
    ).toMatchObject({ label: "Needs you · looked 4×", tone: "blocked" });
  });

  it("does not let a stale applied receipt hide the stall", () => {
    const card = {
      ...active("a1"),
      hermesOperation: {
        id: "op-1",
        method: "updateCard",
        status: "applied",
        attempt: 1,
        detail: "Update card",
        error: null,
        startedAt: DateTime.makeUnsafe("2025-12-31T23:59:00.000Z"),
        finishedAt: DateTime.makeUnsafe("2025-12-31T23:59:55.000Z"),
      } as NonNullable<BoardHermesCardSlice["hermesOperation"]>,
    };
    expect(
      describeCardQueue({
        card,
        hasLiveSkillJob: false,
        context: withWatch(watch({ reviews: 3, stalled: true })),
      }),
    ).toMatchObject({ label: "Needs you · looked 3×", tone: "blocked" });
  });

  it("stays silent when the brain is off", () => {
    expect(
      describeCardQueue({
        card: active("a1"),
        hasLiveSkillJob: false,
        context: { ...withWatch(watch({ reviews: 4, stalled: true })), brainEnabled: false },
      }),
    ).toBeNull();
  });
});

describe("countQueuedCards", () => {
  it("counts only cards a loop will actually pick up", () => {
    const cards = [draft("d1"), draft("d2"), draft("d3")];
    const context: BoardQueueContext = { ...ALL_OFF, autoStructureDrafts: true };
    expect(countQueuedCards(cards, { liveSkillJobIds: new Set(["d3"]), context })).toBe(2);
    expect(countQueuedCards(cards, { liveSkillJobIds: empty, context: ALL_OFF })).toBe(0);
  });
});

describe("describePrChecks", () => {
  const base = {
    cardId: "card-1" as KanbanPrChecks["cardId"],
    total: 4,
    passing: 2,
    failing: 0,
    pending: 2,
    failingNames: [],
    failingUrl: null,
    unknownReason: null,
    unknownDetail: null,
    checkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  };

  it("shows an explicit unknown state before the forge has a verdict", () => {
    expect(describePrChecks(null)).toMatchObject({
      label: "CI unknown",
      tone: "running",
      pulse: true,
    });
    expect(
      describePrChecks({
        ...base,
        state: "unknown",
        unknownReason: "unavailable",
        unknownDetail: "gh auth expired",
      }),
    ).toMatchObject({
      label: "CI unknown · unavailable",
      tone: "running",
      title: "gh auth expired",
    });
  });

  it("does not add a CI badge to cards without a PR", () => {
    expect(describePrChecks(null, false)).toBeNull();
  });

  it("counts finished checks while CI is running", () => {
    const badge = describePrChecks({ ...base, state: "pending" });
    expect(badge?.tone).toBe("running");
    expect(badge?.label).toBe("CI running · 2/4");
    expect(badge?.pulse).toBe(true);
  });

  it("names the red checks", () => {
    const badge = describePrChecks({
      ...base,
      state: "failing",
      failing: 1,
      pending: 0,
      passing: 3,
      failingNames: ["server tests"],
    });
    expect(badge?.tone).toBe("failed");
    expect(badge?.label).toBe("CI failed · 1");
    expect(badge?.title).toContain("server tests");
  });

  it("reads a full green board as passed", () => {
    const badge = describePrChecks({ ...base, state: "passing", passing: 4, pending: 0 });
    expect(badge?.tone).toBe("passed");
    expect(badge?.label).toBe("CI passed · 4");
  });
});

describe("formatTimeInColumn", () => {
  it("reads at the resolution a human cares about", () => {
    expect(formatTimeInColumn(4_000)).toBe("just now");
    expect(formatTimeInColumn(9 * 60_000)).toBe("9m");
    expect(formatTimeInColumn(3 * 3_600_000)).toBe("3h");
    expect(formatTimeInColumn(50 * 3_600_000)).toBe("2d");
  });
});

// The offsets live in KanbanBoard and the height they read is written by
// KanbanPageComposer. Tailwind only sees the class string spelled out, so the
// two ends of that variable cannot be checked by the compiler.
describe("the board's bottom-anchored chrome clears the capture bar", () => {
  it("reads the height the capture bar publishes", () => {
    expect(BOTTOM_ABOVE_CAPTURE_BAR).toContain(`var(${CAPTURE_BAR_HEIGHT_VAR},`);
    expect(BOTTOM_ABOVE_DROP_ZONE).toContain(`var(${CAPTURE_BAR_HEIGHT_VAR},`);
  });

  // A pill at the archive target's own offset lands on top of it mid-drag.
  it("stacks the status pills above the archive target", () => {
    expect(BOTTOM_ABOVE_DROP_ZONE).not.toBe(BOTTOM_ABOVE_CAPTURE_BAR);
  });
});
