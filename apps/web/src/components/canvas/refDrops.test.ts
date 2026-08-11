import { describe, expect, it } from "@effect/vitest";

import {
  issueRefDragData,
  issueRefFromDrag,
  prRefDragData,
  prRefDragId,
  prRefFromDrag,
  resolveIssueRefDrop,
  resolvePrRefDrop,
  type IssueRef,
  type PrRef,
} from "./refDrops";

const pr: PrRef = {
  repo: "Noisemaker111/vps-code",
  projectId: "p1",
  number: 214,
  title: "Panel registry",
  url: "https://github.com/Noisemaker111/vps-code/pull/214",
  headRefName: "claude/panels",
  baseRefName: "main",
};

const issue: IssueRef = {
  repo: "Noisemaker111/vps-code",
  projectId: "p1",
  number: 88,
  title: "Areas are noise",
  url: "https://github.com/Noisemaker111/vps-code/issues/88",
  labels: ["board"],
};

describe("the pr-ref payload", () => {
  it("round-trips through a drag", () => {
    expect(prRefFromDrag(prRefDragData(pr))).toEqual(pr);
    expect(prRefDragId(pr)).toBe("pr-ref:Noisemaker111/vps-code#214");
  });

  it("does not read a card drag as a pull request", () => {
    expect(prRefFromDrag({ column: "active" })).toBeNull();
    expect(prRefFromDrag(null)).toBeNull();
    expect(prRefFromDrag({ kind: "pr-ref" })).toBeNull();
  });
});

describe("resolvePrRefDrop", () => {
  const active = prRefDragData(pr);

  it("takes the column the droppable names", () => {
    expect(resolvePrRefDrop({ active, over: { id: "pr", column: "pr" } })).toEqual({
      pr,
      column: "pr",
    });
  });

  it("falls back to the droppable id when it carries no column", () => {
    expect(resolvePrRefDrop({ active, over: { id: "done" } })?.column).toBe("done");
  });

  it("is nothing for a drop on bare canvas, and nothing for a card drag", () => {
    expect(resolvePrRefDrop({ active, over: null })).toBeNull();
    expect(resolvePrRefDrop({ active: { column: "pr" }, over: { id: "pr" } })).toBeNull();
  });
});

describe("resolveIssueRefDrop", () => {
  it("resolves an issue row onto a column", () => {
    expect(
      resolveIssueRefDrop({ active: issueRefDragData(issue), over: { id: "prompts" } }),
    ).toEqual({ issue, column: "prompts" });
  });

  it("does not read a pull request drag as an issue", () => {
    expect(issueRefFromDrag(prRefDragData(pr))).toBeNull();
  });
});
