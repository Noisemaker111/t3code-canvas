/**
 * Durable helper-thread ledger — `<baseDir>/hermes/helpers.jsonl`.
 *
 * A helper outlives the tick that asked it: the loop launches one and reads the
 * answer several ticks later, possibly after an Install restarted the service.
 * So the record is on disk, one JSON object per line, rewritten whole on every
 * write — the list is capped, so the file stays small and a torn write can
 * never interleave two ticks.
 *
 * @module kanban/hermes/helperStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type HermesHelperStatus = "running" | "answered" | "failed";

export type HermesHelper = {
  readonly id: string;
  readonly threadId: string;
  /** What Hermes asked, verbatim. Rendered back so an answer has its question. */
  readonly question: string;
  /** The card the answer is about, when there is one. */
  readonly cardId: string | null;
  readonly projectId: string;
  readonly status: HermesHelperStatus;
  /** The closing message, or why there is none. Null while running. */
  readonly answer: string | null;
  readonly askedAt: string;
  readonly settledAt: string | null;
  /** True once a settled helper rode in a tick a model actually ran. */
  readonly delivered: boolean;
};

/** Enough to hold every live helper plus a short tail of delivered ones. */
const MAX_ENTRIES = 40;

let helpers: HermesHelper[] = [];
let seq = 0;
let helperPath: string | null = null;

export function hermesHelperPath(): string | null {
  return helperPath;
}

export function bindHermesHelpers(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    helperPath = NodePath.join(dir, "helpers.jsonl");
  } catch {
    helperPath = null;
  }
  return helperPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindHermesHelpers(): void {
  helperPath = null;
}

function isHelper(value: unknown): value is HermesHelper {
  if (value === null || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  return (
    typeof bag["id"] === "string" &&
    typeof bag["threadId"] === "string" &&
    typeof bag["question"] === "string" &&
    typeof bag["projectId"] === "string" &&
    (bag["status"] === "running" || bag["status"] === "answered" || bag["status"] === "failed")
  );
}

export function restoreHermesHelpers(): void {
  if (helperPath === null) return;
  let raw: string;
  try {
    raw = NodeFS.readFileSync(helperPath, "utf8");
  } catch {
    return;
  }
  const restored: HermesHelper[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isHelper(parsed)) restored.push(parsed);
    } catch {
      // One bad line is not a reason to forget every helper in the file.
    }
  }
  helpers = restored.slice(-MAX_ENTRIES);
  seq = helpers.length;
}

function persist(): void {
  if (helperPath === null) return;
  try {
    NodeFS.writeFileSync(
      helperPath,
      helpers.map((helper) => JSON.stringify(helper)).join("\n") + (helpers.length > 0 ? "\n" : ""),
      "utf8",
    );
  } catch {
    // A ledger that cannot be written is not a reason to stop the loop.
  }
}

/** Delivered entries go first: a running helper is never dropped for space. */
function prune(): void {
  while (helpers.length > MAX_ENTRIES) {
    const index = helpers.findIndex((helper) => helper.delivered);
    helpers.splice(index === -1 ? 0 : index, 1);
  }
}

/** What a tick is shown: everything still running, plus answers nobody has read. */
export function liveHermesHelpers(): ReadonlyArray<HermesHelper> {
  return helpers.filter((helper) => helper.status === "running" || !helper.delivered);
}

export function runningHermesHelpers(): ReadonlyArray<HermesHelper> {
  return helpers.filter((helper) => helper.status === "running");
}

export function recordHermesHelper(input: {
  readonly threadId: string;
  readonly question: string;
  readonly cardId: string | null;
  readonly projectId: string;
  readonly askedAt: string;
}): HermesHelper {
  seq += 1;
  const helper: HermesHelper = {
    id: `helper-${seq}-${input.threadId.slice(0, 8)}`,
    threadId: input.threadId,
    question: input.question,
    cardId: input.cardId,
    projectId: input.projectId,
    status: "running",
    answer: null,
    askedAt: input.askedAt,
    settledAt: null,
    delivered: false,
  };
  helpers.push(helper);
  prune();
  persist();
  return helper;
}

export function settleHermesHelper(input: {
  readonly id: string;
  readonly status: Exclude<HermesHelperStatus, "running">;
  readonly answer: string;
  readonly settledAt: string;
}): void {
  helpers = helpers.map((helper) =>
    helper.id === input.id
      ? { ...helper, status: input.status, answer: input.answer, settledAt: input.settledAt }
      : helper,
  );
  persist();
}

/** Mark answers that rode in a tick the model actually ran, so they stop riding. */
export function deliverHermesHelpers(ids: ReadonlyArray<string>): void {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  helpers = helpers.map((helper) =>
    wanted.has(helper.id) && helper.status !== "running" ? { ...helper, delivered: true } : helper,
  );
  persist();
}

export function resetHermesHelpers(): void {
  helpers = [];
  seq = 0;
}
