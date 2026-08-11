import { describe, expect, it } from "vite-plus/test";

import {
  appendPromptHistory,
  nextPromptHistoryIndex,
  readStoredPromptHistory,
  writeStoredPromptHistory,
} from "./promptHistory";

describe("appendPromptHistory", () => {
  it("appends trimmed prompts and dedupes existing entries", () => {
    expect(appendPromptHistory(["Fix the badge", "ship it"], "  Fix the badge  ")).toEqual([
      "ship it",
      "Fix the badge",
    ]);
  });

  it("ignores blank prompts", () => {
    expect(appendPromptHistory(["ship it"], "   ")).toEqual(["ship it"]);
  });

  it("caps the history at the limit", () => {
    expect(appendPromptHistory(["aa", "bb", "cc"], "dd", 3)).toEqual(["bb", "cc", "dd"]);
  });
});

describe("stored prompt history", () => {
  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    writeStoredPromptHistory(storage, ["one", "two"]);
    expect(readStoredPromptHistory(storage)).toEqual(["one", "two"]);
  });

  it("tolerates missing or corrupt storage", () => {
    expect(readStoredPromptHistory(undefined)).toEqual([]);
    expect(readStoredPromptHistory({ getItem: () => "not json {" })).toEqual([]);
    expect(readStoredPromptHistory({ getItem: () => '{"a":1}' })).toEqual([]);
  });
});

describe("nextPromptHistoryIndex", () => {
  it("starts at the newest entry on older from idle", () => {
    expect(nextPromptHistoryIndex(3, null, "older")).toBe(2);
  });

  it("walks older then stops at the oldest", () => {
    expect(nextPromptHistoryIndex(3, 2, "older")).toBe(1);
    expect(nextPromptHistoryIndex(3, 0, "older")).toBe(0);
  });

  it("walks newer and clears past the newest", () => {
    expect(nextPromptHistoryIndex(3, 0, "newer")).toBe(1);
    expect(nextPromptHistoryIndex(3, 2, "newer")).toBeNull();
    expect(nextPromptHistoryIndex(3, null, "newer")).toBeNull();
  });

  it("returns null when history is empty", () => {
    expect(nextPromptHistoryIndex(0, null, "older")).toBeNull();
  });
});
