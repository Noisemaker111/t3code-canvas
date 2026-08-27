import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_TERMINAL_INPUT_TRACKER_STATE,
  appendTerminalHistory,
  applyTerminalInputData,
  isSuggestionAcceptKey,
  matchTerminalSuggestion,
  readStoredTerminalHistory,
  terminalSuggestionSuffix,
  writeStoredTerminalHistory,
} from "./terminal-autosuggest";

const initial = INITIAL_TERMINAL_INPUT_TRACKER_STATE;

function type(data: string) {
  return applyTerminalInputData(initial, data);
}

describe("applyTerminalInputData", () => {
  it("tracks printable input", () => {
    expect(type("git status").state).toEqual({ line: "git status", tracking: true });
  });

  it("applies backspace edits", () => {
    expect(type("git\u007f\u007f").state.line).toBe("g");
  });

  it("commits the line on Enter and resets", () => {
    const result = type("git status\r");
    expect(result.committed).toEqual(["git status"]);
    expect(result.state).toEqual({ line: "", tracking: true });
  });

  it("does not commit blank lines", () => {
    expect(type("   \r").committed).toEqual([]);
  });

  it("clears the line on Ctrl+C and Ctrl+U", () => {
    expect(type("git st\u0003").state).toEqual({ line: "", tracking: true });
    expect(type("git st\u0015").state.line).toBe("");
  });

  it("removes the trailing word on Ctrl+W", () => {
    expect(type("git checkout main\u0017").state.line).toBe("git checkout ");
  });

  it("suspends tracking on escape sequences until the next prompt", () => {
    const suspended = type("git\u001b[A");
    expect(suspended.state).toEqual({ line: "", tracking: false });
    const stillSuspended = applyTerminalInputData(suspended.state, "more");
    expect(stillSuspended.state.tracking).toBe(false);
    const resumed = applyTerminalInputData(stillSuspended.state, "\r");
    expect(resumed.state).toEqual({ line: "", tracking: true });
    expect(resumed.committed).toEqual([]);
  });

  it("suspends tracking on tab completion", () => {
    const result = type("git chec\t");
    expect(result.state.tracking).toBe(false);
  });

  it("handles multi-character chunks with multiple commits", () => {
    const result = type("ls\rpwd\r");
    expect(result.committed).toEqual(["ls", "pwd"]);
  });
});

describe("matchTerminalSuggestion", () => {
  const history = ["git status", "git checkout main", "pnpm test"];

  it("returns the most recent entry extending the input", () => {
    expect(matchTerminalSuggestion(history, "git")).toBe("git checkout main");
    expect(matchTerminalSuggestion(history, "git s")).toBe("git status");
  });

  it("requires a minimum input length", () => {
    expect(matchTerminalSuggestion(history, "g")).toBeNull();
    expect(matchTerminalSuggestion(history, " ")).toBeNull();
  });

  it("never suggests an exact match of the input", () => {
    expect(matchTerminalSuggestion(history, "pnpm test")).toBeNull();
  });

  it("ignores input with leading whitespace", () => {
    expect(matchTerminalSuggestion(history, "  git")).toBeNull();
  });

  it("computes the ghost-text suffix", () => {
    expect(terminalSuggestionSuffix(history, "git sta")).toBe("tus");
    expect(terminalSuggestionSuffix(history, "nope")).toBeNull();
  });
});

describe("appendTerminalHistory", () => {
  it("appends trimmed commands and dedupes existing entries", () => {
    expect(appendTerminalHistory(["ls -la", "pwd"], "  ls -la  ")).toEqual(["pwd", "ls -la"]);
  });

  it("ignores commands that are too short", () => {
    expect(appendTerminalHistory(["pwd"], "x")).toEqual(["pwd"]);
  });

  it("caps the history at the limit", () => {
    const capped = appendTerminalHistory(["aa", "bb", "cc"], "dd", 3);
    expect(capped).toEqual(["bb", "cc", "dd"]);
  });
});

describe("stored terminal history", () => {
  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    writeStoredTerminalHistory(storage, ["git status", "pnpm test"]);
    expect(readStoredTerminalHistory(storage)).toEqual(["git status", "pnpm test"]);
  });

  it("tolerates missing or corrupt storage", () => {
    expect(readStoredTerminalHistory(undefined)).toEqual([]);
    expect(readStoredTerminalHistory({ getItem: () => "not json {" })).toEqual([]);
    expect(readStoredTerminalHistory({ getItem: () => '{"a":1}' })).toEqual([]);
  });
});

describe("isSuggestionAcceptKey", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("accepts plain ArrowRight and End keydowns", () => {
    expect(isSuggestionAcceptKey({ ...base, type: "keydown", key: "ArrowRight" })).toBe(true);
    expect(isSuggestionAcceptKey({ ...base, type: "keydown", key: "End" })).toBe(true);
  });

  it("rejects modified keys, other keys, and non-keydown events", () => {
    expect(
      isSuggestionAcceptKey({ ...base, type: "keydown", key: "ArrowRight", ctrlKey: true }),
    ).toBe(false);
    expect(isSuggestionAcceptKey({ ...base, type: "keydown", key: "Tab" })).toBe(false);
    expect(isSuggestionAcceptKey({ ...base, type: "keyup", key: "ArrowRight" })).toBe(false);
  });
});
