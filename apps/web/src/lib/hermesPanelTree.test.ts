import { describe, expect, it } from "vite-plus/test";
import type { KanbanCard, ProjectId } from "@t3tools/contracts";

import type { HermesFeedRow } from "./hermesChatFeed";
import { buildPanelTree } from "./hermesPanelTree";

const row = (patch: Partial<HermesFeedRow>): HermesFeedRow => ({
  id: "row-1",
  atMs: 0,
  speaker: "hermes",
  label: "Hermes",
  summary: "structured card-8f21 into a mission",
  text: "",
  ...patch,
});

const card = (patch: Partial<KanbanCard>): KanbanCard =>
  ({
    id: "card-8f21",
    title: "Fix Hermes board loop",
    body: "",
    at: "active",
    position: 0,
    threadId: null,
    prUrl: null,
    prTitle: null,
    prNumber: null,
    projectId: "proj-1" as ProjectId,
    modelSelection: null,
    modelRouteReason: null,
    baseBranch: null,
    prepStatus: "ready",
    attachments: [],
    hermesOperation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnEnteredAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...patch,
  }) as KanbanCard;

const projects = new Map<ProjectId, string>([["proj-1" as ProjectId, "vps-code"]]);

describe("buildPanelTree", () => {
  it("nests an action under the project and card its own text names", () => {
    const items = buildPanelTree(
      [row({ summary: "structured card-8f21 into a mission" })],
      [card({})],
      projects,
    );

    expect(items.map((item) => item.type)).toEqual(["project", "card", "action"]);
    expect(items[0]).toMatchObject({ type: "project", title: "vps-code" });
    expect(items[1]).toMatchObject({ type: "card", title: "Fix Hermes board loop" });
  });

  it("only reprints a header when the feed moves to a different project or card", () => {
    const items = buildPanelTree(
      [
        row({ id: "r1", summary: "structured card-8f21 into a mission" }),
        row({ id: "r2", summary: "launched card-8f21 on anthropic/claude-sonnet" }),
      ],
      [card({})],
      projects,
    );

    expect(items.map((item) => item.type)).toEqual(["project", "card", "action", "action"]);
  });

  it("drops the raw board-delta preamble", () => {
    const items = buildPanelTree(
      [row({ speaker: "board", summary: "2 board changes" })],
      [],
      new Map(),
    );
    expect(items).toEqual([]);
  });

  it("keeps an unrouted card in the tree instead of dropping it to a flat line", () => {
    const items = buildPanelTree(
      [row({ summary: "card-8f21: could not route Settings history purge" })],
      [card({ projectId: null })],
      projects,
    );

    expect(items.map((item) => item.type)).toEqual(["project", "card", "action"]);
    expect(items[0]).toMatchObject({ type: "project", title: "unrouted" });
    expect(items[2]).toMatchObject({ summary: "could not route Settings history purge" });
  });

  it("takes the card id off a line that opens with it, punctuated or not", () => {
    const items = buildPanelTree(
      [
        row({ id: "r1", summary: "card-8f21: could not route" }),
        row({ id: "r2", summary: "card-8f21 opened PR #196" }),
        row({ id: "r3", summary: "merged the work on card-8f21" }),
      ],
      [card({})],
      projects,
    );

    expect(items.filter((item) => item.type === "action").map((item) => item.summary)).toEqual([
      "could not route",
      "opened PR #196",
      "merged the work on card-8f21",
    ]);
  });

  it("matches a card by its short id prefix and by its title", () => {
    const long = card({ id: "e6b09259-4270-4d0e-96e3-57a414919143" as KanbanCard["id"] });
    const byPrefix = buildPanelTree([row({ summary: "e6b09259 launched" })], [long], projects);
    const byTitle = buildPanelTree(
      [row({ summary: "Fix Hermes board loop is done — opened PR #196" })],
      [long],
      projects,
    );

    expect(byPrefix.map((item) => item.type)).toEqual(["project", "card", "action"]);
    expect(byTitle.map((item) => item.type)).toEqual(["project", "card", "action"]);
  });

  it("carries the card's PR number onto its header", () => {
    const items = buildPanelTree(
      [row({ summary: "structured card-8f21 into a mission" })],
      [card({ prNumber: 196 })],
      projects,
    );
    expect(items[1]).toMatchObject({ type: "card", prNumber: 196 });
  });

  it("stands a row alone when it names no live card", () => {
    const solo = row({ summary: "PR #196 is open but checks have not reported yet" });
    const items = buildPanelTree([solo], [card({})], projects);
    expect(items).toEqual([{ type: "standalone", row: solo, repeat: 1 }]);
  });

  it("collapses the rules heartbeat repeated every tick into one counted line", () => {
    const heartbeat = (id: string) => row({ id, summary: "4 rule actions · no model needed" });
    const items = buildPanelTree(
      [heartbeat("h1"), heartbeat("h2"), heartbeat("h3")],
      [card({})],
      projects,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "standalone", repeat: 3 });
  });

  it("keeps you and thread rows out of the project tree", () => {
    const items = buildPanelTree(
      [
        row({ id: "r1", speaker: "you", summary: "why is this still open?" }),
        row({ id: "r2", summary: "structured card-8f21 into a mission" }),
      ],
      [card({})],
      projects,
    );

    expect(items[0]).toMatchObject({ type: "you" });
    expect(items[1]).toMatchObject({ type: "project" });
  });
});
