/**
 * Durable friction log — `<baseDir>/friction/papercuts.jsonl`.
 *
 * What an agent hit and worked around, what a detector saw fail repeatedly, and
 * what Hermes's own board calls keep failing on. All three land here so a
 * recurrence reads as a recurrence: the third `apply_patch` failure across three
 * threads is one entry saying `3x`, not three lines to re-diagnose.
 *
 * Entries are keyed by fingerprint and the whole file is rewritten on every
 * write. There are tens of these, not thousands, and rewriting whole is what
 * makes dedup atomic without a transaction.
 *
 * File-based and synchronous on purpose: `trackBoardFailures` runs inside a tick
 * with no Effect context to await, and this is the same shape as
 * `health/incidents.jsonl` and the other `hermes/*.jsonl` stores.
 *
 * @module friction/frictionStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Who reported it. `board` is Hermes failing at its own board calls. */
export type FrictionSource = "agent" | "detector" | "board";

/**
 * Where the fix has to land. `upstream` is the one that changes routing: it
 * becomes its own card and never nudges the thread that found it.
 */
export type FrictionScope = "harness" | "repo" | "env" | "upstream";

export type FrictionStatus = "open" | "carded" | "fixed" | "wontfix";

export interface FrictionEntry {
  readonly fingerprint: string;
  readonly source: FrictionSource;
  readonly scope: FrictionScope;
  readonly tool: string;
  readonly summary: string;
  readonly evidence: string | null;
  readonly workaround: string | null;
  readonly count: number;
  readonly threadIds: ReadonlyArray<string>;
  readonly cardIds: ReadonlyArray<string>;
  readonly context: Readonly<Record<string, string>>;
  readonly status: FrictionStatus;
  readonly fixCardId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface FrictionInput {
  readonly source: FrictionSource;
  readonly scope: FrictionScope;
  readonly tool: string;
  readonly summary: string;
  readonly evidence?: string | null;
  /**
   * What to fingerprint on, when the evidence is not it. Board failures carry a
   * different error text every tick but are the same failure, so they key on
   * method+card instead.
   */
  readonly signature?: string;
  readonly workaround?: string | null;
  readonly threadId?: string | null;
  readonly cardId?: string | null;
  readonly context?: Readonly<Record<string, string>> | undefined;
  readonly at?: string;
}

const ENTRY_LIMIT = 400;
const EVIDENCE_CHARS = 800;
const SUMMARY_CHARS = 200;
const THREAD_IDS_KEPT = 12;

let logPath: string | null = null;
let entries = new Map<string, FrictionEntry>();

export function frictionLogPath(): string | null {
  return logPath;
}

/**
 * Drop every entry. Called only by the Maintenance settings route — no sweep,
 * no schedule, nothing else reaches it. `dryRun` counts without deleting so the
 * confirmation can name the number.
 */
export function purgeFrictionLog(options?: { readonly dryRun?: boolean }): number {
  const removed = entries.size;
  if (options?.dryRun === true) return removed;
  entries = new Map();
  if (logPath) {
    try {
      NodeFS.writeFileSync(logPath, "", "utf8");
    } catch {
      // The in-memory index is already clear; a failed truncate must not throw
      // at the caller, who has no better recovery than seeing the count again.
    }
  }
  return removed;
}

export function bindFrictionLog(baseDir: string): string {
  const dir = NodePath.join(baseDir, "friction");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    logPath = NodePath.join(dir, "papercuts.jsonl");
  } catch {
    logPath = null;
  }
  entries = new Map();
  return logPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindFrictionLog(): void {
  logPath = null;
  entries = new Map();
}

/** Rehydrate the in-memory index. Without this a restart re-counts from zero. */
export function restoreFrictionLog(): void {
  entries = new Map();
  if (!logPath) return;
  let raw: string;
  try {
    raw = NodeFS.readFileSync(logPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as FrictionEntry;
      if (typeof entry.fingerprint === "string") entries.set(entry.fingerprint, entry);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
}

function persist(): void {
  if (!logPath) return;
  const ordered = [...entries.values()]
    .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
    .slice(-ENTRY_LIMIT);
  entries = new Map(ordered.map((entry) => [entry.fingerprint, entry]));
  try {
    NodeFS.writeFileSync(logPath, `${ordered.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  } catch {
    // A friction log that cannot be written must never take down the operation
    // that was reporting friction.
  }
}

/**
 * Collapse the varying parts of an error so the same failure fingerprints the
 * same way. Line numbers, paths, hashes and ids are exactly what differs
 * between two sightings of one bug.
 */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\/[\w.@+-]+(?:\/[\w.@+-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{6,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** FNV-1a. Cheap, sync, and stable across restarts — no crypto dependency. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function frictionFingerprint(input: {
  readonly scope: FrictionScope;
  readonly tool: string;
  readonly signature: string;
}): string {
  return `${input.scope}:${input.tool}:${hash(normalizeSignature(input.signature))}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function appendUnique(
  existing: ReadonlyArray<string>,
  value: string | null | undefined,
): ReadonlyArray<string> {
  if (!value || existing.includes(value)) return existing;
  return [...existing, value].slice(-THREAD_IDS_KEPT);
}

/**
 * Record one sighting. A known fingerprint bumps the count and widens the
 * thread set; a `fixed` or `wontfix` entry that recurs reopens, because a fix
 * that did not hold is news again.
 */
export function recordFriction(input: FrictionInput): FrictionEntry {
  const at = input.at ?? new Date().toISOString();
  const fingerprint = frictionFingerprint({
    scope: input.scope,
    tool: input.tool,
    signature: input.signature ?? input.evidence ?? input.summary,
  });
  const previous = entries.get(fingerprint);
  const entry: FrictionEntry = {
    fingerprint,
    source: previous?.source ?? input.source,
    scope: input.scope,
    tool: input.tool,
    summary: clip(input.summary, SUMMARY_CHARS),
    evidence: input.evidence ? clip(input.evidence, EVIDENCE_CHARS) : (previous?.evidence ?? null),
    workaround: input.workaround
      ? clip(input.workaround, EVIDENCE_CHARS)
      : (previous?.workaround ?? null),
    count: (previous?.count ?? 0) + 1,
    threadIds: appendUnique(previous?.threadIds ?? [], input.threadId),
    cardIds: appendUnique(previous?.cardIds ?? [], input.cardId),
    context: { ...(previous?.context ?? {}), ...(input.context ?? {}) },
    status:
      previous === undefined || previous.status === "fixed" || previous.status === "wontfix"
        ? "open"
        : previous.status,
    fixCardId: previous?.status === "carded" ? previous.fixCardId : null,
    firstSeenAt: previous?.firstSeenAt ?? at,
    lastSeenAt: at,
  };
  entries.delete(fingerprint);
  entries.set(fingerprint, entry);
  persist();
  return entry;
}

export function listFriction(limit = ENTRY_LIMIT): ReadonlyArray<FrictionEntry> {
  return [...entries.values()]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit);
}

/**
 * Every open entry is due: one sighting is a good enough reason to investigate.
 * The old 3-sightings bar was a noise filter for guesses, but it scaled
 * backwards — the friction that costs the most is the friction an agent routes
 * around fastest, leaving the fewest repeats. Dedup by fingerprint keeps the
 * board honest: a recurring failure grows a count, it never grows a second card.
 *
 * `source: "board"` entries are the loop's own write failures mirrored here for
 * restart persistence; they escalate through the self-fix path with its own
 * consecutive-failure threshold, never through papercut cards.
 */
export function frictionDueForCard(): ReadonlyArray<FrictionEntry> {
  return listFriction().filter((entry) => entry.status === "open" && entry.source !== "board");
}

export function setFrictionStatus(
  fingerprint: string,
  status: FrictionStatus,
  fixCardId?: string | null,
): FrictionEntry | null {
  const entry = entries.get(fingerprint);
  if (!entry) return null;
  const next: FrictionEntry = {
    ...entry,
    status,
    fixCardId: status === "carded" ? (fixCardId ?? entry.fixCardId) : (fixCardId ?? null),
  };
  entries.set(fingerprint, next);
  persist();
  return next;
}

/**
 * A success clears the counter for board failures — the loop only cares about
 * consecutive breakage, so one good call means the next failure starts over.
 */
export function clearFriction(fingerprint: string): void {
  if (!entries.delete(fingerprint)) return;
  persist();
}
