import { describe, expect, it } from "@effect/vitest";

import { component } from "./component.ts";
import { backlog, inReview, running, STATUS_VIEWS, viewCards } from "./views.ts";

const card = (at: string, over: { threadId?: string; prUrl?: string } = {}) => ({
  at,
  threadId: over.threadId ?? null,
  prUrl: over.prUrl ?? null,
  prepStatus: "ready",
});

const board = [
  card("prompts"),
  card("research"),
  card("active", { threadId: "t1" }),
  card("pr", { threadId: "t2", prUrl: "https://x/pr/1" }),
  // Sent back to fix red CI: it keeps its pull request, so it is still in review.
  card("active", { threadId: "t3", prUrl: "https://x/pr/2" }),
];

describe("status views", () => {
  it("asks a question of the cards instead of naming a place", () => {
    expect(viewCards(backlog, board).map((entry) => entry.at)).toEqual(["prompts", "research"]);
    expect(viewCards(running, board).map((entry) => entry.threadId)).toEqual(["t1"]);
    expect(viewCards(inReview, board).map((entry) => entry.threadId)).toEqual(["t2", "t3"]);
  });

  // A prompt dragged somewhere else has still not been started. A view that
  // missed it would be lying about the board.
  it("finds an unstarted card wherever it is sitting", () => {
    expect(viewCards(backlog, [card("research")])).toHaveLength(1);
  });

  it("shows one card in every view that matches it", () => {
    const sentBack = card("active", { threadId: "t3", prUrl: "https://x/pr/2" });
    const showing = STATUS_VIEWS.filter((view) => viewCards(view, [sentBack]).length > 0);
    expect(showing.map((view) => view.title)).toEqual(["In review"]);
  });

  // Asking a place to match cards is a category error, and answering "all of
  // them" would quietly put every card in every panel.
  it("shows nothing for a component that holds cards rather than matching them", () => {
    expect(viewCards(component({ title: "Active" }), board)).toEqual([]);
  });
});
