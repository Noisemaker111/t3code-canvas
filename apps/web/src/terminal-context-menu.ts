import type { ContextMenuItem } from "@t3tools/contracts";

export type TerminalContextMenuItemId = "add-to-chat" | "copy" | "paste" | "select-all" | "clear";

export interface TerminalContextMenuOptions {
  readonly hasSelection: boolean;
  readonly canPaste: boolean;
}

/** Items for the terminal right-click menu, in display order. */
export function buildTerminalContextMenuItems(
  options: TerminalContextMenuOptions,
): ContextMenuItem<TerminalContextMenuItemId>[] {
  const { hasSelection, canPaste } = options;
  const items: ContextMenuItem<TerminalContextMenuItemId>[] = [];
  if (hasSelection) {
    items.push({ id: "add-to-chat", label: "Add to chat", icon: "pencil" });
    items.push({ id: "copy", label: "Copy", icon: "copy" });
  }
  items.push({ id: "paste", label: "Paste", ...(canPaste ? {} : { disabled: true }) });
  items.push({ id: "select-all", label: "Select all" });
  items.push({ id: "clear", label: "Clear terminal", icon: "trash" });
  return items;
}
