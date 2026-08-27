import { describe, expect, it } from "vite-plus/test";

import {
  decodeLinks,
  encodeLinks,
  linkPath,
  panelLinks,
  type LinkablePanel,
} from "./panelLinksLogic";
import { threadTerminalEntityId } from "./panelTerminal";
import { browserEntityId } from "./panelBrowser";
import { PreviewTabId, ThreadId } from "@t3tools/contracts";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 50 });

const thread = (entityId: string, x: number, y: number): LinkablePanel => ({
  key: `thread:${entityId}`,
  kind: "thread",
  entityId,
  box: box(x, y),
});

describe("panelLinks", () => {
  it("links a thread to the terminals and tabs it opened", () => {
    const terminal: LinkablePanel = {
      key: "term",
      kind: "terminal",
      entityId: threadTerminalEntityId({ threadId: "thread-a", terminalId: "term-1" }),
      box: box(0, 400),
    };
    const tab: LinkablePanel = {
      key: "tab",
      kind: "browser",
      entityId: browserEntityId({
        threadId: ThreadId.make("thread-a"),
        tabId: PreviewTabId.make("tab-1"),
      }),
      box: box(200, 400),
    };
    const links = panelLinks([thread("thread-a", 0, 0), terminal, tab]);
    expect(links.map((link) => link.key)).toEqual(["term", "tab"]);
    // Out of the bottom of the thread, into the top of what it opened.
    expect(links[0]?.from).toEqual({ x: 50, y: 50 });
    expect(links[0]?.to).toEqual({ x: 50, y: 400 });
  });

  it("draws nothing for a shell the human opened or a thread with no panel", () => {
    const hostShell: LinkablePanel = {
      key: "host",
      kind: "terminal",
      entityId: "term-2",
      box: box(0, 400),
    };
    const orphan: LinkablePanel = {
      key: "orphan",
      kind: "terminal",
      entityId: threadTerminalEntityId({ threadId: "thread-gone", terminalId: "term-1" }),
      box: box(0, 400),
    };
    expect(panelLinks([thread("thread-a", 0, 0), hostShell, orphan])).toEqual([]);
  });

  it("round-trips a link set through the string the layer compares", () => {
    const links = [{ key: "shape:a", from: { x: 1.5, y: -2 }, to: { x: 3, y: 4 } }];
    expect(decodeLinks(encodeLinks(links))).toEqual(links);
    expect(decodeLinks("")).toEqual([]);
  });

  it("leaves both ends of the curve vertical", () => {
    const path = linkPath({ key: "k", from: { x: 0, y: 0 }, to: { x: 300, y: 500 } });
    expect(path).toBe("M 0 0 C 0 140, 300 360, 300 500");
  });
});
