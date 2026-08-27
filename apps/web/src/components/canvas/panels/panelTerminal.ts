/**
 * Entity ids for terminal panels.
 *
 * Two shapes: a bare terminal id is one shell of the host console, and
 * `<threadId>/<terminalId>` ({@link threadScopedEntityId}) is a shell a thread
 * is running — the command an agent typed, watched from the canvas rather than
 * from inside the thread's own drawer.
 *
 * @module components/canvas/panels/panelTerminal
 */
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import { parseThreadScopedEntityId, threadScopedEntityId } from "./panelThreadScope";

export interface ThreadTerminalRef {
  readonly threadId: string;
  readonly terminalId: string;
}

export function threadTerminalEntityId(ref: ThreadTerminalRef): string {
  return threadScopedEntityId({ threadId: ref.threadId, childId: ref.terminalId });
}

/** Null for the host console's own shells, which are addressed by id alone. */
export function parseThreadTerminalRef(entityId: string): ThreadTerminalRef | null {
  const scoped = parseThreadScopedEntityId(entityId);
  return scoped === null ? null : { threadId: scoped.threadId, terminalId: scoped.childId };
}

export function terminalPanelTitle(entityId: string): string {
  if (entityId.length === 0) return "Terminal";
  const ref = parseThreadTerminalRef(entityId);
  if (ref === null) return getTerminalLabel(entityId);
  return `${getTerminalLabel(ref.terminalId)} ${ref.threadId.slice(0, 8)}`;
}
