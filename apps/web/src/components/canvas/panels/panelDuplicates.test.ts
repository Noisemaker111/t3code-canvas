import { describe, expect, it } from "vite-plus/test";

import { knownTerminalIdsForMint, resolveDuplicatePanel } from "./panelDuplicates";

describe("resolveDuplicatePanel", () => {
  it("keeps a panel whose station is new to the page", () => {
    expect(resolveDuplicatePanel({ kind: "terminal", entityId: "" }, new Set(), [])).toEqual({
      action: "keep",
    });
    expect(
      resolveDuplicatePanel({ kind: "thread", entityId: "t1" }, new Set(["thread:t2"]), []),
    ).toEqual({ action: "keep" });
  });

  it("retargets a duplicated terminal to a fresh shell id", () => {
    const result = resolveDuplicatePanel(
      { kind: "terminal", entityId: "" },
      new Set(["terminal"]),
      ["term-1", "term-2"],
    );
    expect(result).toEqual({ action: "retarget", entityId: "term-3" });
  });

  it("retargets a duplicated single-shell panel the same way", () => {
    const result = resolveDuplicatePanel(
      { kind: "terminal", entityId: "term-2" },
      new Set(["terminal", "terminal:term-2"]),
      ["term-1", "term-2"],
    );
    expect(result).toEqual({ action: "retarget", entityId: "term-3" });
  });

  it("drops duplicates of every other kind", () => {
    expect(
      resolveDuplicatePanel({ kind: "settings", entityId: "" }, new Set(["settings"]), []),
    ).toEqual({ action: "drop" });
    expect(
      resolveDuplicatePanel({ kind: "thread", entityId: "t1" }, new Set(["thread:t1"]), []),
    ).toEqual({ action: "drop" });
  });
});

describe("knownTerminalIdsForMint", () => {
  it("unions store ids with terminal panel entity ids", () => {
    expect(
      knownTerminalIdsForMint(
        [
          { kind: "terminal", entityId: "" },
          { kind: "terminal", entityId: "term-4" },
          { kind: "thread", entityId: "x" },
        ],
        ["term-1"],
      ),
    ).toEqual(["term-1", "term-4"]);
  });
});
