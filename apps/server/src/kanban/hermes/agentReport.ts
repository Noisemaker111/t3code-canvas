/**
 * Parse a coding agent's closing report.
 *
 * The launch contract asks for `DONE:` / `REMAINING:` / `BLOCKED:` sections,
 * but agents phrase closings however they like. This parser takes the fenced
 * shape when it is there and falls back to headings and prose so Hermes still
 * learns whether work is outstanding.
 *
 * @module kanban/hermes/agentReport
 */

export type AgentReport = {
  readonly done: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
  readonly blocked: string | null;
  /** True when nothing is outstanding and nothing is blocking. */
  readonly complete: boolean;
};

type Section = "done" | "remaining" | "blocked" | null;

const SECTION_PATTERNS: ReadonlyArray<{
  readonly section: Exclude<Section, null>;
  readonly re: RegExp;
}> = [
  {
    section: "done",
    re: /^\W*(?:done|completed|what (?:was|i) (?:did|done)|changes made)\b[\s*_#:]*$/i,
  },
  {
    section: "remaining",
    re: /^\W*(?:remaining|still (?:to do|outstanding|left)|todo|to do|next steps?|not done|left to do|outstanding)\b[\s*_#:]*$/i,
  },
  { section: "blocked", re: /^\W*(?:blocked|blocker|blocked on|needs? input)\b[\s*_#:]*$/i },
];

const INLINE_PATTERNS: ReadonlyArray<{
  readonly section: Exclude<Section, null>;
  readonly re: RegExp;
}> = [
  { section: "done", re: /^\W*(?:done|completed|changes made)\b\s*:\s*(.+)$/i },
  {
    section: "remaining",
    re: /^\W*(?:remaining|still (?:to do|outstanding|left)|todo|to do|next steps?|not done|left to do|outstanding)\b\s*:\s*(.+)$/i,
  },
  { section: "blocked", re: /^\W*(?:blocked(?: on)?|blocker|needs? input)\b\s*:\s*(.+)$/i },
];

const NOTHING_LEFT =
  /^(?:none|nothing|n\/a|no(?:ne)?\.?|nothing (?:left|remaining|outstanding)|all done|—|-)\.?$/i;

const NOTHING_LEFT_QUALIFIED =
  /^(?:none|nothing)\b(?:\s+(?:left|remaining|outstanding|else|more|further|for (?:this|that|the|now)\b[\w\s-]*|at (?:this|the) (?:time|point)|so far|currently|right now))*\s*[.!]?$/i;

/**
 * "none" with a qualifier or trailing aside still means none — agents write
 * "none for this task. (Note: …)" and an aside must not read as outstanding work.
 */
function isNothingLeft(value: string): boolean {
  const bare = value
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, " ")
    .replace(/\([^)]*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return NOTHING_LEFT.test(bare) || NOTHING_LEFT_QUALIFIED.test(bare);
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, "").trim();
}

/**
 * Markdown delimiters around a value, gone. Agents write `**REMAINING:** none`,
 * and the closing `**` lands in the value: "** none" is not "none", so a card
 * that was finished got sent back to finish itself, forever. Edges only —
 * `snake_case.ts` in a real remaining item has to survive.
 */
function stripEmphasis(value: string): string {
  return value.replace(/^[\s*_`~]+/, "").replace(/[\s*_`~]+$/, "");
}

function stripFences(text: string): string {
  return text.replace(/^```[^\n]*\n?|\n?```$/g, "");
}

/** Prose closers that mean "nothing outstanding" without a REMAINING section. */
const DONE_PHRASES =
  /\b(?:everything(?:'s| is)? (?:done|complete)|nothing (?:else )?(?:is )?(?:left|remaining|outstanding)|no (?:remaining|outstanding|further) (?:work|items|tasks)|task is complete|fully implemented)\b/i;

/**
 * A reply that is only a bare affirmation — "Done.", "Yes, it's done.",
 * "All set" — with nothing else in it. Anchored to the whole line so it
 * cannot match inside a longer sentence: "Not done yet" or "Done with the
 * first part, still working on the rest" both correctly miss this and fall
 * through to being read as incomplete.
 */
const BARE_DONE_REPLY =
  /^(?:yes|yep|yup)?\W*(?:it'?s\s+|i'?m\s+|this\s+is\s+)?(?:all\s+)?(?:done|finished|complete|completed)\W*$/i;

/**
 * A direct ask, in the words agents actually use to stop and check. Anchored on
 * the phrase rather than the question mark so "let me know which one" counts.
 */
const DECISION_ASK =
  /\b(?:should i|should we|shall i|do you want|would you (?:like|prefer)|which (?:one|option|approach|way|of these)|want me to|let me know (?:which|whether|if)|confirm whether|or should)\b/i;

/** How much of the question a one-line label carries. The message is elsewhere. */
const QUESTION_LABEL_LIMIT = 200;

/**
 * The question a coding agent stopped on, or null.
 *
 * An agent that ends a turn asking — "phase 1 landed, should phase 2 reuse the
 * store or get its own?" — has not stopped short and is not blocked, so no
 * report shape matches it and the rules hand it the completion template. That
 * template is the wrong answer to a question. This finds the ask, so the card
 * goes to the model instead, which reads the whole closing and either nudges
 * with the decision or puts the fork to the human.
 *
 * The whole closing is read — an agent's last word is a page, not a line, and
 * where in it the ask lands says nothing about whether it is one. What bounds
 * this is the closing's own report shape, which callers check first: a closing
 * that named outstanding work, that is blocked, or that is done is not a
 * question, wherever the question mark sits. Past those, erring towards the
 * model is the cheap mistake — it reads the message and decides, which is what
 * a quiet Active card was going to cost anyway.
 *
 * What comes back is a **label** for a log or a queue line, clipped. It is not
 * the question to answer from: that is the closing itself, which the prompt
 * carries in full.
 */
export function closingQuestion(raw: string | null | undefined): string | null {
  const text = stripFences((raw ?? "").trim());
  if (!text) return null;

  for (const rawLine of text.split("\n")) {
    const line = stripEmphasis(stripBullet(rawLine.trim()));
    if (!line || (!line.endsWith("?") && !DECISION_ASK.test(line))) continue;
    const flat = line.replace(/\s+/g, " ").trim();
    return flat.length > QUESTION_LABEL_LIMIT ? `${flat.slice(0, QUESTION_LABEL_LIMIT)}…` : flat;
  }
  return null;
}

export function parseAgentReport(raw: string | null | undefined): AgentReport {
  const text = stripFences((raw ?? "").trim());
  if (!text) return { done: [], remaining: [], blocked: null, complete: false };

  const done: string[] = [];
  const remaining: string[] = [];
  const blockedLines: string[] = [];
  let section: Section = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const inline = INLINE_PATTERNS.find((pattern) => pattern.re.test(line));
    if (inline) {
      const value = stripEmphasis(inline.re.exec(line)?.[1]?.trim() ?? "");
      section = inline.section;
      if (value && !isNothingLeft(value)) {
        (inline.section === "done"
          ? done
          : inline.section === "remaining"
            ? remaining
            : blockedLines
        ).push(value);
      }
      continue;
    }

    const heading = SECTION_PATTERNS.find((pattern) => pattern.re.test(line));
    if (heading) {
      section = heading.section;
      continue;
    }

    if (section === null) continue;
    const value = stripEmphasis(stripBullet(line));
    if (!value || isNothingLeft(value)) continue;
    if (section === "done") done.push(value);
    else if (section === "remaining") remaining.push(value);
    else blockedLines.push(value);
  }

  const blocked = blockedLines.length > 0 ? blockedLines.join(" ") : null;
  // No structure at all: fall back to the prose closers agents actually write.
  const sawStructure =
    done.length > 0 || remaining.length > 0 || blocked !== null || section !== null;
  // A reply that is nothing but "Done." matches neither: it has no section
  // heading and none of DONE_PHRASES' longer stock phrases, so it read as
  // incomplete and the same question came back forever. Checked against the
  // last paragraph too — agents close a multi-message answer with a bare
  // one-liner after the actual content.
  const lastParagraph =
    text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const bareDone = BARE_DONE_REPLY.test(text) || BARE_DONE_REPLY.test(lastParagraph);
  const complete =
    remaining.length === 0 &&
    blocked === null &&
    (sawStructure || DONE_PHRASES.test(text) || bareDone);

  return { done, remaining, blocked, complete };
}
