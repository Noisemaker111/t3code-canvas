/**
 * Durable incident log — `<baseDir>/health/incidents.jsonl`.
 *
 * Every non-ok outcome lands here with what it was and whether a fix cleared
 * it. Without it each recurrence costs a fresh diagnosis: the same full disk,
 * the same dependency-less worktree, rediscovered from scratch every time.
 * `countRecent` is what lets a caller say "this is the third time today"
 * instead of treating a chronic failure as news.
 *
 * @module health/incidentLog
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HealthCheckOutcome, HealthReport } from "./types.ts";

const LOG_LIMIT = 500;

export interface HealthIncident {
  readonly at: string;
  readonly id: string;
  readonly severity: HealthCheckOutcome["severity"];
  readonly status: HealthCheckOutcome["status"];
  readonly detail: string;
  readonly fixed?: boolean;
  readonly fixError?: string;
}

let logPath: string | null = null;

export function healthIncidentLogPath(): string | null {
  return logPath;
}

export function bindHealthIncidentLog(baseDir: string): string {
  const dir = NodePath.join(baseDir, "health");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    logPath = NodePath.join(dir, "incidents.jsonl");
  } catch {
    logPath = null;
  }
  return logPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindHealthIncidentLog(): void {
  logPath = null;
}

export function readHealthIncidents(limit: number): ReadonlyArray<HealthIncident> {
  if (!logPath) return [];
  let raw: string;
  try {
    raw = NodeFS.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const incidents: HealthIncident[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      incidents.push(JSON.parse(line) as HealthIncident);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
  return incidents.slice(-limit);
}

/** Count (dry run) or truncate the incident log. Returns the entry count seen. */
export function purgeHealthIncidents(options: { readonly dryRun?: boolean } = {}): number {
  const count = readHealthIncidents(LOG_LIMIT).length;
  if (!options.dryRun && logPath) {
    try {
      NodeFS.writeFileSync(logPath, "", "utf8");
    } catch {
      /* an unwritable log purges nothing; the survey count already said so */
    }
  }
  return count;
}

/** How many times this check has been non-ok inside the window. */
export function countRecent(id: string, withinMs: number, nowMs: number): number {
  const floor = nowMs - withinMs;
  return readHealthIncidents(LOG_LIMIT).filter((incident) => {
    if (incident.id !== id) return false;
    const at = Date.parse(incident.at);
    return Number.isFinite(at) && at >= floor;
  }).length;
}

export function recordHealthReport(report: HealthReport): void {
  if (!logPath) return;
  const lines = report.checks
    .filter((outcome) => outcome.status !== "ok")
    .map((outcome) =>
      JSON.stringify({
        at: report.at,
        id: outcome.id,
        severity: outcome.severity,
        status: outcome.status,
        detail: outcome.detail,
        ...(outcome.fixed === undefined ? {} : { fixed: outcome.fixed }),
        ...(outcome.fixError === undefined ? {} : { fixError: outcome.fixError }),
      } satisfies HealthIncident),
    );
  if (lines.length === 0) return;
  try {
    NodeFS.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    return;
  }
  trim();
}

/**
 * A fallback that changed cost, correctness or capability fired, and the box
 * carried on.
 *
 * Degraded mode the operator cannot see is the bug: the reflink downgrade wrote
 * one log line per worktree and filled a 40GiB store. Recording it here puts it
 * in front of the same `seen N× today` counter every other failure mode gets.
 */
export function recordDegradation(input: {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly at?: string;
}): void {
  recordHealthReport({
    at: input.at ?? new Date().toISOString(),
    ok: false,
    checks: [
      {
        id: `degraded.${input.id}`,
        title: input.title,
        severity: "warn",
        status: "warn",
        detail: input.detail,
      },
    ],
  });
}

/**
 * A wedged turn is an incident like any other, and the interesting question is
 * the same one: is this the first time, or the fourth this week?
 */
export function recordStuckTurn(input: {
  readonly at: string;
  readonly threadId: string;
  readonly silentForMs: number;
}): void {
  recordHealthReport({
    at: input.at,
    ok: false,
    checks: [
      {
        id: "turn.stuck",
        title: "A turn wedged and was stopped",
        severity: "critical",
        status: "fail",
        detail: `thread ${input.threadId} showed no sign of life for ${Math.round(input.silentForMs / 60_000)} minutes`,
      },
    ],
  });
}

function trim(): void {
  if (!logPath) return;
  try {
    const lines = NodeFS.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    if (lines.length <= LOG_LIMIT) return;
    NodeFS.writeFileSync(logPath, `${lines.slice(-LOG_LIMIT).join("\n")}\n`, "utf8");
  } catch {
    return;
  }
}
