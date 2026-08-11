/**
 * Submitted board-composer prompts, persisted for reuse (clock menu + ↑/↓).
 *
 * Same shape as terminal command history: newest last, dedupe-on-append, capped.
 */

export const PROMPT_HISTORY_LIMIT = 50;
export const PROMPT_HISTORY_STORAGE_KEY = "t3.board-prompt-history.v1";

const CHANGE_EVENT = "t3.promptHistory.changed";
const REUSE_EVENT = "t3.promptHistory.reuse";

/** Append a submitted prompt, moving duplicates to the end. */
export function appendPromptHistory(
  history: readonly string[],
  prompt: string,
  limit: number = PROMPT_HISTORY_LIMIT,
): readonly string[] {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return history;
  const next = history.filter((entry) => entry !== trimmed);
  next.push(trimmed);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function readStoredPromptHistory(
  storage: Pick<Storage, "getItem"> | undefined = typeof window !== "undefined"
    ? window.localStorage
    : undefined,
): readonly string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PROMPT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(-PROMPT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeStoredPromptHistory(
  storage: Pick<Storage, "setItem"> | undefined,
  history: readonly string[],
): void {
  if (!storage) return;
  try {
    storage.setItem(
      PROMPT_HISTORY_STORAGE_KEY,
      JSON.stringify(history.slice(-PROMPT_HISTORY_LIMIT)),
    );
  } catch {
    // Persistence is best-effort (private browsing, quota).
  }
}

/** Persist a newly submitted prompt and notify subscribers. */
export function recordSubmittedPrompt(prompt: string): readonly string[] {
  const storage = typeof window !== "undefined" ? window.localStorage : undefined;
  const next = appendPromptHistory(readStoredPromptHistory(storage), prompt);
  writeStoredPromptHistory(storage, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }
  return next;
}

export function subscribePromptHistory(listener: (history: readonly string[]) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<readonly string[]>).detail;
    listener(Array.isArray(detail) ? detail : readStoredPromptHistory());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === PROMPT_HISTORY_STORAGE_KEY) {
      listener(readStoredPromptHistory());
    }
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Notify the composer that a history entry was chosen from the clock menu. */
export function notifyPromptHistoryReuse(prompt: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REUSE_EVENT, { detail: prompt }));
}

export function subscribePromptHistoryReuse(listener: (prompt: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onReuse = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(REUSE_EVENT, onReuse);
  return () => window.removeEventListener(REUSE_EVENT, onReuse);
}

/**
 * Shell-style cycle index over history (newest last).
 * `null` means not cycling (empty / draft composer).
 */
export function nextPromptHistoryIndex(
  historyLength: number,
  current: number | null,
  direction: "older" | "newer",
): number | null {
  if (historyLength <= 0) return null;
  if (direction === "older") {
    if (current === null) return historyLength - 1;
    return current > 0 ? current - 1 : 0;
  }
  if (current === null) return null;
  if (current >= historyLength - 1) return null;
  return current + 1;
}
