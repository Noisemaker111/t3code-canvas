// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * What this box has learned — `<baseDir>/hermes/knowledge.jsonl`.
 *
 * The friction log records what *broke*. This records what is *true*: the
 * project fact an agent could not have known, the correction someone had to
 * type, the convention that is not written down anywhere a thread reads. A
 * lesson is durable, project-scoped and rides in the next launch prompt, so the
 * second agent starts where the first one ended instead of being told again.
 *
 * Two rules keep it from becoming a junk drawer:
 *
 * - **A lesson is one imperative line.** Anything longer is a document, and a
 *   document belongs in the repo the thread already reads.
 * - **Repetition is the vote.** Re-learning the same lesson bumps its count and
 *   refreshes it; a lesson nothing re-learns for `LESSON_STALE_MS` retires
 *   itself. Nobody prunes this by hand.
 *
 * File-based and synchronous for the same reason the friction log is: it is
 * written from inside a tick and from a launch path, neither of which has an
 * Effect context to await, and there are tens of these, not thousands.
 *
 * @module kanban/hermes/knowledgeStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Who learned it. `hermes` is the loop catching itself repeating a correction. */
export type LessonSource = "hermes" | "user" | "agent";

/**
 * `candidate` is a sighting that has not earned a place in a launch prompt yet.
 * A correction Hermes typed once might be about that one card; the same
 * correction typed twice is a fact about the project, and only then does it
 * start riding on every launch.
 */
export type LessonStatus = "candidate" | "active" | "retired";

export interface Lesson {
  readonly id: string;
  /** The project it is true for. `null` is a lesson about the box itself. */
  readonly projectId: string | null;
  /** A word or two for what it is about — `theming`, `tests`, `deploy`. */
  readonly topic: string;
  /** One imperative line, written to whoever picks up the next card. */
  readonly lesson: string;
  /** Where it came from, in enough detail to argue with it later. */
  readonly evidence: string | null;
  readonly source: LessonSource;
  /** Times it was learned. Two means someone had to say it twice. */
  readonly learnedCount: number;
  /** Launches that carried it. This is the only proof it is doing anything. */
  readonly taughtCount: number;
  readonly cardIds: ReadonlyArray<string>;
  readonly status: LessonStatus;
  readonly retiredReason: string | null;
  readonly firstLearnedAt: string;
  readonly lastLearnedAt: string;
  readonly lastTaughtAt: string | null;
}

export interface LessonInput {
  readonly projectId?: string | null;
  readonly topic?: string | null;
  readonly lesson: string;
  readonly evidence?: string | null;
  readonly source: LessonSource;
  readonly cardId?: string | null;
  readonly at?: string;
  /**
   * Sightings before it is taught to anyone. 1 (the default) is someone stating
   * a fact on purpose; 2 is the bar for something inferred from behaviour.
   */
  readonly confirmAfter?: number;
}

/** A lesson nothing re-learned in this long has outlived the code it was about. */
export const LESSON_STALE_MS = 45 * 24 * 60 * 60 * 1000;

/** A sighting nothing repeated in this long was about one card, not the project. */
export const CANDIDATE_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Lessons carried into one launch prompt. Past this it is a document. */
export const LESSON_LAUNCH_LIMIT = 8;

const ENTRY_LIMIT = 400;
const LESSON_CHARS = 220;
const EVIDENCE_CHARS = 400;
const TOPIC_CHARS = 24;
const CARD_IDS_KEPT = 12;

/** Shorter than this is a phrase, not something the next agent can act on. */
export const MIN_LESSON_CHARS = 12;

let logPath: string | null = null;
let lessons = new Map<string, Lesson>();

export function knowledgeLogPath(): string | null {
  return logPath;
}

export function bindKnowledgeLog(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    logPath = NodePath.join(dir, "knowledge.jsonl");
  } catch {
    logPath = null;
  }
  lessons = new Map();
  return logPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindKnowledgeLog(): void {
  logPath = null;
  lessons = new Map();
}

/** Rehydrate the index. Knowledge that does not survive a restart is not knowledge. */
export function restoreKnowledgeLog(): void {
  lessons = new Map();
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
      const entry = asLesson(JSON.parse(line) as unknown);
      if (entry !== null) lessons.set(entry.id, entry);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
}

const STATUSES = new Set(["candidate", "active", "retired"]);

/**
 * One line off disk, guarded rather than cast. Every field is defaulted, so a
 * row written by an older build is read rather than dropped — a lesson lost to
 * a shape change is a fact the box has to be taught again.
 */
function asLesson(value: unknown): Lesson | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = row["id"];
  const text = row["lesson"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof text !== "string" || text.length === 0) return null;
  const status = row["status"];
  const projectId = row["projectId"];
  const source = row["source"];
  const cardIds = row["cardIds"];
  const numberOr = (input: unknown, fallback: number): number =>
    typeof input === "number" && Number.isFinite(input) ? input : fallback;
  const stringOrNull = (input: unknown): string | null =>
    typeof input === "string" && input.length > 0 ? input : null;
  const at = stringOrNull(row["lastLearnedAt"]) ?? new Date(0).toISOString();
  return {
    id,
    projectId: typeof projectId === "string" ? projectId : null,
    topic: typeof row["topic"] === "string" ? row["topic"] : "general",
    lesson: text,
    evidence: stringOrNull(row["evidence"]),
    source: source === "user" || source === "agent" ? source : "hermes",
    learnedCount: numberOr(row["learnedCount"], 1),
    taughtCount: numberOr(row["taughtCount"], 0),
    cardIds: Array.isArray(cardIds) ? cardIds.filter((entry) => typeof entry === "string") : [],
    status:
      typeof status === "string" && STATUSES.has(status) ? (status as LessonStatus) : "active",
    retiredReason: stringOrNull(row["retiredReason"]),
    firstLearnedAt: stringOrNull(row["firstLearnedAt"]) ?? at,
    lastLearnedAt: at,
    lastTaughtAt: stringOrNull(row["lastTaughtAt"]),
  };
}

function persist(): void {
  if (!logPath) return;
  const ordered = [...lessons.values()]
    .sort((a, b) => a.lastLearnedAt.localeCompare(b.lastLearnedAt))
    .slice(-ENTRY_LIMIT);
  lessons = new Map(ordered.map((entry) => [entry.id, entry]));
  try {
    NodeFS.writeFileSync(logPath, `${ordered.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  } catch {
    // A knowledge log that cannot be written must never take down the launch
    // or the tick that was learning something.
  }
}

/**
 * Collapse the wording so the same lesson said twice is one lesson. Filler and
 * punctuation are what differ between two people saying the same thing.
 */
export function normalizeLesson(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|to|of|for|in|on|is|are|be|please|always|never|dont|do|not)\b/g, " ")
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

export function lessonId(input: {
  readonly projectId: string | null;
  readonly lesson: string;
}): string {
  return `${input.projectId ?? "*"}:${hash(normalizeLesson(input.lesson))}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function appendUnique(
  existing: ReadonlyArray<string>,
  value: string | null | undefined,
): ReadonlyArray<string> {
  if (!value || existing.includes(value)) return existing;
  return [...existing, value].slice(-CARD_IDS_KEPT);
}

/**
 * Learn one thing. Learning it again bumps the count and refreshes it, and a
 * retired lesson that someone had to say again comes back — a fact that recurs
 * is news, exactly as a papercut that recurs is.
 */
export function recordLesson(input: LessonInput): Lesson | null {
  const text = clip(input.lesson, LESSON_CHARS);
  if (text.length < MIN_LESSON_CHARS) return null;
  const at = input.at ?? new Date().toISOString();
  const projectId = input.projectId ?? null;
  const id = lessonId({ projectId, lesson: text });
  const previous = lessons.get(id);
  const learnedCount = (previous?.learnedCount ?? 0) + 1;
  const confirmAfter = Math.max(1, Math.floor(input.confirmAfter ?? 1));
  const entry: Lesson = {
    id,
    projectId,
    topic: clip(input.topic ?? previous?.topic ?? "general", TOPIC_CHARS).toLowerCase(),
    // The first wording stands. A restatement is a vote for the fact, not an
    // edit of it, and letting the sloppiest phrasing win is how a lesson decays
    // into something the next agent cannot act on. Rewriting is forget + learn.
    lesson: previous?.lesson ?? text,
    evidence: input.evidence ? clip(input.evidence, EVIDENCE_CHARS) : (previous?.evidence ?? null),
    source: previous?.source ?? input.source,
    learnedCount,
    taughtCount: previous?.taughtCount ?? 0,
    cardIds: appendUnique(previous?.cardIds ?? [], input.cardId),
    status: learnedCount >= confirmAfter ? "active" : "candidate",
    retiredReason: null,
    firstLearnedAt: previous?.firstLearnedAt ?? at,
    lastLearnedAt: at,
    lastTaughtAt: previous?.lastTaughtAt ?? null,
  };
  lessons.delete(id);
  lessons.set(id, entry);
  persist();
  return entry;
}

/**
 * Drop a lesson that turned out to be wrong or is no longer true. Retired, not
 * deleted: the reason is the record of why the board stopped saying it.
 */
export function retireLesson(id: string, reason: string): Lesson | null {
  const entry = lessons.get(id);
  if (!entry || entry.status === "retired") return null;
  const next: Lesson = {
    ...entry,
    status: "retired",
    retiredReason: clip(reason, EVIDENCE_CHARS) || "retired",
  };
  lessons.set(id, next);
  persist();
  return next;
}

export function listLessons(): ReadonlyArray<Lesson> {
  return [...lessons.values()].sort((a, b) => b.lastLearnedAt.localeCompare(a.lastLearnedAt));
}

export function activeLessons(): ReadonlyArray<Lesson> {
  return listLessons().filter((entry) => entry.status === "active");
}

/**
 * Retire what nothing has re-learned in time. Knowledge about a codebase goes
 * out of date silently; an entry that keeps mattering keeps getting learned, so
 * age with no repeat is the honest expiry signal. A candidate gets a shorter
 * rope than a taught lesson — it was never confirmed in the first place.
 */
export function expireStaleLessons(now: number = Date.now()): ReadonlyArray<Lesson> {
  const expired: Lesson[] = [];
  for (const entry of lessons.values()) {
    if (entry.status === "retired") continue;
    const ttl = entry.status === "candidate" ? CANDIDATE_STALE_MS : LESSON_STALE_MS;
    const learnedAt = Date.parse(entry.lastLearnedAt);
    if (!Number.isFinite(learnedAt) || now - learnedAt < ttl) continue;
    const next: Lesson = {
      ...entry,
      status: "retired",
      retiredReason: `nothing re-learned it in ${Math.round(ttl / 86_400_000)} days`,
    };
    lessons.set(entry.id, next);
    expired.push(next);
  }
  if (expired.length > 0) persist();
  return expired;
}

/**
 * What a launch into this project should carry: its own lessons first, then the
 * ones that are true everywhere, most-repeated before most-recent. Repetition
 * ranks above recency because a thing said three times is the thing the next
 * agent is about to get wrong.
 */
export function lessonsForProject(input: {
  readonly projectId: string | null;
  readonly limit?: number;
}): ReadonlyArray<Lesson> {
  const limit = input.limit ?? LESSON_LAUNCH_LIMIT;
  const scored = activeLessons().filter(
    (entry) => entry.projectId === null || entry.projectId === input.projectId,
  );
  return scored
    .sort((a, b) => {
      const scope = Number(b.projectId !== null) - Number(a.projectId !== null);
      if (scope !== 0) return scope;
      if (b.learnedCount !== a.learnedCount) return b.learnedCount - a.learnedCount;
      return b.lastLearnedAt.localeCompare(a.lastLearnedAt);
    })
    .slice(0, limit);
}

/**
 * Count the launches that actually carried a lesson. Without this the panel
 * cannot tell a lesson that is steering work from one nobody has ever read.
 */
export function noteLessonsTaught(ids: ReadonlyArray<string>, at?: string): void {
  const stamp = at ?? new Date().toISOString();
  let touched = false;
  for (const id of ids) {
    const entry = lessons.get(id);
    if (!entry) continue;
    lessons.set(id, { ...entry, taughtCount: entry.taughtCount + 1, lastTaughtAt: stamp });
    touched = true;
  }
  if (touched) persist();
}

/** Drop everything. Only the Maintenance settings route reaches this. */
export function purgeKnowledgeLog(options?: { readonly dryRun?: boolean }): number {
  const removed = lessons.size;
  if (options?.dryRun === true) return removed;
  lessons = new Map();
  if (logPath) {
    try {
      NodeFS.writeFileSync(logPath, "", "utf8");
    } catch {
      // The in-memory index is already clear; a failed truncate must not throw.
    }
  }
  return removed;
}
