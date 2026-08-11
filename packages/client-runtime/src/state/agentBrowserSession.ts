import type {
  AgentBrowserAttachStreamEvent,
  AgentBrowserConsoleEntry,
  AgentBrowserNetworkEntry,
  AgentBrowserSessionsStreamEvent,
  AgentBrowserSessionSummary,
} from "@t3tools/contracts";

/**
 * Accumulated view of one attached browser tab: what the chrome around the page
 * is drawn from. Frames are deliberately absent — they go to the painter's own
 * mailbox ({@link agentBrowserFrames}), so this state changes when the page
 * navigates or the title moves, not thirty times a second.
 */
export interface AgentBrowserViewState {
  readonly session: AgentBrowserSessionSummary | null;
  readonly closed: boolean;
  /** Oldest first, capped: what the page has said and fetched. */
  readonly console: ReadonlyArray<AgentBrowserConsoleEntry>;
  readonly network: ReadonlyArray<AgentBrowserNetworkEntry>;
}

export const EMPTY_AGENT_BROWSER_VIEW_STATE: AgentBrowserViewState = {
  session: null,
  closed: false,
  console: [],
  network: [],
};

/**
 * How much of each list a viewer keeps. The box caps its own copy at the same
 * count; this is the cap for a tab that has been streaming for an hour.
 */
const MAX_LOG_ENTRIES = 200;

function appended<T>(entries: ReadonlyArray<T>, entry: T): ReadonlyArray<T> {
  const next = [...entries, entry];
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
}

export function applyAgentBrowserAttachStreamEvent(
  state: AgentBrowserViewState,
  event: AgentBrowserAttachStreamEvent,
): AgentBrowserViewState {
  switch (event.type) {
    case "status":
      return { ...state, session: event.session, closed: false };
    case "logs":
      return { ...state, console: event.console, network: event.network };
    case "console":
      return { ...state, console: appended(state.console, event.entry) };
    case "network":
      return { ...state, network: appended(state.network, event.entry) };
    // Never reached: frames are taken off the stream before the scan and handed
    // to the painter's mailbox. The branch is here because the event union has
    // one, and a silent `default` is how that stops being true.
    case "frame":
      return state;
    case "closed":
      return { ...state, closed: true };
  }
}

export function applyAgentBrowserSessionsStreamEvent(
  sessions: ReadonlyArray<AgentBrowserSessionSummary>,
  event: AgentBrowserSessionsStreamEvent,
): ReadonlyArray<AgentBrowserSessionSummary> {
  switch (event.type) {
    case "snapshot":
      return event.sessions;
    case "upsert": {
      const index = sessions.findIndex(
        (session) =>
          session.threadId === event.session.threadId && session.tabId === event.session.tabId,
      );
      if (index < 0) return [...sessions, event.session];
      const next = [...sessions];
      next[index] = event.session;
      return next;
    }
    case "remove":
      return sessions.filter(
        (session) => !(session.threadId === event.threadId && session.tabId === event.tabId),
      );
  }
}
