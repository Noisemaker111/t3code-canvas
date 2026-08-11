import * as Schema from "effect/Schema";

/**
 * Host update contracts.
 *
 * The host never auto-applies new versions. The user checks for updates from
 * Settings and explicitly installs, which restarts the server. Installing is
 * refused while any agent is actively working so an in-flight session is never
 * interrupted.
 *
 * Version strings ("commits" below, for the git-deployed hosts that print
 * them) are opaque to the app: whatever the host's update hook prints is
 * displayed and compared, and nothing here assumes git, systemd or a release
 * layout. A build with no hook reports `supported: false`.
 */
export const ServerUpdateStatus = Schema.Literals([
  "idle",
  "checking",
  "available",
  "up-to-date",
  "installing",
  "error",
]);
export type ServerUpdateStatus = typeof ServerUpdateStatus.Type;

/**
 * One line of the host's structured install log.
 *
 * The host's update hook appends these as JSONL to `<log dir>/<run-id>.jsonl`
 * (`T3J_UPDATE_LOG_DIR`). The install restarts the server, so the log has to
 * live on disk rather than in memory: a client that loses its socket
 * mid-install re-subscribes from line 0 and replays, instead of losing
 * everything that happened while it was gone.
 */
export const ServerInstallLogLevel = Schema.Literals(["phase", "info", "warn", "error"]);
export type ServerInstallLogLevel = typeof ServerInstallLogLevel.Type;

export const ServerInstallLogEvent = Schema.Struct({
  /** 1-based line number in the run log; the resume offset. */
  line: Schema.Number,
  /** Run this line belongs to, so a client can detect a new install starting. */
  runId: Schema.String,
  ts: Schema.String,
  level: ServerInstallLogLevel,
  /** Coarse step, named by the host. Opaque slug; see `phaseLabel` on the run. */
  phase: Schema.String,
  message: Schema.String,
});
export type ServerInstallLogEvent = typeof ServerInstallLogEvent.Type;

/** Terminal states the host records in `<log dir>/current.json`. */
export const ServerInstallRunStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "deferred",
]);
export type ServerInstallRunStatus = typeof ServerInstallRunStatus.Type;

export const ServerInstallRun = Schema.Struct({
  runId: Schema.String,
  commit: Schema.String,
  phase: Schema.String,
  /**
   * Human text for `phase`, written by the host. The app used to keep its own
   * slug→label map, which meant every host step the app had not heard of
   * rendered as a bare slug and every new step needed a client release. Hosts
   * name their own steps; null falls back to the slug.
   */
  phaseLabel: Schema.NullOr(Schema.String),
  status: ServerInstallRunStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type ServerInstallRun = typeof ServerInstallRun.Type;

export const ServerSubscribeInstallLogInput = Schema.Struct({
  /**
   * Resume point: only lines strictly greater than this are sent. 0 replays the
   * whole run, which is what a client does after reconnecting across the
   * restart the install itself caused.
   */
  fromLine: Schema.optional(Schema.Number),
  /** Pin to a specific run; omitted means "whatever run is current". */
  runId: Schema.optional(Schema.String),
});
export type ServerSubscribeInstallLogInput = typeof ServerSubscribeInstallLogInput.Type;

export const ServerUpdateState = Schema.Struct({
  /** Whether this deployment is configured for in-app updates (false in dev). */
  supported: Schema.Boolean,
  status: ServerUpdateStatus,
  /** Commit currently deployed and running, if resolvable. */
  deployedCommit: Schema.NullOr(Schema.String),
  /** Newest commit available on the deploy branch, once checked. */
  availableCommit: Schema.NullOr(Schema.String),
  /** True when at least one agent session/turn is running. */
  agentsBusy: Schema.Boolean,
  /** Number of threads with a running session or turn. */
  runningAgentCount: Schema.Number,
  /** ISO timestamp of the last completed check, if any. */
  lastCheckedAt: Schema.NullOr(Schema.String),
  /** Human-readable status/error detail. */
  message: Schema.NullOr(Schema.String),
  /**
   * The install run the host is executing (or last executed), read from
   * `<log dir>/current.json`. This is reported progress rather than progress
   * inferred from a poll failing, so the UI can name the actual step. Null when
   * no install has ever run on this host.
   */
  installRun: Schema.NullOr(ServerInstallRun),
});
export type ServerUpdateState = typeof ServerUpdateState.Type;

export const ServerGetUpdateStateInput = Schema.Struct({});
export type ServerGetUpdateStateInput = typeof ServerGetUpdateStateInput.Type;

export const ServerCheckForUpdateInput = Schema.Struct({});
export type ServerCheckForUpdateInput = typeof ServerCheckForUpdateInput.Type;

export const ServerInstallUpdateInput = Schema.Struct({
  /**
   * Install even though agents are reported as running. The one-click update
   * uses this explicit override: the click authorizes the restart and avoids a
   * stale provider session blocking updates forever. Passed through to the
   * host's hook as `T3J_UPDATE_FORCE=1`.
   */
  force: Schema.optional(Schema.Boolean),
});
export type ServerInstallUpdateInput = typeof ServerInstallUpdateInput.Type;

export class ServerUpdateError extends Schema.TaggedErrorClass<ServerUpdateError>()(
  "ServerUpdateError",
  {
    operation: Schema.String,
    detail: Schema.String,
    /** True when the action was refused because agents are running. */
    agentsBusy: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update ${this.operation} failed: ${this.detail}`;
  }
}
