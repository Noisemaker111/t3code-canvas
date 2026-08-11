import { PreviewTabId, ThreadId, type AgentBrowserSessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAgentBrowserAttachStreamEvent,
  applyAgentBrowserSessionsStreamEvent,
  EMPTY_AGENT_BROWSER_VIEW_STATE,
} from "./agentBrowserSession.ts";

const summary = (
  overrides: Partial<AgentBrowserSessionSummary> = {},
): AgentBrowserSessionSummary => ({
  threadId: ThreadId.make("thread-1"),
  tabId: PreviewTabId.make("tab-1"),
  profile: "default",
  status: "running",
  url: "https://example.com",
  title: "Example",
  loading: false,
  viewport: { width: 1280, height: 800 },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("agent browser attach reducer", () => {
  it("keeps the latest status, and marks close", () => {
    let state = EMPTY_AGENT_BROWSER_VIEW_STATE;
    state = applyAgentBrowserAttachStreamEvent(state, { type: "status", session: summary() });
    expect(state.session?.url).toBe("https://example.com");
    state = applyAgentBrowserAttachStreamEvent(state, {
      type: "closed",
      threadId: ThreadId.make("thread-1"),
      tabId: PreviewTabId.make("tab-1"),
    });
    expect(state.closed).toBe(true);
  });

  it("takes the log snapshot on attach, then appends what the page says", () => {
    let state = applyAgentBrowserAttachStreamEvent(EMPTY_AGENT_BROWSER_VIEW_STATE, {
      type: "logs",
      console: [{ seq: 1, level: "log", text: "before", timestamp: "t0" }],
      network: [],
    });
    state = applyAgentBrowserAttachStreamEvent(state, {
      type: "console",
      entry: { seq: 2, level: "error", text: "boom", timestamp: "t1" },
    });
    state = applyAgentBrowserAttachStreamEvent(state, {
      type: "network",
      entry: {
        seq: 3,
        url: "https://x/y",
        method: "GET",
        status: 500,
        failed: false,
        timestamp: "t2",
      },
    });
    expect(state.console.map((entry) => entry.text)).toEqual(["before", "boom"]);
    expect(state.network[0]?.status).toBe(500);
  });

  // Frames are video, not state: they are taken off the stream before the scan
  // and handed to the painter, so a page repainting continuously must not touch
  // what the chrome around it is drawn from.
  it("does not change state for a frame", () => {
    const state = applyAgentBrowserAttachStreamEvent(EMPTY_AGENT_BROWSER_VIEW_STATE, {
      type: "status",
      session: summary(),
    });
    const next = applyAgentBrowserAttachStreamEvent(state, {
      type: "frame",
      frame: { data: "aa==", deviceWidth: 1280, deviceHeight: 800 },
    });
    expect(next).toBe(state);
  });
});

describe("agent browser sessions reducer", () => {
  it("applies snapshot, upsert and remove", () => {
    let sessions = applyAgentBrowserSessionsStreamEvent([], {
      type: "snapshot",
      sessions: [summary()],
    });
    sessions = applyAgentBrowserSessionsStreamEvent(sessions, {
      type: "upsert",
      session: summary({ title: "Changed" }),
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("Changed");
    sessions = applyAgentBrowserSessionsStreamEvent(sessions, {
      type: "upsert",
      session: summary({ tabId: PreviewTabId.make("tab-2") }),
    });
    expect(sessions).toHaveLength(2);
    sessions = applyAgentBrowserSessionsStreamEvent(sessions, {
      type: "remove",
      threadId: ThreadId.make("thread-1"),
      tabId: PreviewTabId.make("tab-1"),
    });
    expect(sessions.map((session) => session.tabId)).toEqual(["tab-2"]);
  });
});
