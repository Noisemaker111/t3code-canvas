import { describe, expect, it } from "vite-plus/test";

import {
  forgetTerminalOutput,
  publishTerminalOutput,
  resetTerminalOutput,
  retainedTerminalOutput,
  subscribeTerminalOutput,
  terminalOutputKey,
  trimTerminalBuffer,
} from "./terminalOutput.ts";

const KEY = terminalOutputKey({ threadId: "thread-1", terminalId: "term-1" });

describe("terminal output mailbox", () => {
  it("hands each chunk to every surface and keeps them out of the retained diff", () => {
    forgetTerminalOutput(KEY);
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeTerminalOutput(KEY, (chunk) => seen.push(chunk));

    publishTerminalOutput(KEY, "one ");
    publishTerminalOutput(KEY, "two");
    unsubscribe();
    publishTerminalOutput(KEY, " three");

    expect(seen).toEqual(["one ", "two"]);
    expect(retainedTerminalOutput(KEY)).toBe("one two three");
    forgetTerminalOutput(KEY);
  });

  it("a reset replaces the buffer and tells surfaces to re-read", () => {
    forgetTerminalOutput(KEY);
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeTerminalOutput(KEY, (chunk) => seen.push(chunk));

    publishTerminalOutput(KEY, "stale");
    resetTerminalOutput(KEY, "fresh history");

    // The replacement arrives as "re-read", never as a chunk: appending it
    // would show the scrollback twice.
    expect(seen).toEqual(["stale", null]);
    expect(retainedTerminalOutput(KEY)).toBe("fresh history");
    unsubscribe();
    forgetTerminalOutput(KEY);
  });

  it("forgetting a session drops its scrollback", () => {
    forgetTerminalOutput(KEY);
    publishTerminalOutput(KEY, "gone");
    forgetTerminalOutput(KEY);

    expect(retainedTerminalOutput(KEY)).toBe("");
  });

  it("caps retained output by UTF-8 byte length without splitting characters", () => {
    forgetTerminalOutput(KEY);
    publishTerminalOutput(KEY, "🙂🙂🙂", 9);

    // 12 bytes overflows the 9-byte cap; trimming to 90% (8 bytes) snaps forward
    // to the next emoji boundary, keeping the two most recent whole characters.
    expect(retainedTerminalOutput(KEY)).toBe("🙂🙂");
    forgetTerminalOutput(KEY);
  });

  it("trims to a line boundary so the retained head holds no partial escape sequence", () => {
    forgetTerminalOutput(KEY);
    publishTerminalOutput(KEY, "first line\n\u001b[38;5;12mblue line\u001b[0m\nlast\n", 24);

    // The 90% cut (21 bytes) lands inside `ESC [ 3 8 ; 5 ; 1 2 m`; keeping it
    // would replay `5;12mblue line` and print the sequence's tail as text.
    expect(retainedTerminalOutput(KEY)).toBe("last\n");
    expect(retainedTerminalOutput(KEY)).not.toContain("5;12m");
    forgetTerminalOutput(KEY);
  });

  it("keeps the code-point boundary when there is no line to cut at", () => {
    expect(trimTerminalBuffer("hello", 3).buffer).toBe("llo");
  });
});
