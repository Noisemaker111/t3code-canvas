import { describe, expect, it } from "vite-plus/test";

import { hermesPingMessage } from "./hermesPing";

describe("hermesPingMessage", () => {
  it("carries the bare card id, which is how Hermes resolves the card", () => {
    const text = hermesPingMessage({ cardId: "card_01H", title: "fix the composer" });
    expect(text).toContain("card_01H");
    expect(text).toContain('"fix the composer"');
    expect(text.endsWith("?")).toBe(true);
  });

  it("still names the card when the title is empty", () => {
    expect(hermesPingMessage({ cardId: "card_02H", title: "   " })).toContain("card_02H");
  });
});

/**
 * One ping path. Two bells that each built their own message would drift, and a
 * message that stops carrying the card id silently stops carrying the card's
 * history — so both surfaces go through `lib/hermesPing`.
 */
describe("both bells share one ping", () => {
  const sources = import.meta.glob(
    ["../components/chat/ChatHeader.tsx", "../components/kanban/KanbanBoard.tsx"],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  it("neither surface writes its own Hermes message", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} must ping through lib/hermesPing`).toContain("useHermesPing");
      expect(source, `${name} must not post its own message to Hermes`).not.toContain(
        'target: "hermes"',
      );
    }
  });
});
