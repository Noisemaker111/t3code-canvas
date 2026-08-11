import type { EnvironmentId } from "@t3tools/contracts";

export interface StickyData<A> {
  readonly environmentId: EnvironmentId | null;
  readonly data: A | null;
}

/**
 * Keep the last resolved query payload while the same environment refetches.
 *
 * A refresh — or the RPC reconnect behind a keepalive tick — briefly returns an
 * environment query to its initial state: waiting, with no value. Rendering that
 * gap blanks whatever panel the query feeds; for the canvas document it also
 * flips the "Loading canvas…" overlay on over the board every few seconds, which
 * reads as the board flashing. A null payload means "no answer yet" and is
 * bridged; a real payload — even an empty one — always wins.
 */
export function reconcileStickyData<A>(
  previous: StickyData<A>,
  environmentId: EnvironmentId | null,
  data: A | null,
): StickyData<A> {
  if (previous.environmentId !== environmentId) return { environmentId, data };
  return data === null ? previous : { environmentId, data };
}
