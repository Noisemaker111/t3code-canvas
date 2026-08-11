/**
 * Active → PR, decided from the thread itself.
 *
 * A coding agent's closing message cannot be trusted to mean "done" — agents
 * drop the report format in long contexts, and the old loop's answer was to
 * pay a model to read the transcript on every recheck. So the rules ask the
 * thread instead: one turn restating the card's goal, and the agent's own
 * answer is the decision. Done ends it there. Not done sends back the items the
 * agent named and asks the same question again once it has worked. The question
 * and the answer are messages in the chat, so the state is readable where the
 * work is, survives a restart, and needs no table of its own.
 *
 * Everything here is a lookup over the transcript tail. Nothing infers.
 *
 * @module kanban/hermes/completionPass
 */
import { closingQuestion, parseAgentReport } from "./agentReport.ts";
import type { BoardThreadTranscript } from "./boardApi.ts";

/** Marks the turn Hermes sends. Matched verbatim, so it must not be reworded. */
export const COMPLETION_MARKER = "Hermes completion check";
export const REVIEW_MARKER = "Hermes review pass";
/**
 * Its own marker, not the completion one: a conflict bounce is not the agent
 * failing to finish, and counting it separately is what bounds a base branch
 * that keeps moving from cycling the card forever.
 */
export const CONFLICT_MARKER = "Hermes conflict sync";
/**
 * Marks the turn that hands a red pipeline back. Counted on its own so a check
 * that keeps failing bounds the card, and read as an ask so the thread has to
 * answer it before another pull request push goes out.
 */
export const CHECKS_RED_MARKER = "Hermes CI failure";

/**
 * Every turn that asks the thread to answer for the card. `completionStage`
 * reads the newest one of these and the agent's report after it, so a CI-failure
 * brief supersedes an older "DONE" instead of the rules re-reading that answer
 * and pushing again with nothing fixed.
 */
const ASK_MARKERS = [COMPLETION_MARKER, CHECKS_RED_MARKER] as const;

/** Transcript tail the pass reads. The board API's own ceiling. */
export const COMPLETION_TRANSCRIPT_LIMIT = 40;

/**
 * How many completion-checks have been sent to a thread, kept outside the
 * transcript. The board API caps what it returns at COMPLETION_TRANSCRIPT_LIMIT
 * entries, so a thread whose early asks scroll out of that window read as
 * never-asked and the cap reset to zero — the same question came back
 * forever. Process-local, like the nudge count it sits next to: a restart
 * starts over, same as it always has.
 */
const completionCheckCounts = new Map<string, number>();

export function completionChecksAsked(threadId: string): number {
  return completionCheckCounts.get(threadId) ?? 0;
}

export function recordCompletionCheckAsked(threadId: string, check: number): void {
  completionCheckCounts.set(threadId, Math.max(completionChecksAsked(threadId), check));
}

/** Test seam, and cleanup once a thread stops needing the count. */
export function clearCompletionCheckCounts(threadId?: string): void {
  if (threadId === undefined) {
    completionCheckCounts.clear();
  } else {
    completionCheckCounts.delete(threadId);
  }
}

export type CompletionStage =
  /** Nothing asked yet, or the last answer did not settle the question. */
  | { readonly kind: "ask"; readonly check: number }
  /** Asked, and the thread has not answered it. */
  | { readonly kind: "waiting"; readonly marker: string }
  /** The agent answered and named outstanding work. */
  | {
      readonly kind: "continue";
      readonly remaining: ReadonlyArray<string>;
      readonly check: number;
    }
  /** The agent answered that it is blocked. The model owns that, not a rule. */
  | { readonly kind: "blocked"; readonly reason: string }
  /**
   * The thread stopped to ask something. A template cannot answer a question,
   * so the card belongs to the model, which reads the transcript.
   */
  | { readonly kind: "asking"; readonly question: string }
  /** Clean answer, review pass off or already answered clean. */
  | { readonly kind: "finish"; readonly check: number }
  /** Clean answer and the review turn has not been sent yet. */
  | { readonly kind: "review" }
  /** Asked as many times as the cap allows and still not done. */
  | { readonly kind: "exhausted"; readonly checks: number };

const isUser = (role: string): boolean => role === "user";
const isAssistant = (role: string): boolean => role === "assistant";

const carries = (text: string, markers: ReadonlyArray<string>): boolean =>
  markers.some((marker) => text.includes(marker));

/** Entries after the last turn Hermes sent carrying one of `markers`, or null. */
function tailAfterMarker(
  entries: ReadonlyArray<BoardThreadTranscript["entries"][number]>,
  markers: ReadonlyArray<string>,
): ReadonlyArray<BoardThreadTranscript["entries"][number]> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isUser(entry.role) && carries(entry.text, markers)) {
      return entries.slice(index + 1);
    }
  }
  return null;
}

/** `(check 2 of 10)` — the tally, carried in the turn that asks. */
const CHECK_COUNT = /\(check (\d+) of \d+\)/;
const SYNC_COUNT = /\(sync (\d+) of \d+\)/;
const FIX_COUNT = /\(fix (\d+) of \d+\)/;

const countIn = (text: string, pattern: RegExp): number => {
  const match = pattern.exec(text);
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 1;
};

/**
 * Asks already spent on this thread. Counted from the turns in the tail, but
 * floored by the highest tally those turns carry: a chatty agent pushes the
 * early asks out of the window, and a count that resets with the window is a
 * loop with no cap at all.
 */
function countMarkers(
  entries: ReadonlyArray<BoardThreadTranscript["entries"][number]>,
  markers: ReadonlyArray<string>,
  pattern: RegExp,
): number {
  const asks = entries.filter((entry) => isUser(entry.role) && carries(entry.text, markers));
  const highest = asks.reduce((max, entry) => Math.max(max, countIn(entry.text, pattern)), 0);
  return Math.max(asks.length, highest);
}

/**
 * The agent's answer to a marker turn: everything it said afterwards, joined.
 * Agents split a closing across messages, and reading only the last one turns
 * "…and REMAINING: two things" into a clean report.
 */
function answerAfter(
  entries: ReadonlyArray<BoardThreadTranscript["entries"][number]>,
  markers: ReadonlyArray<string>,
): string | null {
  const tail = tailAfterMarker(entries, markers);
  if (tail === null) return null;
  const said = tail.filter((entry) => isAssistant(entry.role)).map((entry) => entry.text.trim());
  return said.length === 0 ? null : said.join("\n\n");
}

/**
 * What the agent said last, on a thread nothing has asked yet. Same joining as
 * `answerAfter` — a closing split across messages is one closing — but bounded
 * by the last thing anyone said to the thread rather than by a marker.
 */
function closingSaid(
  entries: ReadonlyArray<BoardThreadTranscript["entries"][number]>,
): string | null {
  const said: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (isUser(entry.role)) break;
    if (isAssistant(entry.role)) said.unshift(entry.text.trim());
  }
  const joined = said.filter(Boolean).join("\n\n");
  return joined.length === 0 ? null : joined;
}

/**
 * The question a closing stopped on, when the closing is one a template would
 * only talk past: nothing outstanding named, nothing blocking, not done. An
 * agent that listed remaining work is sent back to do it instead — question or
 * not, its own list is the better next step.
 */
function stoppedToAsk(said: string | null): string | null {
  if (said === null) return null;
  const report = parseAgentReport(said);
  if (report.complete || report.blocked !== null || report.remaining.length > 0) return null;
  return closingQuestion(said);
}

/**
 * What the rules should do with one quiet Active thread.
 *
 * There is no schedule here: the thread is asked whether it is done, and the
 * answer is the whole decision. Done ends it. Not done sends back what the
 * agent itself listed, and the same question comes again once it has worked.
 * `maxChecks` only stops a thread that will never say yes — past it the card is
 * a judgment call, not another identical ask.
 */
export function completionStage(input: {
  readonly transcript: BoardThreadTranscript;
  readonly reviewPassEnabled: boolean;
  readonly maxChecks: number;
  /**
   * The durable count from `completionChecksAsked`. Floors the transcript's
   * own tally so a window that scrolled every ask out cannot under-count —
   * it can only ever push the number up, on a fresh process where the
   * durable count is still zero.
   */
  readonly checksAsked?: number;
}): CompletionStage {
  const entries = input.transcript.entries;
  const cap = Math.max(1, Math.floor(input.maxChecks));
  const asked = Math.max(countMarkers(entries, ASK_MARKERS, CHECK_COUNT), input.checksAsked ?? 0);
  const answer = answerAfter(entries, ASK_MARKERS);

  if (asked === 0) {
    // A thread that went quiet on a question was never stopping short — asking
    // it whether the goal is finished talks past what it said and buys another
    // quiet turn. Hand it to the model, which can actually answer.
    const question = stoppedToAsk(closingSaid(entries));
    return question === null ? { kind: "ask", check: 1 } : { kind: "asking", question };
  }
  if (answer === null) return { kind: "waiting", marker: COMPLETION_MARKER };

  const report = parseAgentReport(answer);
  if (report.blocked !== null) return { kind: "blocked", reason: report.blocked };
  const unfinished = (remaining: ReadonlyArray<string>, said: string): CompletionStage => {
    if (asked >= cap) return { kind: "exhausted", checks: asked };
    if (remaining.length > 0) return { kind: "continue", remaining, check: asked + 1 };
    // An answer with nothing outstanding in it is not a list to hand back —
    // "finish this: (nothing)" is the loop the thread cannot escape. If it put
    // a question back, that is the model's; otherwise ask again.
    const question = stoppedToAsk(said);
    return question === null ? { kind: "ask", check: asked + 1 } : { kind: "asking", question };
  };
  if (!report.complete) return unfinished(report.remaining, answer);

  if (!input.reviewPassEnabled) return { kind: "finish", check: asked + 1 };

  const reviewed = countMarkers(entries, [REVIEW_MARKER], CHECK_COUNT);
  if (reviewed === 0) return { kind: "review" };
  const reviewAnswer = answerAfter(entries, [REVIEW_MARKER]);
  if (reviewAnswer === null) return { kind: "waiting", marker: REVIEW_MARKER };

  const reviewReport = parseAgentReport(reviewAnswer);
  if (reviewReport.blocked !== null) return { kind: "blocked", reason: reviewReport.blocked };
  // A review that found work and did not finish it is the same case as an
  // incomplete build: send it back rather than opening a PR over it.
  if (!reviewReport.complete) return unfinished(reviewReport.remaining, reviewAnswer);
  return { kind: "finish", check: asked + 1 };
}

/**
 * Every turn Hermes sends about finishing carries the marker; the tally goes on
 * its own last line. The marker is how the next tick finds its own question,
 * and the tally is how the cap survives a transcript long enough to push the
 * early asks out of the window. It is not a round the agent has to play along
 * with — the question is the same one every time, and a done answer ends it.
 */
const tally = (word: string, count: number, cap: number): string => `(${word} ${count} of ${cap})`;

/** The turn that asks. The goal is restated so the agent judges against it. */
export function completionCheckText(
  card: { readonly title: string; readonly body: string },
  check: number,
  maxChecks: number,
): string {
  const goal = card.body.trim().length > 0 ? card.body.trim() : card.title.trim();
  return [
    `${COMPLETION_MARKER} — is this card's goal finished?`,
    "",
    goal,
    "",
    "If every part of it is done, close with DONE: and a REMAINING: of none.",
    "If anything is left, list it under REMAINING: and finish it now.",
    "Do not branch, commit, push or open a pull request — the board does git.",
    "",
    tally("check", check, maxChecks),
  ].join("\n");
}

/**
 * The turn that sends it back. Names what the agent itself said was left, so it
 * is only ever sent with items — `completionStage` asks again instead when the
 * answer named none.
 */
export function continueText(
  remaining: ReadonlyArray<string>,
  check: number,
  maxChecks: number,
): string {
  return [
    `${COMPLETION_MARKER} — you said this is not finished. Finish it now:`,
    "",
    remaining
      .slice(0, 8)
      .map((item) => `- ${item}`)
      .join("\n"),
    "",
    "Close with DONE: and a REMAINING: of none when there is nothing left.",
    "Do not branch, commit, push or open a pull request — the board does git.",
    "",
    tally("check", check, maxChecks),
  ].join("\n");
}

/**
 * Why the board would not take the work, said in the thread. It carries the
 * completion marker on purpose: the refusal is another ask, so the cap bounds a
 * PR that can never open instead of retrying it every heartbeat.
 */
export function prRefusedText(reason: string, check: number, maxChecks: number): string {
  return [
    `${COMPLETION_MARKER} — the board could not open a pull request for this work.`,
    "",
    reason,
    "",
    "Fix what that names in this worktree, then close with DONE: and a REMAINING: of none.",
    "If it is not something you can fix, say so under BLOCKED:.",
    "Do not branch, commit, push or open a pull request yourself — the board does git.",
    "",
    tally("check", check, maxChecks),
  ].join("\n");
}

/**
 * How many times this thread has already been handed its own merge conflict.
 * A base branch that keeps moving would otherwise bounce one card forever.
 */
export function conflictRounds(transcript: BoardThreadTranscript): number {
  return countMarkers(transcript.entries, [CONFLICT_MARKER], SYNC_COUNT);
}

/**
 * How many times this thread has already been sent back to fix a red pipeline.
 * A check that fails the same way every round would otherwise cycle the card
 * between PR and Active until someone noticed.
 */
export function checksRedRounds(transcript: BoardThreadTranscript): number {
  return countMarkers(transcript.entries, [CHECKS_RED_MARKER], FIX_COUNT);
}

/** Failing checks to name before the brief stops being readable. */
const FAILING_CHECK_LIMIT = 12;

/**
 * The turn that hands a red pipeline back to the thread that wrote the code.
 *
 * The agent has no git and did not watch the pull request, so the brief carries
 * what the forge said rather than pointing at the PR: every check that went red,
 * by the forge's own name for it, and the run each one came from. What it asks
 * for is the only thing the agent can do — reproduce the check here and fix what
 * it reports. The board pushes the fix onto the same pull request.
 */
export function checksRedText(
  failure: {
    readonly failing: ReadonlyArray<{ readonly name: string; readonly url: string | null }>;
    readonly prUrl: string | null;
  },
  fix: number,
  maxFixes: number,
): string {
  const named = failure.failing.slice(0, FAILING_CHECK_LIMIT);
  const rest = failure.failing.length - named.length;
  const checks =
    named.length > 0
      ? [
          ...named.map((check) => `- ${check.name}${check.url === null ? "" : ` — ${check.url}`}`),
          ...(rest > 0 ? [`- (+${rest} more)`] : []),
        ]
      : ["- a required check the forge did not name"];

  return [
    `${CHECKS_RED_MARKER} — CI went red on this card's pull request, so the card is back with you.`,
    "",
    "These checks failed:",
    "",
    ...checks,
    ...(failure.prUrl === null ? [] : ["", `Pull request: ${failure.prUrl}`]),
    "",
    "Your branch is checked out in this worktree, exactly as the pull request has it. Run the " +
      "failing check here with this repo's own command, fix what it reports, and leave the fix in " +
      "the worktree.",
    "",
    "Close with DONE: and a REMAINING: of none once the check passes locally. If the failure is " +
      "not something this card can fix — a flaky runner, a broken main, missing credentials — say " +
      "so under BLOCKED: instead of guessing.",
    "Do not branch, commit, push or open a pull request — you do not touch git. The board pushes " +
      "your fix to the same pull request and merges it once the checks are green.",
    "",
    tally("fix", fix, maxFixes),
  ].join("\n");
}

/**
 * The turn that hands a conflict back to the thread that wrote the code.
 *
 * "Fix these conflicts" is the wrong instruction for an agent with no git: it
 * did not fall behind, it was never told the base was moving, and it has no
 * command to run. So the brief says what happened to it — the base branch
 * shipped while the card was open — names what landed, names the files that
 * collided, and asks for the one thing the agent can actually do: make each
 * file read as finished code again.
 */
export function conflictText(
  conflict: {
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly files: ReadonlyArray<string>;
    readonly baseCommits: ReadonlyArray<string>;
    readonly behindCount: number;
  },
  sync: number,
  maxSyncs: number,
): string {
  const behind =
    conflict.behindCount > 0
      ? `${conflict.behindCount} commit${conflict.behindCount === 1 ? "" : "s"} landed on ${conflict.baseBranch}`
      : `${conflict.baseBranch} moved on`;
  const files =
    conflict.files.length > 0
      ? conflict.files.map((file) => `- ${file}`).join("\n")
      : "- (git did not name a file; look for conflict markers in the files you changed)";
  const landed = conflict.baseCommits.slice(0, 8);

  return [
    `${CONFLICT_MARKER} — your branch went out of sync while you were working.`,
    "",
    `We kept shipping to ${conflict.baseBranch} after this card started — ${behind} since you ` +
      "branched, and some of it touched the same lines you did. That is not something you did " +
      "wrong, and there is nothing for you to have watched for.",
    "",
    ...(landed.length > 0
      ? ["What landed while you worked:", ...landed.map((c) => `- ${c}`), ""]
      : []),
    `The board has already merged ${conflict.baseBranch} into your worktree. It merged everything ` +
      "it could on its own and stopped on these files, where both sides changed the same place:",
    "",
    files,
    "",
    "Open each one. It now holds both versions, marked with `<<<<<<<`, `=======` and `>>>>>>>`:",
    "the part above the divider is your work, the part below is what landed on " +
      `${conflict.baseBranch}. Rewrite each of those sections into the single version that keeps ` +
      "both intentions working, and delete the markers. Where the base already does what your " +
      "change did, keep the base's version and drop yours.",
    "",
    "Nothing else in the worktree needs touching, and you still do not run git — the board " +
      "commits the merge and re-opens the pull request once the files read as finished code.",
    "Close with DONE: and a REMAINING: of none. If two changes genuinely cannot both be kept, " +
      "say which under BLOCKED: instead of guessing.",
    "",
    tally("sync", sync, maxSyncs),
  ].join("\n");
}

export function reviewText(prompt: string): string {
  const body = prompt.trim();
  return [
    `${REVIEW_MARKER} — the goal is done; review it before the pull request.`,
    "",
    body.length > 0 ? body : "Review the change you just made.",
  ].join("\n");
}
