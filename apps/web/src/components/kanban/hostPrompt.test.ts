import { describe, expect, it } from "vite-plus/test";

import { deriveHostThreadTitle, parseHostPrompt } from "./hostPrompt";

describe("parseHostPrompt", () => {
  it("treats a leading ! as a host thread", () => {
    expect(parseHostPrompt("! fix cursor-agent auth")).toEqual({
      isHost: true,
      text: "fix cursor-agent auth",
    });
  });

  it("allows leading whitespace before the !", () => {
    expect(parseHostPrompt("\n  !ship it")).toEqual({ isHost: true, text: "ship it" });
  });

  it("reports empty text for a bare !", () => {
    expect(parseHostPrompt("!   ")).toEqual({ isHost: true, text: "" });
  });

  it("leaves other prompts to Hermes", () => {
    expect(parseHostPrompt("  add a card! ")).toEqual({ isHost: false, text: "add a card!" });
  });
});

describe("deriveHostThreadTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveHostThreadTitle("\nfix   cursor-agent\nthen merge")).toBe("fix cursor-agent");
  });

  it("truncates long titles", () => {
    expect(deriveHostThreadTitle("a".repeat(80))).toBe(`${"a".repeat(59)}…`);
  });

  it("falls back when there is no text", () => {
    expect(deriveHostThreadTitle("   ")).toBe("Host thread");
  });
});
