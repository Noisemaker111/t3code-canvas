/**
 * The address of a panel a thread opened: `<threadId>/<childId>`, both segments
 * URI-encoded because neither id is constrained (agent-chosen tab ids and
 * client-chosen terminal ids may contain anything, separator included).
 *
 * One encoding for every kind of satellite — a browser tab and a shell are the
 * same relationship to a thread, so they are the same address, and the canvas
 * reads ownership off it without a second table saying who opened what.
 *
 * @module components/canvas/panels/panelThreadScope
 */

const encodeSegment = (value: string): string => encodeURIComponent(value).replaceAll("/", "%2F");

export interface ThreadScopedRef {
  readonly threadId: string;
  readonly childId: string;
}

export function threadScopedEntityId(ref: ThreadScopedRef): string {
  return `${encodeSegment(ref.threadId)}/${encodeSegment(ref.childId)}`;
}

/** Null for anything that is not a thread's panel — never a guess. */
export function parseThreadScopedEntityId(entityId: string): ThreadScopedRef | null {
  if (entityId.length === 0) return null;
  const separator = entityId.indexOf("/");
  if (separator <= 0 || separator === entityId.length - 1) return null;
  try {
    return {
      threadId: decodeURIComponent(entityId.slice(0, separator)),
      childId: decodeURIComponent(entityId.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

/** The thread a panel belongs to, or null when it belongs to no thread. */
export function owningThreadId(entityId: string): string | null {
  return parseThreadScopedEntityId(entityId)?.threadId ?? null;
}
