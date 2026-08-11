import { describe, expect, it } from "@effect/vitest";

import { measuredClaimsIn, stripMeasuredClaims } from "./rosterRuleClaims.ts";

describe("roster rules cannot state speed or cost", () => {
  it("strips speed and cost off a real rule, keeping the judgment", () => {
    // Verbatim from the roster this guard was written for. What the owner knows
    // survives; what the box measures every turn does not.
    expect(stripMeasuredClaims("Very fast, Low IQ, intern level coding")).toBe(
      "Low IQ, intern level coding",
    );
    expect(stripMeasuredClaims("Slow, High IQ, good coder, $$$")).toBe("High IQ, good coder");
    expect(stripMeasuredClaims("Slow, Super High IQ, SOTA, best coder, use for migrations")).toBe(
      "Super High IQ, SOTA, best coder, use for migrations",
    );
  });

  it("keeps the owner's read on a model, which no feed covers for most of the roster", () => {
    for (const rule of [
      "amazing at design",
      "best planner on the roster",
      "great at designing, hand it anything visual",
      "SOTA, use for migrations",
      "intern level coding, small mechanical edits only",
    ]) {
      expect(measuredClaimsIn(rule)).toEqual([]);
      expect(stripMeasuredClaims(rule)).toBe(rule);
    }
  });

  it("names each claim and the measurement that already answers it", () => {
    expect(measuredClaimsIn("Very fast, amazing at design, $$$, front-end work")).toEqual([
      { kind: "speed", text: "Very fast" },
      { kind: "cost", text: "$$$" },
    ]);
  });

  it("leaves a rule that only says what the seat is for", () => {
    const rule = "UI and front-end work, prefer for anything touching the canvas";
    expect(measuredClaimsIn(rule)).toEqual([]);
    expect(stripMeasuredClaims(rule)).toBe(rule);
  });

  it("drops only the offending clause, not the sentence around it", () => {
    expect(stripMeasuredClaims("cheap, use for docs and changelogs")).toBe(
      "use for docs and changelogs",
    );
    expect(stripMeasuredClaims("terminal and ops work; fastest on the roster")).toBe(
      "terminal and ops work",
    );
  });

  it("catches a speed claim written as a rate, which is the same guess", () => {
    expect(measuredClaimsIn("200 tok/s, use for bulk edits")).toEqual([
      { kind: "speed", text: "200 tok/s" },
    ]);
  });

  it("does not fire on ordinary routing words", () => {
    for (const rule of [
      "planning and decomposition, hand it multi-step cards",
      "use when a card names a specific file",
      "review passes on an open PR",
    ]) {
      expect(measuredClaimsIn(rule)).toEqual([]);
    }
  });
});
