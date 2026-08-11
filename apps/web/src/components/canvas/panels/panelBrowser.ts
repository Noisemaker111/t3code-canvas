/**
 * Entity ids for browser panels: a thread's tab, addressed by
 * {@link threadScopedEntityId}. The empty entity id is the human's board
 * browser — a tab under BOARD_BROWSER_THREAD_ID opened from the canvas with no
 * agent involved.
 *
 * @module components/canvas/panels/panelBrowser
 */
import {
  BOARD_BROWSER_THREAD_ID,
  PreviewTabId,
  ThreadId,
  type AgentBrowserSessionSummary,
} from "@t3tools/contracts";

import { parseThreadScopedEntityId, threadScopedEntityId } from "./panelThreadScope";

export interface BrowserTabRef {
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
}

export function browserEntityId(ref: BrowserTabRef): string {
  return threadScopedEntityId({ threadId: ref.threadId, childId: ref.tabId });
}

export function parseBrowserTabRef(entityId: string): BrowserTabRef | null {
  const scoped = parseThreadScopedEntityId(entityId);
  if (scoped === null) return null;
  try {
    return {
      threadId: ThreadId.make(scoped.threadId),
      tabId: PreviewTabId.make(scoped.childId),
    };
  } catch {
    return null;
  }
}

export const boardBrowserThreadId = ThreadId.make(BOARD_BROWSER_THREAD_ID);

export function isBoardBrowserSession(session: AgentBrowserSessionSummary): boolean {
  return session.threadId === boardBrowserThreadId;
}

export function browserPanelTitle(entityId: string): string {
  if (entityId.length === 0) return "Browser";
  const ref = parseBrowserTabRef(entityId);
  if (ref === null) return "Browser";
  return ref.threadId === boardBrowserThreadId ? "Browser" : `Browser ${ref.threadId.slice(0, 8)}`;
}
