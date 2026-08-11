/**
 * The shape of a health check.
 *
 * A check owns one failure mode end to end: it probes for it, says what it
 * found in a line a human can act on, and — when the repair is safe and
 * idempotent — fixes it and proves the fix by probing again. Everything the
 * probe touches comes from {@link HealthEnv}, so a check is testable without a
 * box to break.
 *
 * @module health/types
 */

export type HealthStatus = "ok" | "warn" | "fail";

export interface HealthProbeResult {
  readonly status: HealthStatus;
  /** One line, naming the offending path/value and the recovery action. */
  readonly detail: string;
}

export interface HealthAutofix {
  /** Imperative, present tense — rendered as "Fixing: <describe>". */
  readonly describe: string;
  /**
   * Optional `detail` is prepended to the re-probe line so Fix can report
   * "removed N husks / left M dirty" even when the check stays warn.
   */
  readonly run: (env: HealthEnv) => Promise<void | { readonly detail: string }>;
}

export interface HealthCheck {
  readonly id: string;
  readonly title: string;
  /** `critical` fails the run (and blocks a launch); `warn` only reports. */
  readonly severity: "critical" | "warn";
  readonly probe: (env: HealthEnv) => Promise<HealthProbeResult>;
  readonly autofix?: HealthAutofix;
}

export interface HealthCheckOutcome {
  readonly id: string;
  readonly title: string;
  readonly severity: HealthCheck["severity"];
  readonly status: HealthStatus;
  readonly detail: string;
  /** Set when an autofix ran: whether the re-probe came back `ok`. */
  readonly fixed?: boolean;
  /** The status before the autofix ran, when one did. */
  readonly statusBeforeFix?: HealthStatus;
  readonly fixError?: string;
  /** What the autofix did, when it reported a line. */
  readonly fixDetail?: string;
}

export interface HealthReport {
  readonly at: string;
  /** No `critical` check is failing. `warn` findings do not clear it. */
  readonly ok: boolean;
  readonly checks: ReadonlyArray<HealthCheckOutcome>;
}

export interface HealthPaths {
  readonly stateDir: string;
  /** `T3CODE_VPS_REPO_PATH` — where deploy/*.sh live. */
  readonly repoRoot: string | null;
  /** `T3CODE_WORKTREE_ROOT` — where per-thread worktrees live. */
  readonly worktreeRoot: string | null;
  /** The running release root, for reading the shipped `package.json`. */
  readonly releaseRoot: string | null;
}

export interface HealthFsEnv {
  readonly exists: (path: string) => Promise<boolean>;
  readonly isWritable: (path: string) => Promise<boolean>;
  readonly mkdirp: (path: string) => Promise<void>;
  readonly readDir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readFile: (path: string) => Promise<string | null>;
  /** `null` when the path does not exist or the platform cannot report it. */
  readonly diskSpace: (
    path: string,
  ) => Promise<{ readonly freeBytes: number; readonly totalBytes: number } | null>;
}

export interface HealthEnv {
  readonly paths: HealthPaths;
  readonly fs: HealthFsEnv;
  readonly nowMs: () => number;
  readonly nodeVersion: string;
  /** Read one environment variable. `null` when unset or blank. */
  readonly envVar: (name: string) => string | null;
  /** Resolve a binary on PATH. `null` when it is not installed. */
  readonly which: (binary: string) => Promise<string | null>;
  /** HEAD-style reachability probe. Resolves `false` on any failure. */
  readonly reachable: (url: string, timeoutMs: number) => Promise<boolean>;
  /**
   * Run one of the repo's own remediation scripts. Every failure — missing
   * script, non-zero exit, timeout — comes back as an exit code and output,
   * never as a throw.
   */
  readonly exec: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<{ readonly code: number; readonly output: string }>;
}
