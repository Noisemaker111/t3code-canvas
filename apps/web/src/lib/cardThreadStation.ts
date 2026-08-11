/**
 * Station key for a card's linked thread — never invent another thread id.
 */

import { stationKey } from "../components/canvas/panels/panelStations";

/** Navigate target for "Open conversation" — only the card's own threadId. */
export function cardThreadStationSearch(
  threadId: string | null | undefined,
): { station: string } | null {
  const id = threadId?.trim();
  if (!id) return null;
  return { station: stationKey({ kind: "thread", entityId: id }) };
}
