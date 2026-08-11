import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadTerminalRef,
  terminalPanelTitle,
  threadTerminalEntityId,
} from "./panelTerminal";

describe("panelTerminal entity ids", () => {
  it("round-trips a thread's shell, separators included", () => {
    const ref = { threadId: "thread/one:two", terminalId: "term-1" };
    expect(parseThreadTerminalRef(threadTerminalEntityId(ref))).toEqual(ref);
  });

  it("reads a bare id as the host console's own shell", () => {
    expect(parseThreadTerminalRef("term-3")).toBeNull();
    expect(parseThreadTerminalRef("")).toBeNull();
    expect(terminalPanelTitle("")).toBe("Terminal");
  });

  it("names a thread's shell after the thread it belongs to", () => {
    const entityId = threadTerminalEntityId({
      threadId: "thread-abcdef1234",
      terminalId: "term-2",
    });
    expect(terminalPanelTitle(entityId)).toBe("Terminal 2 thread-a");
  });
});
