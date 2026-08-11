import type { AgentBrowserFrame } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserFrameKey,
  latestAgentBrowserFrame,
  publishAgentBrowserFrame,
  subscribeAgentBrowserFrames,
} from "./agentBrowserFrames.ts";

const frame = (data: string): AgentBrowserFrame => ({
  data,
  deviceWidth: 1280,
  deviceHeight: 800,
});

describe("agent browser frame mailbox", () => {
  it("delivers frames to the tab's painter and holds the newest", () => {
    const key = agentBrowserFrameKey({ threadId: "thread-1", tabId: "tab-1" });
    const seen: Array<string> = [];
    const unsubscribe = subscribeAgentBrowserFrames(key, (next) => seen.push(next.data));
    publishAgentBrowserFrame(key, frame("one"));
    publishAgentBrowserFrame(key, frame("two"));
    expect(seen).toEqual(["one", "two"]);
    expect(latestAgentBrowserFrame(key)?.data).toBe("two");
    unsubscribe();
  });

  it("keeps one tab's frames out of another's", () => {
    const mine = agentBrowserFrameKey({ threadId: "thread-1", tabId: "tab-1" });
    const theirs = agentBrowserFrameKey({ threadId: "thread-1", tabId: "tab-2" });
    const seen: Array<string> = [];
    const unsubscribe = subscribeAgentBrowserFrames(mine, (next) => seen.push(next.data));
    publishAgentBrowserFrame(theirs, frame("theirs"));
    expect(seen).toEqual([]);
    unsubscribe();
  });

  // A held JPEG is up to a megabyte; a tab nobody watches must not keep one.
  it("drops the held frame once the last painter leaves", () => {
    const key = agentBrowserFrameKey({ threadId: "thread-2", tabId: "tab-1" });
    const unsubscribe = subscribeAgentBrowserFrames(key, () => {});
    publishAgentBrowserFrame(key, frame("one"));
    unsubscribe();
    expect(latestAgentBrowserFrame(key)).toBeNull();
  });
});
