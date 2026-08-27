/**
 * Turning knowledge into the two blocks that spend it.
 *
 * The store keeps lessons; this decides what a launch prompt and a tick prompt
 * actually say. They are different audiences: an agent is told the fact in the
 * imperative and never learns that a board exists, while Hermes is shown the
 * same lessons with their ids so it can add one or take one back.
 *
 * The capture rule lives here too. Hermes correcting a thread is the loop
 * paying for something nobody wrote down — so every correction it types is
 * remembered, and a correction it types **twice** stops being a nudge and
 * becomes a lesson that ships with the next launch. That is the whole
 * self-improvement mechanism: no model call, no schedule, no human.
 *
 * @module kanban/hermes/lessons
 */
import {
  MIN_LESSON_CHARS,
  recordLesson,
  type Lesson,
  type LessonSource,
} from "./knowledgeStore.ts";

/** Sightings of the same correction before it is taught to every later launch. */
export const CORRECTION_CONFIRMATIONS = 2;

/** Characters of a lesson rendered into a prompt. Longer is a document. */
const LESSON_LINE_CHARS = 200;

/** The whole block's budget, so a project with 40 lessons cannot dwarf the task. */
const LESSON_BLOCK_CHARS = 1200;

export const LAUNCH_LESSONS_HEADING = "## What we already know here";

function line(lesson: Lesson): string {
  const text =
    lesson.lesson.length > LESSON_LINE_CHARS
      ? `${lesson.lesson.slice(0, LESSON_LINE_CHARS)}…`
      : lesson.lesson;
  return `- ${text}`;
}

/**
 * The block appended to a launch. Written as facts, not as history: an agent
 * cannot act on who learned this or when, and every word explaining that costs
 * the same as a word of the task.
 */
export function formatLaunchLessons(lessons: ReadonlyArray<Lesson>): string | null {
  const lines: string[] = [];
  let budget = LESSON_BLOCK_CHARS;
  for (const lesson of lessons) {
    const rendered = line(lesson);
    if (rendered.length > budget) break;
    budget -= rendered.length + 1;
    lines.push(rendered);
  }
  if (lines.length === 0) return null;
  return [
    LAUNCH_LESSONS_HEADING,
    "",
    "Things earlier work in this repo established. They hold unless the task says otherwise.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * The same lessons for Hermes, with ids. It is told to write one down rather
 * than repeat itself, and to take one back the moment it is contradicted —
 * knowledge nobody can retract is worse than none.
 */
export function formatKnowledgeBlock(lessons: ReadonlyArray<Lesson>): string | null {
  if (lessons.length === 0) return null;
  // What these are and what to do about them is in the cached prefix. This
  // block is the facts and their ids, which is all that changes per tick.
  return [
    ...lessons.map((lesson) => {
      const scope = lesson.projectId === null ? "every project" : lesson.projectId;
      const taught = lesson.taughtCount > 0 ? `, taught ${lesson.taughtCount}×` : "";
      return `- ${lesson.id} [${lesson.topic} · ${scope}${taught}] ${lesson.lesson}`;
    }),
  ].join("\n");
}

/** A nudge Hermes wrote itself, not a template the rules pass sent. */
export function isCorrection(text: string): boolean {
  return text.trim().length >= MIN_LESSON_CHARS;
}

/**
 * Every correction a tick's program typed, learned from the recorded calls.
 *
 * Read here rather than inside the verb because the runtime already knows which
 * card owns which thread: resolving it in `nudgeThread` would buy a board read
 * and a transcript line per nudge to recover what the tick was holding anyway.
 */
export function learnFromTickNudges(input: {
  readonly calls: ReadonlyArray<{
    readonly method: string;
    readonly args: unknown;
    readonly skipped?: boolean;
  }>;
  readonly cards: ReadonlyArray<{
    readonly id: string;
    readonly threadId?: string | null;
    readonly projectId?: string | null;
  }>;
  readonly at?: string;
}): ReadonlyArray<Lesson> {
  const byThread = new Map(
    input.cards
      .filter((card) => typeof card.threadId === "string" && card.threadId.length > 0)
      .map((card) => [String(card.threadId), card]),
  );
  const learned: Lesson[] = [];
  for (const call of input.calls) {
    if (call.method !== "nudgeThread" || call.skipped === true) continue;
    const args =
      typeof call.args === "object" && call.args !== null
        ? (call.args as Record<string, unknown>)
        : {};
    const text = typeof args["text"] === "string" ? args["text"] : "";
    const threadId = typeof args["threadId"] === "string" ? args["threadId"] : "";
    const card = byThread.get(threadId);
    const lesson = learnFromCorrection({
      text,
      projectId: card?.projectId ? String(card.projectId) : null,
      cardId: card?.id ?? null,
      ...(input.at === undefined ? {} : { at: input.at }),
    });
    if (lesson !== null) learned.push(lesson);
  }
  return learned;
}

/**
 * Remember one correction. The first sighting is a candidate and teaches
 * nobody; the second promotes it, because a correction that fits two different
 * cards is about the project rather than about either of them. A nudge naming a
 * file, an id or a card's own wording never normalizes to the same key twice,
 * so card-specific text stays a candidate and expires on its own.
 */
export function learnFromCorrection(input: {
  readonly text: string;
  readonly projectId: string | null;
  readonly cardId?: string | null;
  readonly source?: LessonSource;
  readonly at?: string;
}): Lesson | null {
  if (!isCorrection(input.text)) return null;
  return recordLesson({
    lesson: input.text,
    projectId: input.projectId,
    topic: "correction",
    evidence: "Hermes had to say this to more than one thread",
    source: input.source ?? "hermes",
    cardId: input.cardId ?? null,
    confirmAfter: CORRECTION_CONFIRMATIONS,
    ...(input.at === undefined ? {} : { at: input.at }),
  });
}
