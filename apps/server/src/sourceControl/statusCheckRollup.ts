/**
 * `gh pr view --json statusCheckRollup` → a verdict the board can act on.
 *
 * The rollup mixes two shapes: CheckRun (a `status` plus a `conclusion` once it
 * completes) and StatusContext (a single `state`). Both are normalised here so
 * the rule pass never has to know which forge feature produced a red mark.
 *
 * @module sourceControl/statusCheckRollup
 */
import type { ChangeRequestState } from "@t3tools/contracts";

import type { ChangeRequestChecks } from "./SourceControlProvider.ts";

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

interface RollupEntry {
  readonly name?: unknown;
  readonly context?: unknown;
  readonly workflowName?: unknown;
  readonly status?: unknown;
  readonly state?: unknown;
  readonly conclusion?: unknown;
  readonly detailsUrl?: unknown;
  readonly targetUrl?: unknown;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const entryTimestamp = (entry: RollupEntry): number | null => {
  const value = text(entry.completedAt) ?? text(entry.startedAt);
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

function latestEntries(entries: ReadonlyArray<RollupEntry>): ReadonlyArray<RollupEntry> {
  const latest = new Map<string, { entry: RollupEntry; timestamp: number | null }>();
  const anonymous: Array<RollupEntry> = [];

  for (const entry of entries) {
    const context = text(entry.context);
    const name = text(entry.name);
    const key = context
      ? `status:${context}`
      : name
        ? `check:${text(entry.workflowName) ?? ""}:${name}`
        : null;
    if (key === null) {
      anonymous.push(entry);
      continue;
    }

    const timestamp = entryTimestamp(entry);
    const previous = latest.get(key);
    if (
      previous === undefined ||
      (timestamp !== null && previous.timestamp === null) ||
      (timestamp !== null && previous.timestamp !== null && timestamp >= previous.timestamp) ||
      (timestamp === null && previous.timestamp === null)
    ) {
      latest.set(key, { entry, timestamp });
    }
  }

  return [...latest.values()].map(({ entry }) => entry).concat(anonymous);
}

function classify(entry: RollupEntry): "passing" | "failing" | "pending" {
  const status = text(entry.status)?.toUpperCase() ?? null;
  const conclusion = text(entry.conclusion)?.toUpperCase() ?? null;
  const state = text(entry.state)?.toUpperCase() ?? null;

  // A CheckRun still running has no conclusion yet — never read that as a pass.
  if (status !== null && status !== "COMPLETED") return "pending";
  if (conclusion !== null) return FAILING_CONCLUSIONS.has(conclusion) ? "failing" : "passing";
  if (state !== null) {
    if (FAILING_STATES.has(state)) return "failing";
    if (PENDING_STATES.has(state)) return "pending";
    return "passing";
  }
  return "pending";
}

const ZERO_COUNTS = { total: 0, passing: 0, failing: 0, pending: 0 } as const;

/** The forge did not answer, or answered with something that is not a rollup. */
const UNAVAILABLE: ChangeRequestChecks = {
  state: "unknown",
  failing: [],
  counts: ZERO_COUNTS,
  unknownReason: "unavailable",
  unknownDetail: "The forge returned check data the board could not read.",
  openedAtMs: null,
};

const openedAt = (value: unknown): number | null => {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : null;
};

function changeRequestState(input: {
  readonly state?: unknown;
  readonly mergedAt?: unknown;
}): ChangeRequestState | undefined {
  if (text(input.mergedAt) !== null) return "merged";
  const state = text(input.state)?.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return "open";
  return undefined;
}

function withChangeRequestState(
  checks: ChangeRequestChecks,
  state: ChangeRequestState | undefined,
): ChangeRequestChecks {
  return state === undefined ? checks : { ...checks, changeRequestState: state };
}

export function parseStatusCheckRollup(raw: string): ChangeRequestChecks {
  let entries: ReadonlyArray<RollupEntry>;
  let openedAtMs: number | null;
  let requestState: ChangeRequestState | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      statusCheckRollup?: unknown;
      createdAt?: unknown;
      state?: unknown;
      mergedAt?: unknown;
    };
    requestState = changeRequestState(parsed);
    const rollup = parsed.statusCheckRollup;
    if (!Array.isArray(rollup)) return withChangeRequestState(UNAVAILABLE, requestState);
    entries = latestEntries(rollup as ReadonlyArray<RollupEntry>);
    openedAtMs = openedAt(parsed.createdAt);
  } catch {
    return UNAVAILABLE;
  }

  if (entries.length === 0) {
    return withChangeRequestState(
      {
        state: "unknown",
        failing: [],
        counts: ZERO_COUNTS,
        unknownReason: "no_checks",
        openedAtMs,
      },
      requestState,
    );
  }

  const failing: Array<{ name: string; url: string | null }> = [];
  let pending = 0;
  let passing = 0;
  for (const entry of entries) {
    const verdict = classify(entry);
    if (verdict === "pending") pending += 1;
    if (verdict === "passing") passing += 1;
    if (verdict !== "failing") continue;
    failing.push({
      name: text(entry.name) ?? text(entry.context) ?? "check",
      url: text(entry.detailsUrl) ?? text(entry.targetUrl),
    });
  }

  const counts = { total: entries.length, passing, failing: failing.length, pending };
  // A red check is red whether or not its siblings are still running: waiting
  // for the rest only delays telling the thread what already broke.
  if (failing.length > 0)
    return withChangeRequestState({ state: "failing", failing, counts, openedAtMs }, requestState);
  return withChangeRequestState(
    { state: pending > 0 ? "pending" : "passing", failing: [], counts, openedAtMs },
    requestState,
  );
}
