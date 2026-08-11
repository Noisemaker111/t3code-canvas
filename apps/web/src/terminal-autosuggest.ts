/**
 * History-based inline autosuggestion for the thread terminal (fish-style ghost text).
 *
 * The shell runs remotely, so the client mirrors what the user types by folding
 * terminal input data into a small tracker state. Tracking is best-effort: any
 * input that can move the cursor or rewrite the line in ways we cannot mirror
 * (escape sequences, tab completion, unknown control characters) suspends
 * suggestions until the next prompt (Enter or Ctrl+C).
 */

export interface TerminalInputTrackerState {
  /** The line the user has typed at the prompt, as far as we can mirror it. */
  readonly line: string;
  /** False once input became untrackable; resets on Enter or Ctrl+C. */
  readonly tracking: boolean;
}

export interface TerminalInputStepResult {
  readonly state: TerminalInputTrackerState;
  /** Commands committed with Enter during this step, oldest first. */
  readonly committed: readonly string[];
}

export const INITIAL_TERMINAL_INPUT_TRACKER_STATE: TerminalInputTrackerState = {
  line: "",
  tracking: true,
};

const BACKSPACE = "\u007f";
const CTRL_C = "\u0003";
const CTRL_U = "\u0015";
const CTRL_W = "\u0017";
const ESCAPE = "\u001b";

function removeTrailingWord(line: string): string {
  return line.replace(/\s+$/, "").replace(/\S+$/, "");
}

/** Folds a chunk of terminal input data (from xterm onData) into the tracker. */
export function applyTerminalInputData(
  state: TerminalInputTrackerState,
  data: string,
): TerminalInputStepResult {
  let { line, tracking } = state;
  const committed: string[] = [];

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index] ?? "";
    if (char === "\r" || char === "\n") {
      if (tracking && line.trim().length > 0) {
        committed.push(line.trim());
      }
      line = "";
      tracking = true;
      continue;
    }
    if (char === CTRL_C) {
      line = "";
      tracking = true;
      continue;
    }
    if (char === ESCAPE) {
      // Arrow keys, history navigation, bracketed paste… all start with ESC and
      // rewrite the line in ways we cannot mirror. Give up until the next prompt.
      return { state: { line: "", tracking: false }, committed };
    }
    if (!tracking) {
      continue;
    }
    if (char === BACKSPACE) {
      line = line.slice(0, -1);
      continue;
    }
    if (char === CTRL_U) {
      line = "";
      continue;
    }
    if (char === CTRL_W) {
      line = removeTrailingWord(line);
      continue;
    }
    if (char < " ") {
      // Tab completion and other control characters mutate the line server-side.
      line = "";
      tracking = false;
      continue;
    }
    line += char;
  }

  return { state: { line, tracking }, committed };
}

const MIN_SUGGESTION_INPUT_LENGTH = 2;
export const TERMINAL_HISTORY_LIMIT = 200;

/**
 * Returns the most recent history entry that extends the typed input, or null.
 */
export function matchTerminalSuggestion(history: readonly string[], input: string): string | null {
  if (input.trim().length < MIN_SUGGESTION_INPUT_LENGTH) return null;
  if (input.trimStart() !== input) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry !== undefined && entry.length > input.length && entry.startsWith(input)) {
      return entry;
    }
  }
  return null;
}

/** The ghost-text remainder to render after the typed input. */
export function terminalSuggestionSuffix(history: readonly string[], input: string): string | null {
  const suggestion = matchTerminalSuggestion(history, input);
  return suggestion === null ? null : suggestion.slice(input.length);
}

/** Appends a committed command, deduplicating and capping the history. */
export function appendTerminalHistory(
  history: readonly string[],
  command: string,
  limit: number = TERMINAL_HISTORY_LIMIT,
): readonly string[] {
  const trimmed = command.trim();
  if (trimmed.length < MIN_SUGGESTION_INPUT_LENGTH) return history;
  const next = history.filter((entry) => entry !== trimmed);
  next.push(trimmed);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

const HISTORY_STORAGE_KEY = "t3.terminal-command-history";

export function readStoredTerminalHistory(
  storage: Pick<Storage, "getItem"> | undefined,
): readonly string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .slice(-TERMINAL_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeStoredTerminalHistory(
  storage: Pick<Storage, "setItem"> | undefined,
  history: readonly string[],
): void {
  if (!storage) return;
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-TERMINAL_HISTORY_LIMIT)));
  } catch {
    // Persistence is best-effort (private browsing, quota).
  }
}

/**
 * True when a keydown should accept the current suggestion instead of being
 * forwarded to the shell (plain ArrowRight or End with ghost text visible).
 */
export function isSuggestionAcceptKey(event: {
  readonly type?: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  if (event.type !== undefined && event.type !== "keydown") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return event.key === "ArrowRight" || event.key === "End";
}
