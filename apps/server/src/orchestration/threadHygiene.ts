export interface ThreadWorktreeCandidate {
  readonly threadId: string;
  readonly worktreePath: string;
  readonly worktreeExists: boolean;
}

export function clearSessionErrorWhenReady<
  T extends { readonly status: string; readonly lastError: string | null },
>(session: T): T {
  return session.status === "ready" ? { ...session, lastError: null } : session;
}

export interface LiveCardThread {
  readonly column: string;
  readonly threadId: string | null;
  readonly archivedAt: string | null;
}

/** Return threads held by unarchived Active or PR cards. */
export function liveCardThreadIds(cards: ReadonlyArray<LiveCardThread>): ReadonlySet<string> {
  return new Set(
    cards
      .filter(
        (card) =>
          card.archivedAt === null &&
          (card.column === "active" || card.column === "pr") &&
          card.threadId !== null,
      )
      .map((card) => card.threadId as string),
  );
}

/** Return missing thread worktrees that no live board card still owns. */
export function orphanedThreadIds(input: {
  readonly threads: ReadonlyArray<ThreadWorktreeCandidate>;
  readonly heldThreadIds: ReadonlySet<string>;
}): ReadonlyArray<string> {
  return input.threads
    .filter(
      (thread) =>
        !thread.worktreeExists &&
        !input.heldThreadIds.has(thread.threadId) &&
        thread.worktreePath.length > 0,
    )
    .map((thread) => thread.threadId);
}
