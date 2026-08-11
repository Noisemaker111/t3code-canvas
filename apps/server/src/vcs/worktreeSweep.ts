/**
 * Which orphaned thread workspaces may be reclaimed, as a pure decision.
 *
 * `WorktreeReaper` only ever removes the workspace of a thread it is handed, so
 * a workspace whose thread record never existed — a launch that died after
 * `createWorktree` (the ENOSPC case, which then feeds itself), a card deleted
 * while Active, a thread lost with the projection — was invisible to teardown
 * forever. Each one is a full dependency install: ~1.7GiB on the VPS. Eleven of
 * them is the 40GiB store.
 *
 * The sweep closes that hole by working from the directory listing instead of
 * from thread records: anything under a project's workspace root that no live
 * thread claims is an orphan.
 *
 * A claim is a deferral, not a reservation. Thread records outlive the work
 * they describe — a board with six cards on it was holding fourteen claimed
 * workspaces, 50GiB — so "some thread still names this path" could never free
 * anything on a project in active use. A clean tree holds nothing that is not
 * already in the repository and relaunching rebuilds it, so a claimed workspace
 * is reclaimed too once it is clean and has gone untouched for the retention
 * window. Uncommitted work is the line, and it does not move.
 *
 * The uncommitted-changes rule is unchanged and still the default: a dirty
 * orphan is kept and reported, never removed. `T3CODE_WORKTREE_REAP_ABANDONED`
 * is the explicit opt-in that lets a dirty orphan go, and even then only after
 * `T3CODE_WORKTREE_RETENTION_HOURS` with no writes at all.
 *
 * @module vcs/worktreeSweep
 */

/** Hours an untouched dirty orphan is kept before it counts as abandoned. */
export const WORKTREE_RETENTION_ENV_KEY = "T3CODE_WORKTREE_RETENTION_HOURS";

/** Opt-in for removing abandoned dirty orphans. Read literally — do not rename. */
export const WORKTREE_REAP_ABANDONED_ENV_KEY = "T3CODE_WORKTREE_REAP_ABANDONED";

export const DEFAULT_WORKTREE_RETENTION_HOURS = 72;

export type WorktreeSweepEnv = Readonly<Record<string, string | undefined>>;

export interface SweepCandidate {
  /** Absolute path of a `thread-*` directory under a project workspace root. */
  readonly path: string;
  /** Last write to the directory, used only as the abandonment clock. */
  readonly mtimeMs: number;
  readonly hasWorkingTreeChanges: boolean;
}

export type SweepDecision =
  | { readonly kind: "keep"; readonly path: string; readonly reason: string }
  | {
      readonly kind: "remove";
      readonly path: string;
      readonly force: boolean;
      readonly reason: string;
    };

/** Env wins when set and valid, then the settings value, then the default. */
export function resolveRetentionHours(env?: WorktreeSweepEnv, settingsHours?: number): number {
  const raw = Number.parseFloat(((env ?? process.env)[WORKTREE_RETENTION_ENV_KEY] ?? "").trim());
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (typeof settingsHours === "number" && Number.isFinite(settingsHours) && settingsHours > 0) {
    return settingsHours;
  }
  return DEFAULT_WORKTREE_RETENTION_HOURS;
}

/** Env wins when set (any value), then the settings value, then off. */
export function abandonedReapEnabled(env?: WorktreeSweepEnv, settingsEnabled?: boolean): boolean {
  const raw = ((env ?? process.env)[WORKTREE_REAP_ABANDONED_ENV_KEY] ?? "").trim().toLowerCase();
  if (raw.length > 0) return raw === "1" || raw === "true" || raw === "yes";
  return settingsEnabled === true;
}

/** An unknown mtime reads as "just touched", never as abandoned. */
function idleHoursOf(candidate: SweepCandidate, nowMs: number): number {
  return Math.max(0, candidate.mtimeMs > 0 ? nowMs - candidate.mtimeMs : 0) / 3_600_000;
}

/**
 * One decision per candidate. Nothing here touches disk, so the policy stays
 * readable and testable on its own.
 */
export function planWorktreeSweep(input: {
  readonly candidates: ReadonlyArray<SweepCandidate>;
  /** Workspace paths a live thread still claims, already resolved. */
  readonly livePaths: ReadonlyArray<string>;
  readonly nowMs: number;
  readonly retentionHours?: number;
  readonly reapAbandoned?: boolean;
}): ReadonlyArray<SweepDecision> {
  const live = new Set(input.livePaths);
  const retentionHours = input.retentionHours ?? DEFAULT_WORKTREE_RETENTION_HOURS;
  const reapAbandoned = input.reapAbandoned ?? false;

  return input.candidates.map((candidate): SweepDecision => {
    if (live.has(candidate.path)) {
      // A claim is not a reservation forever. Thread records outlive the work
      // they describe — a box with six cards on the board was holding fourteen
      // claimed workspaces, 50GiB, because every record still named its path —
      // so "a thread points at it" alone could never free anything on a project
      // that is actually in use. A *clean* tree has nothing that is not already
      // in the repository, and relaunching the thread rebuilds the workspace,
      // so once it has gone untouched for the retention window it is reclaimed
      // like any other orphan. Uncommitted work is still untouchable.
      if (candidate.hasWorkingTreeChanges) {
        return {
          kind: "keep",
          path: candidate.path,
          reason: "a live thread owns it and it has uncommitted changes",
        };
      }
      const claimedIdleHours = idleHoursOf(candidate, input.nowMs);
      if (claimedIdleHours < retentionHours) {
        return { kind: "keep", path: candidate.path, reason: "a live thread owns it" };
      }
      return {
        kind: "remove",
        path: candidate.path,
        force: false,
        reason: `claimed by a live thread but clean and untouched for ${claimedIdleHours.toFixed(1)}h — past the ${retentionHours}h retention window`,
      };
    }
    if (!candidate.hasWorkingTreeChanges) {
      return {
        kind: "remove",
        path: candidate.path,
        force: false,
        reason: "orphaned workspace with no uncommitted changes",
      };
    }

    const idleHours = idleHoursOf(candidate, input.nowMs);
    if (!reapAbandoned) {
      return {
        kind: "keep",
        path: candidate.path,
        reason:
          `orphaned but has uncommitted changes (idle ${idleHours.toFixed(1)}h) — ` +
          `set ${WORKTREE_REAP_ABANDONED_ENV_KEY}=1 to reclaim it after ${retentionHours}h`,
      };
    }
    if (idleHours < retentionHours) {
      return {
        kind: "keep",
        path: candidate.path,
        reason: `orphaned with uncommitted changes, idle ${idleHours.toFixed(1)}h — inside the ${retentionHours}h retention window`,
      };
    }
    return {
      kind: "remove",
      path: candidate.path,
      force: true,
      reason: `orphaned with uncommitted changes, untouched for ${idleHours.toFixed(1)}h — past the ${retentionHours}h retention window`,
    };
  });
}
