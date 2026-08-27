import type { ServerInstallRun, ServerUpdateState } from "@t3tools/contracts";

/**
 * Pure state machine that drives the in-app "Install & restart" flow to a
 * self-evident completion, so the user never has to guess-and-refresh.
 *
 * The install path is inherently disruptive: triggering it hands off to the
 * host, which installs a new version and restarts the server — tearing down the
 * very WebSocket the UI is polling over. The observable signal therefore arrives in three acts:
 *
 *   1. server still up, `status: "installing"`      → building
 *   2. server unreachable (poll fails/hangs)         → restarting
 *   3. server back up, `deployedCommit` == target    → completed
 *
 * A build that fails (or is deferred without a restart) never advances the
 * deployed commit; the server reconciles its own stuck "installing" back to a
 * settled status with a message, which this machine surfaces as a terminal
 * failure/deferral instead of a spinner that spins forever.
 */

export type InstallPhase = "installing" | "restarting" | "completed" | "deferred" | "failed";

export interface InstallTarget {
  /** Deployed commit at the moment install was triggered. */
  readonly fromCommit: string | null;
  /** Commit we are installing toward (the available commit at trigger time). */
  readonly targetCommit: string | null;
  /** Existing run pointer, so a previous completed run cannot prove this click succeeded. */
  readonly fromRunId: string | null;
  /** Run the host opened for this click, once it has named one. */
  readonly runId: string | null;
}

export interface InstallObservation {
  /** Latest fetched update state, or null before the first poll resolves. */
  readonly state: ServerUpdateState | null;
  /** Whether the most recent poll actually reached the server. */
  readonly reachable: boolean;
  /** Milliseconds elapsed since the install was triggered. */
  readonly elapsedMs: number;
}

export interface InstallProgress {
  readonly phase: InstallPhase;
  readonly message: string;
  /** True once the flow has reached a terminal outcome and polling can stop. */
  readonly terminal: boolean;
}

// A settled, non-"installing" status seen this soon after triggering is almost
// certainly the pre-install snapshot the poll captured before the server flipped
// to "installing" — not a real "finished without restarting". Wait past the
// server's own reconcile grace window before believing a non-advancing settle.
export const SETTLE_MIN_ELAPSED_MS = 12_000;

// Give the server a beat to have flipped to "installing" before the very first
// poll's answer is trusted to distinguish building from deferral.
const COMPLETED_MESSAGE = "Update installed. Reload to load the new version.";
const RESTARTING_MESSAGE = "Restarting the server…";
const BUILDING_MESSAGE = "Building the new release and restarting…";
const DEFERRED_MESSAGE =
  "The install finished without restarting the server. Try installing again.";
const FAILED_MESSAGE = "The install did not complete. See the install log below.";

/**
 * Human text for the step the host reports. The host writes its own label, so
 * a host can add a step without a matching client release — and the client
 * holds no list of steps any particular host happens to have.
 */
export function installPhaseMessage(run: Pick<ServerInstallRun, "phase" | "phaseLabel">): string {
  return run.phaseLabel ?? run.phase;
}

/**
 * Two commit strings refer to the same commit when one is a prefix of the other
 * (git short vs. full hashes) and the shared prefix is long enough to be a real
 * abbreviation. Empty/short values never match.
 */
export function commitsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const min = Math.min(a.length, b.length);
  if (min < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * A typed server rejection means the update never started. Transport loss is
 * different: restarting T3J deliberately drops the RPC socket, so the client
 * must keep observing the install instead of presenting a false failure.
 */
export function isServerUpdateRejection(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "ServerUpdateError"
  );
}

/**
 * The run this click owns, out of whatever the host's pointer currently names.
 *
 * Everything the flow shows — the step, the log, the outcome — hangs off this
 * one answer, and getting it wrong is what made Install feel broken: a click
 * whose deploy died before writing anything found the PREVIOUS run in the
 * pointer and presented it, log and all, as its own result. A host that names
 * the run it opened settles it exactly; otherwise the only thing we can say is
 * that our run is not the one that was already there.
 */
export function resolveOwnRun(
  target: InstallTarget,
  run: ServerInstallRun | null,
): ServerInstallRun | null {
  if (run === null) return null;
  if (target.runId !== null) return run.runId === target.runId ? run : null;
  return run.runId === target.fromRunId ? null : run;
}

/**
 * Fold one polling observation into the current install phase. Pure and
 * order-independent: the same observation always yields the same phase, so it is
 * safe to call on every render and in tests without a running clock.
 */
export function deriveInstallProgress(
  target: InstallTarget,
  observation: InstallObservation,
): InstallProgress {
  const { state, reachable, elapsedMs } = observation;

  // Success takes precedence over everything. Usually the checked target commit
  // is known. If the command response was lost in the intentional restart, the
  // deployed commit advancing from the pre-click value proves the same thing.
  // A newly completed run is a final fallback for a box whose original deployed
  // commit could not be resolved.
  const run = resolveOwnRun(target, state?.installRun ?? null);
  const deployedCommitAdvanced =
    state?.deployedCommit != null &&
    target.fromCommit != null &&
    !commitsMatch(state.deployedCommit, target.fromCommit);
  const newRunCompletedAtDeployedCommit =
    run?.status === "completed" && commitsMatch(run.commit, state?.deployedCommit);
  if (
    state &&
    (commitsMatch(state.deployedCommit, target.targetCommit) ||
      deployedCommitAdvanced ||
      newRunCompletedAtDeployedCommit)
  ) {
    return { phase: "completed", message: COMPLETED_MESSAGE, terminal: true };
  }

  // No answer from the server: expected while it is mid-restart. Not terminal —
  // keep polling; the reconnect will resolve it into completed or a failure.
  if (!reachable || state === null) {
    return { phase: "restarting", message: RESTARTING_MESSAGE, terminal: false };
  }

  // Prefer what the host actually reported over what we can infer from a poll.
  // The old machine could only say "the socket dropped, so it must be
  // restarting"; the run names the real step, and distinguishes a deferral from
  // a failure without guessing. It is matched by identity, not by commit: the
  // run exists from the moment of the click, before anything has resolved which
  // commit it will install.
  if (run !== null) {
    switch (run.status) {
      case "running":
        return {
          phase: run.phase === "restart" ? "restarting" : "installing",
          message: installPhaseMessage(run),
          terminal: false,
        };
      case "failed":
        return { phase: "failed", message: state.message ?? FAILED_MESSAGE, terminal: true };
      case "deferred":
        return { phase: "deferred", message: state.message ?? DEFERRED_MESSAGE, terminal: true };
      case "completed":
        // The host finished, but the deployed-commit check above did not match,
        // so keep waiting for the restarted server to report the new commit
        // rather than declaring success on the script's word alone.
        break;
    }
  }

  switch (state.status) {
    case "installing":
    case "checking":
      return { phase: "installing", message: state.message ?? BUILDING_MESSAGE, terminal: false };
    case "error":
      return { phase: "failed", message: state.message ?? FAILED_MESSAGE, terminal: true };
    case "available":
    case "up-to-date":
    case "idle": {
      // Reachable, settled, but the deployed commit never advanced. Early on this
      // is just the pre-install snapshot; only trust it as a real "did not
      // restart" once we are past the server's reconcile grace window.
      if (elapsedMs < SETTLE_MIN_ELAPSED_MS) {
        return { phase: "installing", message: BUILDING_MESSAGE, terminal: false };
      }
      return { phase: "deferred", message: state.message ?? DEFERRED_MESSAGE, terminal: true };
    }
    default:
      return { phase: "installing", message: BUILDING_MESSAGE, terminal: false };
  }
}

/**
 * Whether the install-log pane should be attached to the server tail, and how.
 *
 * `live` keeps re-attaching (the install restarts the server, so the stream dies
 * mid-run); `replay` attaches once to pull a finished run's log out of the file.
 *
 * The reason this exists at all: the pane used to attach only while THIS tab had
 * an install in flight, so "See the install log below" pointed at nothing after
 * a reload — exactly when a failed install is being read about.
 */
export type InstallLogTail = "none" | "live" | "replay";

export interface InstallLogTailInput {
  /** A local install flow is in flight and has not reached a terminal phase. */
  readonly installActive: boolean;
  /**
   * Run to show: this install's own run while one is in flight (see
   * {@link resolveOwnRun}), otherwise whatever the host last recorded.
   */
  readonly run: ServerInstallRun | null;
  /** Run whose lines the pane already holds. */
  readonly loadedRunId: string | null;
  /** Run the user hid; do not bring it back on its own. */
  readonly dismissedRunId: string | null;
}

export function deriveInstallLogTail(input: InstallLogTailInput): InstallLogTail {
  const { installActive, run, loadedRunId, dismissedRunId } = input;
  // Nothing identified as the run to show. Attaching anyway is what replayed a
  // previous install's build output under this click's status line.
  if (run === null || run.runId === dismissedRunId) return "none";
  if (installActive) return "live";
  if (run.status === "running") return "live";
  // A finished-and-restarted install has nothing left to explain, so don't
  // reopen a wall of build output on every visit to Settings.
  if (run.status === "completed") return "none";
  return loadedRunId === run.runId ? "none" : "replay";
}

/**
 * Capture what identifies an install, from the state at trigger time.
 *
 * `previous` carries the pre-click pointer forward: the state returned by the
 * install command already names this click's run, and the run that was there
 * before it is what proves the difference.
 */
export function captureInstallTarget(
  state: ServerUpdateState | null,
  previous?: InstallTarget,
): InstallTarget {
  const runId = state?.installRun?.runId ?? null;
  const fromRunId = previous?.fromRunId ?? runId;
  return {
    fromCommit: state?.deployedCommit ?? null,
    targetCommit: state?.availableCommit ?? null,
    fromRunId,
    runId: runId === fromRunId ? (previous?.runId ?? null) : runId,
  };
}
