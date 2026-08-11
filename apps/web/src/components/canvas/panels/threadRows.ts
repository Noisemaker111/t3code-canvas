/**
 * The thread list's rows — the pure half.
 *
 * Which cards front a coding thread, and the order the list reads them in.
 *
 * @module components/canvas/panels/threadRows
 */

/** The components whose cards front a coding thread, in the order the list reads. */
export const THREAD_ROW_COMPONENTS = ["active", "pr", "done"] as const;
export type ThreadRowComponent = (typeof THREAD_ROW_COMPONENTS)[number];

/**
 * The cards the thread list shows: every live card fronting a thread, Active
 * first, then PR, then Done — the board's own order within each. A visit to
 * a PR/Done thread's panel is kept alive by the station for as long as you
 * are on it.
 */
export function threadRowCards<
  T extends {
    readonly threadId: string | null;
    readonly at: string;
    readonly position: number;
    readonly archivedAt: unknown;
  },
>(cards: ReadonlyArray<T>): ReadonlyArray<T> {
  const rank = new Map<string, number>(THREAD_ROW_COMPONENTS.map((id, index) => [id, index]));
  return cards
    .filter(
      (card) =>
        rank.has(card.at) &&
        card.archivedAt === null &&
        typeof card.threadId === "string" &&
        card.threadId.length > 0,
    )
    .toSorted((a, b) => (rank.get(a.at) ?? 0) - (rank.get(b.at) ?? 0) || a.position - b.position);
}
