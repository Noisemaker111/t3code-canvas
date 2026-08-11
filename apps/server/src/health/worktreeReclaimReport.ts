/**
 * Pure report text for worktree Fix outcomes (husk + dirty counts).
 * Prevents silent no-op Fix by naming what was removed vs left.
 *
 * @module health/worktreeReclaimReport
 */

export function formatWorktreeReclaimReport(input: {
  readonly husksRemoved: number;
  readonly husksFailed: number;
  readonly worktreesBefore: number;
  readonly worktreesAfter: number;
  readonly dirtyLeft: number;
  readonly ranWorktreeReclaim: boolean;
}): string {
  const parts: string[] = [];
  if (input.husksRemoved > 0) {
    parts.push(`removed ${input.husksRemoved} husk dir(s)`);
  } else {
    parts.push("no husks removed");
  }
  if (input.husksFailed > 0) {
    parts.push(`${input.husksFailed} husk removal(s) failed`);
  }
  if (input.ranWorktreeReclaim) {
    const dropped = Math.max(0, input.worktreesBefore - input.worktreesAfter);
    parts.push(
      dropped > 0
        ? `reclaimed ${dropped} clean worktree(s) (${input.worktreesAfter} left)`
        : `worktree reclaim ran; still ${input.worktreesAfter} tree(s)`,
    );
  } else {
    parts.push("skipped clean-worktree reclaim (store not full and count below warn)");
  }
  if (input.dirtyLeft > 0) {
    parts.push(`${input.dirtyLeft} dirty tree(s) kept`);
  }
  return parts.join("; ");
}

/** True when Fix did nothing useful — UI must not look like success. */
export function reclaimWasNoop(input: {
  readonly husksRemoved: number;
  readonly worktreesBefore: number;
  readonly worktreesAfter: number;
}): boolean {
  return input.husksRemoved === 0 && input.worktreesAfter >= input.worktreesBefore;
}
