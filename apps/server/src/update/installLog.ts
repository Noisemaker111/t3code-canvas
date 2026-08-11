/**
 * Pure parsing for the host's structured install log.
 *
 * The host's update hook appends one JSON object per line to
 * `<T3J_UPDATE_LOG_DIR>/<run-id>.jsonl` and keeps a pointer at `current.json`.
 * Everything here is deliberately side-effect free so the offset/replay
 * behaviour — the part that has to survive the server restart the install
 * itself causes — is unit-testable without a host.
 *
 * Robustness matters more than strictness: the writer is typically a shell
 * script appending to a file that a reader may open mid-write, so a trailing
 * partial line is normal and must be skipped rather than treated as
 * corruption.
 *
 * @module update/installLog
 */
import type {
  ServerInstallLogEvent,
  ServerInstallLogLevel,
  ServerInstallRun,
  ServerInstallRunStatus,
} from "@t3tools/contracts";

const LOG_LEVELS: ReadonlyArray<ServerInstallLogLevel> = ["phase", "info", "warn", "error"];
const RUN_STATUSES: ReadonlyArray<ServerInstallRunStatus> = [
  "running",
  "completed",
  "failed",
  "deferred",
];

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asLevel(value: unknown): ServerInstallLogLevel {
  return LOG_LEVELS.includes(value as ServerInstallLogLevel)
    ? (value as ServerInstallLogLevel)
    : "info";
}

function asStatus(value: unknown): ServerInstallRunStatus | null {
  return RUN_STATUSES.includes(value as ServerInstallRunStatus)
    ? (value as ServerInstallRunStatus)
    : null;
}

/**
 * Parse the whole run log and return events strictly after `fromLine`.
 *
 * Line numbers are 1-based physical line positions in the file, which is the
 * offset a resuming client passes back. They are assigned here rather than
 * written by the shell because `log_run` pipes command output through a
 * subshell, where any counter the script incremented would be lost.
 */
export function parseInstallLog(
  text: string,
  runId: string,
  fromLine = 0,
): ReadonlyArray<ServerInstallLogEvent> {
  const events: ServerInstallLogEvent[] = [];
  const lines = text.split("\n");
  // Splitting on "\n" always leaves one trailing element that is not a complete
  // line: the empty string when the file ends in a newline, or the partial line
  // the shell is still writing. Either way it is `length - 1` complete lines,
  // and a partial tail gets picked up whole on the next read.
  const complete = lines.length - 1;
  for (let index = 0; index < complete; index += 1) {
    const line = index + 1;
    if (line <= fromLine) continue;
    const raw = lines[index];
    if (raw === undefined || raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A line the shell could not escape cleanly should not abort the tail.
      events.push({
        line,
        runId,
        ts: "",
        level: "info",
        phase: "",
        message: raw,
      });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    events.push({
      line,
      runId,
      ts: asString(record.ts),
      level: asLevel(record.level),
      phase: asString(record.phase),
      message: asString(record.message),
    });
  }
  return events;
}

/** Total number of complete lines in the log — the resume offset after a read. */
export function countCompleteLines(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  return lines.length - 1;
}

/** Parse `current.json`. Returns null for anything unusable. */
export function parseInstallRun(text: string): ServerInstallRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const runId = asString(record.runId);
  const status = asStatus(record.status);
  if (runId === "" || status === null) return null;
  const finishedAt = record.finishedAt;
  const phaseLabel = record.phaseLabel;
  return {
    runId,
    commit: asString(record.commit),
    phase: asString(record.phase, status),
    phaseLabel: typeof phaseLabel === "string" && phaseLabel !== "" ? phaseLabel : null,
    status,
    startedAt: asString(record.startedAt),
    finishedAt: typeof finishedAt === "string" && finishedAt !== "" ? finishedAt : null,
  };
}

/** Log file name for a run id, relative to the installs directory. */
export function runLogFileName(runId: string): string {
  return `${runId}.jsonl`;
}
