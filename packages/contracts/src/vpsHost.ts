import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * VPS host contracts — the box this app runs on, as observability.
 *
 * The devbox has no other console: everything here (load, memory, disks,
 * systemd units, processes, listening ports) is read on demand from `/proc`
 * and a small set of shell utilities. Every section carries its own optional
 * `error` so one missing tool (`ss` on a slim image, `systemctl` in local dev)
 * degrades that card instead of failing the whole snapshot.
 */

export const VpsHostSummary = Schema.Struct({
  hostname: TrimmedNonEmptyString,
  /** `PRETTY_NAME` from /etc/os-release, when readable. */
  osName: Schema.NullOr(TrimmedNonEmptyString),
  kernel: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  uptimeSeconds: NonNegativeInt,
  bootedAt: Schema.String,
  cpuModel: Schema.NullOr(TrimmedNonEmptyString),
  cpuCount: PositiveInt,
  /** 1/5/15-minute load averages. */
  load1: Schema.Number,
  load5: Schema.Number,
  load15: Schema.Number,
  /** Whole-box CPU utilisation, sampled across a short window. */
  cpuPercent: Schema.NullOr(Schema.Number),
  /** PID of the T3J server process itself. */
  serverPid: PositiveInt,
  serverUptimeSeconds: NonNegativeInt,
  nodeVersion: TrimmedNonEmptyString,
});
export type VpsHostSummary = typeof VpsHostSummary.Type;

export const VpsMemory = Schema.Struct({
  totalBytes: NonNegativeInt,
  /** MemAvailable — what a new allocation can actually get, not MemFree. */
  availableBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  cachedBytes: NonNegativeInt,
  swapTotalBytes: NonNegativeInt,
  swapUsedBytes: NonNegativeInt,
});
export type VpsMemory = typeof VpsMemory.Type;

export const VpsFilesystem = Schema.Struct({
  device: TrimmedNonEmptyString,
  mountPoint: TrimmedNonEmptyString,
  fsType: TrimmedNonEmptyString,
  totalBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  usePercent: Schema.Number,
});
export type VpsFilesystem = typeof VpsFilesystem.Type;

/** Directories worth watching on this box (releases, install logs, projects). */
export const VpsDiskUsageEntry = Schema.Struct({
  label: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  sizeBytes: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type VpsDiskUsageEntry = typeof VpsDiskUsageEntry.Type;

export const VpsServiceState = Schema.Struct({
  unit: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  loadState: TrimmedNonEmptyString,
  activeState: TrimmedNonEmptyString,
  subState: TrimmedNonEmptyString,
  enabled: Schema.NullOr(Schema.String),
  /** ISO timestamp of the last state change, when systemd reports one. */
  since: Schema.NullOr(Schema.String),
  mainPid: Schema.NullOr(PositiveInt),
  memoryBytes: Schema.NullOr(NonNegativeInt),
  /** False for a unit systemd does not know about (not installed on this box). */
  known: Schema.Boolean,
  /** True for the unit hosting this very server — restarting it drops the UI. */
  isSelf: Schema.Boolean,
  /** ISO timestamp of the next run, for timer units. */
  nextRunAt: Schema.NullOr(Schema.String),
});
export type VpsServiceState = typeof VpsServiceState.Type;

export const VpsProcess = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  user: TrimmedNonEmptyString,
  cpuPercent: Schema.Number,
  memPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  /** True for this server process or any of its descendants. */
  isServerTree: Schema.Boolean,
});
export type VpsProcess = typeof VpsProcess.Type;

export const VpsListener = Schema.Struct({
  protocol: TrimmedNonEmptyString,
  address: TrimmedNonEmptyString,
  port: NonNegativeInt,
  process: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(PositiveInt),
});
export type VpsListener = typeof VpsListener.Type;

/** Per-section failure so a missing tool degrades one card, not the page. */
export const VpsSectionError = Schema.Struct({
  section: Schema.Literals(["host", "memory", "filesystems", "services", "processes", "listeners"]),
  message: TrimmedNonEmptyString,
});
export type VpsSectionError = typeof VpsSectionError.Type;

/** One health check's verdict, as the box last measured it. */
export const VpsHealthCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  severity: Schema.Literals(["critical", "warn"]),
  status: Schema.Literals(["ok", "warn", "fail"]),
  detail: Schema.String,
  /** Set when an autofix ran: whether the re-probe came back clean. */
  fixed: Schema.optional(Schema.Boolean),
  /** Why the autofix could not run at all. Without it a Fix that never executed reads as "still failing". */
  fixError: Schema.optional(Schema.String),
  /** How many times this check has been non-ok in the last day. */
  seenInLastDay: NonNegativeInt,
  /** Whether this check knows how to repair itself. */
  fixable: Schema.Boolean,
});
export type VpsHealthCheck = typeof VpsHealthCheck.Type;

export const VpsHealth = Schema.Struct({
  at: Schema.String,
  /** No critical check is failing. Warnings do not clear it. */
  ok: Schema.Boolean,
  checks: Schema.Array(VpsHealthCheck),
});
export type VpsHealth = typeof VpsHealth.Type;

export const VpsSnapshot = Schema.Struct({
  readAt: Schema.String,
  /** False off Linux (local macOS/Windows dev): /proc-based reads are skipped. */
  supported: Schema.Boolean,
  host: Schema.NullOr(VpsHostSummary),
  memory: Schema.NullOr(VpsMemory),
  filesystems: Schema.Array(VpsFilesystem),
  diskUsage: Schema.Array(VpsDiskUsageEntry),
  services: Schema.Array(VpsServiceState),
  processes: Schema.Array(VpsProcess),
  /** Processes above the cutoff, before the top-N slice. */
  processCount: NonNegativeInt,
  listeners: Schema.Array(VpsListener),
  /** Null when the health run itself failed; a card, never the page. */
  health: Schema.NullOr(VpsHealth),
  errors: Schema.Array(VpsSectionError),
});
export type VpsSnapshot = typeof VpsSnapshot.Type;

export const VpsGetSnapshotInput = Schema.Struct({
  /** How many processes to return, ordered by CPU then memory. Default 20. */
  processLimit: Schema.optional(NonNegativeInt),
  /** Include per-directory `du` sizes, which walk the disk. Default false. */
  includeDiskUsage: Schema.optional(Schema.Boolean),
});
export type VpsGetSnapshotInput = typeof VpsGetSnapshotInput.Type;

export const VpsServiceAction = Schema.Literals(["start", "stop", "restart"]);
export type VpsServiceAction = typeof VpsServiceAction.Type;

export const VpsServiceActionInput = Schema.Struct({
  unit: TrimmedNonEmptyString,
  action: VpsServiceAction,
});
export type VpsServiceActionInput = typeof VpsServiceActionInput.Type;

export const VpsServiceActionResult = Schema.Struct({
  unit: TrimmedNonEmptyString,
  action: VpsServiceAction,
  service: Schema.NullOr(VpsServiceState),
});
export type VpsServiceActionResult = typeof VpsServiceActionResult.Type;

export const VpsProcessSignal = Schema.Literals(["SIGTERM", "SIGKILL"]);
export type VpsProcessSignal = typeof VpsProcessSignal.Type;

export const VpsSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  signal: VpsProcessSignal,
});
export type VpsSignalProcessInput = typeof VpsSignalProcessInput.Type;

export const VpsSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: VpsProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type VpsSignalProcessResult = typeof VpsSignalProcessResult.Type;

export class VpsHostError extends Schema.TaggedErrorClass<VpsHostError>()("VpsHostError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `VPS ${this.operation} failed: ${this.detail}`;
  }
}

export const VpsRunHealthInput = Schema.Struct({
  /** Run every autofix whose check is failing, then re-probe. Default false. */
  fix: Schema.optional(Schema.Boolean),
});
export type VpsRunHealthInput = typeof VpsRunHealthInput.Type;

/**
 * The forge token the board opens pull requests with.
 *
 * Setting it used to mean a root shell and an editor on `/etc/t3j.env`, which
 * is the one thing this app exists to avoid. Empty clears it. Never read back:
 * the panel shows whether `forge.auth` passes, not the secret.
 */
export const VpsSetForgeTokenInput = Schema.Struct({
  token: Schema.String,
});
export type VpsSetForgeTokenInput = typeof VpsSetForgeTokenInput.Type;
