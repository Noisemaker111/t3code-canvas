import { describe, expect, it } from "vite-plus/test";

import { appendTranscriptToPrompt } from "./localStt";

describe("appendTranscriptToPrompt", () => {
  it("returns spoken text when the prompt is empty", () => {
    expect(appendTranscriptToPrompt("", "  hello board  ")).toBe("hello board");
    expect(appendTranscriptToPrompt("   ", "hello")).toBe("hello");
  });

  it("inserts a space before new speech when needed", () => {
    expect(appendTranscriptToPrompt("Fix the", "composer mic")).toBe("Fix the composer mic");
    expect(appendTranscriptToPrompt("Fix the ", "composer mic")).toBe("Fix the composer mic");
  });

  it("does not add a double space after openers", () => {
    expect(appendTranscriptToPrompt("(", "hello")).toBe("(hello");
    expect(appendTranscriptToPrompt("path/", "file")).toBe("path/file");
  });

  it("ignores empty transcripts", () => {
    expect(appendTranscriptToPrompt("keep me", "   ")).toBe("keep me");
  });
});
