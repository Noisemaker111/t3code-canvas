import { describe, expect, it } from "vite-plus/test";

import { countTokens } from "./TokenCounter.ts";

describe("countTokens", () => {
  it("returns 0 for empty or nullish input", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  it("matches known cl100k_base token counts", () => {
    // Reference encodings from tiktoken (cl100k_base):
    //   "hello world"        -> [15339, 1917]
    //   "tiktoken is great!" -> [83, 1609, 5963, 374, 2294, 0]
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("tiktoken is great!")).toBe(6);
  });

  it("counts a bash command with output as real tokens", () => {
    const command = "grep -rn 'usage' apps/server/src";
    const output = Array.from(
      { length: 20 },
      (_, i) => `apps/server/src/file${i}.ts:12: usage`,
    ).join("\n");
    expect(countTokens(`${command}\n${output}`)).toBeGreaterThan(100);
  });

  it("never throws on text containing special-token syntax", () => {
    expect(() => countTokens("before <|endoftext|> after")).not.toThrow();
    expect(countTokens("before <|endoftext|> after")).toBeGreaterThan(0);
  });

  it("stays fast on one unbroken multi-kilobyte word", () => {
    const startedAt = Date.now();
    const tokens = countTokens("x".repeat(40_000));
    expect(tokens).toBeGreaterThan(0);
    // The naive js-tiktoken merge takes minutes on this input.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
