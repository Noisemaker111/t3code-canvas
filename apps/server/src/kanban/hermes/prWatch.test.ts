import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { BoardOpenPr } from "./boardApi.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { reconcileOpenPrs, resetPrWatch, sweepOrphanPrs } from "./prWatch.ts";

const openPr = (number: number, title: string): BoardOpenPr => ({
  number,
  title,
  url: `https://github.com/own/vps-code/pull/${number}`,
  headRefName: `feature-${number}`,
  baseRefName: "main",
  state: "open",
});

const project = {
  id: "proj-1",
  name: "vps-code",
  workspaceRoot: "/root/vps-code",
  repo: "own/vps-code",
};

describe("sweepOrphanPrs", () => {
  beforeEach(() => resetPrWatch());

  it("adopts each open PR that has no live card", async () => {
    const { api, state } = makeFakeBoardApi({
      projects: [project],
      openPrs: { "proj-1": [openPr(12, "Fix the board")] },
    });

    const adopted = await sweepOrphanPrs({ api, cards: state.cards, nowMs: 1_000 });

    expect(adopted).toHaveLength(1);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({
      at: "pr",
      projectId: "proj-1",
      prNumber: 12,
      prTitle: "Fix the board",
      prUrl: "https://github.com/own/vps-code/pull/12",
    });
  });

  it("reconciles directly without Hermes settings or a brain tick", async () => {
    const { api, state } = makeFakeBoardApi({
      projects: [project],
      openPrs: { "proj-1": [openPr(12, "Fix the board")] },
    });

    expect(await reconcileOpenPrs(api, 1_000)).toMatchObject([
      { cardId: "card-1", log: "adopted own/vps-code#12", ok: true },
    ]);
    expect(state.cards[0]).toMatchObject({ at: "pr", prNumber: 12 });
  });

  it("does not let an archived card suppress an open PR", async () => {
    const pr = openPr(12, "Fix the board");
    const archived = makeFakeCard({ id: "old", at: "pr", prUrl: pr.url });
    const archivedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const { api, state } = makeFakeBoardApi({
      cards: [{ ...archived, archivedAt }],
      projects: [project],
      openPrs: { "proj-1": [pr] },
    });

    await sweepOrphanPrs({ api, cards: state.cards, nowMs: 1_000 });

    expect(state.cards).toHaveLength(2);
    expect(state.cards.at(-1)?.prUrl).toBe(pr.url);
  });

  it("deduplicates by PR URL and throttles successful sweeps", async () => {
    const pr = openPr(12, "Fix the board");
    const live = makeFakeCard({
      id: "live",
      at: "pr",
      prUrl: `${pr.url}/`,
      prNumber: pr.number,
      prTitle: pr.title,
    });
    const { api, state } = makeFakeBoardApi({
      cards: [live],
      projects: [project],
      openPrs: { "proj-1": [pr] },
    });

    expect(await sweepOrphanPrs({ api, cards: state.cards, nowMs: 1_000 })).toEqual([]);
    expect(await sweepOrphanPrs({ api, cards: state.cards, nowMs: 2_000 })).toEqual([]);
    expect(state.cards).toHaveLength(1);
  });

  it("repairs a live card left without PR identity after partial adoption", async () => {
    const pr = openPr(12, "Fix the board");
    const partial = makeFakeCard({
      id: "partial",
      at: "pr",
      body: `Open pull request\n${project.repo}#12: ${pr.url}`,
    });
    const { api, state } = makeFakeBoardApi({
      cards: [partial],
      projects: [project],
      openPrs: { "proj-1": [pr] },
    });

    expect(await sweepOrphanPrs({ api, cards: state.cards, nowMs: 1_000 })).toMatchObject([
      { cardId: "partial", log: "repaired own/vps-code#12", ok: true },
    ]);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({
      prNumber: 12,
      prTitle: "Fix the board",
      prUrl: pr.url,
    });
  });
});
