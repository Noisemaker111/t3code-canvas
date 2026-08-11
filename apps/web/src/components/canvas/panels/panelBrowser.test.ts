import { PreviewTabId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardBrowserThreadId,
  browserEntityId,
  browserPanelTitle,
  parseBrowserTabRef,
} from "./panelBrowser";

describe("panelBrowser entity ids", () => {
  it("round-trips thread and tab ids, including separators in the tab id", () => {
    const ref = {
      threadId: ThreadId.make("thread/one:two"),
      tabId: PreviewTabId.make("tab with spaces/and:colons"),
    };
    expect(parseBrowserTabRef(browserEntityId(ref))).toEqual(ref);
  });

  it("treats the empty entity id as the board browser", () => {
    expect(parseBrowserTabRef("")).toBeNull();
    expect(browserPanelTitle("")).toBe("Browser");
  });

  it("rejects malformed entity ids instead of guessing", () => {
    expect(parseBrowserTabRef("no-separator")).toBeNull();
    expect(parseBrowserTabRef("/leading")).toBeNull();
    expect(parseBrowserTabRef("trailing/")).toBeNull();
  });

  it("titles a board-browser tab plainly and an agent tab by its thread", () => {
    const board = browserEntityId({
      threadId: boardBrowserThreadId,
      tabId: PreviewTabId.make("tab-1"),
    });
    expect(browserPanelTitle(board)).toBe("Browser");
    const agent = browserEntityId({
      threadId: ThreadId.make("thread-abcdef1234"),
      tabId: PreviewTabId.make("tab-2"),
    });
    expect(browserPanelTitle(agent)).toBe("Browser thread-a");
  });
});
