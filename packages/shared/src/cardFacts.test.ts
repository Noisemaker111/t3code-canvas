import { describe, expect, it } from "@effect/vitest";

import { hasPr, hasThread, isRouted, isUnstarted, latestLayer } from "./cardFacts.ts";

describe("cardFacts", () => {
  it("reads a thread off the card, not off a lane", () => {
    expect(hasThread({ threadId: "t1" })).toBe(true);
    expect(hasThread({ threadId: null })).toBe(false);
    expect(hasThread({ threadId: "" })).toBe(false);
    expect(hasThread({})).toBe(false);
  });

  it("reads a pull request off the card", () => {
    expect(hasPr({ prUrl: "https://example.test/pr/1" })).toBe(true);
    expect(hasPr({ prUrl: null })).toBe(false);
    expect(hasPr({})).toBe(false);
  });

  it("counts a prompt mid-structure as routed", () => {
    expect(isRouted({ prepStatus: "ready" })).toBe(true);
    expect(isRouted({ prepStatus: "processing" })).toBe(true);
    expect(isRouted({ prepStatus: "untouched" })).toBe(false);
    expect(isRouted({})).toBe(false);
  });

  it("calls a card nobody has started unstarted", () => {
    expect(isUnstarted({ prepStatus: "ready" })).toBe(true);
    expect(isUnstarted({ threadId: "t1" })).toBe(false);
    // A pull request dragged off a review panel: no thread, but work exists.
    expect(isUnstarted({ prUrl: "https://example.test/pr/1" })).toBe(false);
  });

  describe("latestLayer", () => {
    it("is the prompt until an agent picks it up", () => {
      expect(latestLayer({ prepStatus: "ready" })).toBe("prompt");
    });

    it("is the thread once one is running", () => {
      expect(latestLayer({ threadId: "t1" })).toBe("thread");
    });

    it("is the pull request once the work is pushed", () => {
      expect(latestLayer({ threadId: "t1", prUrl: "https://example.test/pr/1" })).toBe("pr");
    });

    // A card sent back to fix red CI keeps its PR, and its face should still
    // read from it — the CI state is the thing worth seeing.
    it("stays on the pull request for a card sent back to its thread", () => {
      expect(latestLayer({ threadId: "t1", prUrl: "https://example.test/pr/1" })).toBe("pr");
    });
  });
});
