import { describe, expect, it } from "vite-plus/test";

import { buildTerminalContextMenuItems } from "./terminal-context-menu";

describe("buildTerminalContextMenuItems", () => {
  it("includes selection actions only when text is selected", () => {
    const withSelection = buildTerminalContextMenuItems({ hasSelection: true, canPaste: true });
    expect(withSelection.map((item) => item.id)).toEqual([
      "add-to-chat",
      "copy",
      "paste",
      "select-all",
      "clear",
    ]);

    const withoutSelection = buildTerminalContextMenuItems({
      hasSelection: false,
      canPaste: true,
    });
    expect(withoutSelection.map((item) => item.id)).toEqual(["paste", "select-all", "clear"]);
  });

  it("disables paste when the clipboard cannot be read", () => {
    const items = buildTerminalContextMenuItems({ hasSelection: false, canPaste: false });
    const paste = items.find((item) => item.id === "paste");
    expect(paste?.disabled).toBe(true);
  });
});
