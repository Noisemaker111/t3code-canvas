import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_ROW_KEYS, terminalControlByte } from "./terminal-key-row";

describe("terminalControlByte", () => {
  it("folds letters the way a terminal does, in either case", () => {
    expect(terminalControlByte("c")).toBe("\u0003");
    expect(terminalControlByte("C")).toBe("\u0003");
    expect(terminalControlByte("d")).toBe("\u0004");
    expect(terminalControlByte("z")).toBe("\u001a");
    expect(terminalControlByte("a")).toBe("\u0001");
  });

  it("covers the punctuation that has a control code", () => {
    expect(terminalControlByte("[")).toBe("\u001b");
    expect(terminalControlByte("\\")).toBe("\u001c");
    expect(terminalControlByte("@")).toBe("\u0000");
    expect(terminalControlByte("_")).toBe("\u001f");
  });

  it("has no answer for a key with no control code", () => {
    expect(terminalControlByte("1")).toBeNull();
    expect(terminalControlByte("é")).toBeNull();
    expect(terminalControlByte("")).toBeNull();
    expect(terminalControlByte("ab")).toBeNull();
  });
});

describe("TERMINAL_ROW_KEYS", () => {
  it("arms on ctrl alone and sends bytes for everything else", () => {
    const armed = TERMINAL_ROW_KEYS.filter((key) => key.data === null);

    expect(armed.map((key) => key.id)).toEqual(["ctrl"]);
    expect(TERMINAL_ROW_KEYS.find((key) => key.id === "esc")?.data).toBe("\u001b");
    expect(TERMINAL_ROW_KEYS.find((key) => key.id === "up")?.data).toBe("\u001b[A");
  });
});
