/**
 * Pure load-average policy for the box thrash health check.
 *
 * @module health/hostLoad
 */

export type HostLoadVerdict = {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
};

/**
 * Compare 1-minute load average to CPU count.
 * Fail when load is extreme (agents will time out); warn when elevated.
 */
export function verdictFromLoadAverage(input: {
  readonly load1: number;
  readonly nproc: number;
}): HostLoadVerdict {
  const cores = Math.max(1, Math.floor(input.nproc));
  const load = input.load1;
  const ratio = load / cores;
  const summary = `load ${load.toFixed(2)} on ${cores} core(s)`;

  if (ratio >= 3) {
    return {
      status: "fail",
      detail:
        `${summary} — box is thrashing; agent CLIs will time out. ` +
        "Pause Hermes, reclaim worktrees, or kill stuck agent scopes",
    };
  }
  if (ratio >= 1.5) {
    return {
      status: "warn",
      detail: `${summary} — elevated; long agent turns may time out under contention`,
    };
  }
  return { status: "ok", detail: summary };
}

/** Parse the first field of `/proc/loadavg` or `uptime` load string. */
export function parseLoad1(raw: string): number | null {
  const trimmed = raw.trim();
  // /proc/loadavg: "0.52 0.58 0.59 1/234 12345"
  const proc = /^(\d+(?:\.\d+)?)\s+/.exec(trimmed);
  if (proc?.[1]) {
    const n = Number(proc[1]);
    return Number.isFinite(n) ? n : null;
  }
  // uptime: "... load average: 7.49, 8.53, 9.25"
  const up = /load average:\s*(\d+(?:\.\d+)?)/i.exec(trimmed);
  if (up?.[1]) {
    const n = Number(up[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseNproc(raw: string): number | null {
  const n = Number(raw.trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
