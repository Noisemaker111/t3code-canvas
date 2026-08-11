/**
 * Durable tick log — `<baseDir>/hermes/ticks.jsonl`.
 *
 * The in-memory ring buffer dies with the process, which is exactly when you
 * most want to know what Hermes did (a restart after a bad night). One JSON
 * object per line, newest appended, trimmed to the last `LOG_LIMIT` on write.
 *
 * @module kanban/hermes/tickLogStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HermesTickTranscript } from "@t3tools/contracts";

/** Programs and call payloads are the bulk of a tick; keep the file bounded. */
const MAX_LINE_CHARS = 24_000;

let logPath: string | null = null;

export function hermesTickLogPath(): string | null {
  return logPath;
}

export function bindHermesTickLog(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    logPath = NodePath.join(dir, "ticks.jsonl");
  } catch {
    logPath = null;
  }
  return logPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindHermesTickLog(): void {
  logPath = null;
}

export function readHermesTickLog(limit: number): ReadonlyArray<HermesTickTranscript> {
  if (!logPath) return [];
  let raw: string;
  try {
    raw = NodeFS.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const ticks: HermesTickTranscript[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      ticks.push(JSON.parse(line) as HermesTickTranscript);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
  return ticks.slice(-limit);
}

/**
 * Drop every logged tick. Reached only from the Maintenance settings route;
 * `trim` is the automatic one and it is bounded, never emptying.
 */
export function purgeHermesTickLog(options?: { readonly dryRun?: boolean }): number {
  if (!logPath) return 0;
  let removed = 0;
  try {
    removed = NodeFS.readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
  if (options?.dryRun === true) return removed;
  try {
    NodeFS.writeFileSync(logPath, "", "utf8");
  } catch {
    return 0;
  }
  return removed;
}

export function appendHermesTick(tick: HermesTickTranscript, limit: number): void {
  if (!logPath) return;
  let line = JSON.stringify(tick);
  if (line.length > MAX_LINE_CHARS) {
    line = JSON.stringify({
      ...tick,
      program: tick.program === null ? null : `${tick.program.slice(0, 4000)}…`,
      calls: tick.calls.slice(0, 40),
      logs: tick.logs.slice(0, 40),
    });
  }
  try {
    NodeFS.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    return;
  }
  trim(limit);
}

function trim(limit: number): void {
  if (!logPath) return;
  try {
    const lines = NodeFS.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    if (lines.length <= limit) return;
    NodeFS.writeFileSync(logPath, `${lines.slice(-limit).join("\n")}\n`, "utf8");
  } catch {
    // Trimming is housekeeping; a failure must never break a tick.
  }
}
