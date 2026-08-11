/**
 * TranscriptBuilder — pure helpers that turn `conversation_log` rows into the
 * tagged transcript embedded in the btw system prompt, and compose the full
 * model prompt for a btw turn.
 *
 * Budgeting: we sum `tokens` across the transcript; when it exceeds the budget
 * we drop the OLDEST `tool_call` rows first (they are the least essential for
 * discussing the conversation) and note the truncation in the system prompt.
 * The btw chat history is never touched by this budget.
 *
 * @module btw/TranscriptBuilder
 */
import type { BtwMessageRow } from "../persistence/Services/BtwMessages.ts";
import type { ConversationLogEntry } from "../persistence/Services/ConversationLog.ts";

/** Default transcript token budget. Generous but bounded. */
export const DEFAULT_TRANSCRIPT_TOKEN_BUDGET = 120_000;

export const BTW_SYSTEM_PROMPT_HEADER =
  `You are a chat assistant discussing a single coding-assistant conversation ` +
  `with the user. The transcript below is tagged: [<type> · <duration> · ` +
  `<tokens>], type = prompt (user), response (assistant), or tool_call. Ground ` +
  `every claim in the transcript; if something isn't there, say so. Be concise, ` +
  `cite specific entries, and carry context across the back-and-forth. You may ` +
  `compute over the metadata (totals, slowest tool, command count). Never invent ` +
  `file contents or outputs not shown.`;

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null || Number.isNaN(durationMs)) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

const formatTokens = (tokens: number | null): string =>
  tokens === null || Number.isNaN(tokens) ? "—" : `${Math.round(tokens)} tok`;

const entryTag = (entry: ConversationLogEntry): string => {
  const type = entry.entryType === "tool_call" && entry.toolKind ? entry.toolKind : entry.entryType;
  return `[${type} · ${formatDuration(entry.durationMs)} · ${formatTokens(entry.tokens)}]`;
};

/** Format a single transcript entry as `[tag]\n<text>`. */
export const formatTranscriptEntry = (entry: ConversationLogEntry): string => {
  const text = (entry.text ?? "").trim();
  return `${entryTag(entry)}\n${text.length > 0 ? text : "(no text)"}`;
};

export interface TranscriptBudgetResult {
  readonly entries: ReadonlyArray<ConversationLogEntry>;
  readonly droppedToolCalls: number;
  readonly totalTokens: number;
  readonly keptTokens: number;
  readonly truncated: boolean;
}

const tokensOf = (entry: ConversationLogEntry): number =>
  entry.tokens === null || Number.isNaN(entry.tokens) ? 0 : entry.tokens;

/**
 * Apply the token budget by dropping the oldest `tool_call` rows first. Entries
 * are assumed to already be in ascending time order.
 */
export const applyTranscriptBudget = (
  entries: ReadonlyArray<ConversationLogEntry>,
  tokenBudget: number,
): TranscriptBudgetResult => {
  const totalTokens = entries.reduce((sum, entry) => sum + tokensOf(entry), 0);
  if (totalTokens <= tokenBudget) {
    return {
      entries,
      droppedToolCalls: 0,
      totalTokens,
      keptTokens: totalTokens,
      truncated: false,
    };
  }

  // Mark oldest tool_call rows for removal until we're under budget.
  const dropIndexes = new Set<number>();
  let running = totalTokens;
  for (let i = 0; i < entries.length && running > tokenBudget; i += 1) {
    if (entries[i]?.entryType === "tool_call") {
      dropIndexes.add(i);
      running -= tokensOf(entries[i]!);
    }
  }

  const kept = entries.filter((_, index) => !dropIndexes.has(index));
  return {
    entries: kept,
    droppedToolCalls: dropIndexes.size,
    totalTokens,
    keptTokens: kept.reduce((sum, entry) => sum + tokensOf(entry), 0),
    truncated: dropIndexes.size > 0,
  };
};

/** Build the btw system prompt with the (possibly truncated) transcript embedded. */
export const buildBtwSystemPrompt = (
  entries: ReadonlyArray<ConversationLogEntry>,
  tokenBudget: number = DEFAULT_TRANSCRIPT_TOKEN_BUDGET,
): string => {
  const budget = applyTranscriptBudget(entries, tokenBudget);
  const transcript =
    budget.entries.length > 0
      ? budget.entries.map(formatTranscriptEntry).join("\n\n")
      : "(the coding conversation is empty)";
  const truncationNote = budget.truncated
    ? `\nNOTE: the transcript was truncated to fit the token budget — ${budget.droppedToolCalls} ` +
      `older tool_call entr${budget.droppedToolCalls === 1 ? "y was" : "ies were"} dropped. ` +
      `Full conversation token total was ~${budget.totalTokens}.`
    : "";
  return `${BTW_SYSTEM_PROMPT_HEADER}${truncationNote}\nTRANSCRIPT:\n${transcript}`;
};

const roleLabel = (role: BtwMessageRow["role"]): string =>
  role === "assistant" ? "Assistant" : "User";

/**
 * Compose the single prompt string fed to the model: the system prompt, the
 * prior btw messages, and the new user message. The Claude CLI takes one prompt
 * on stdin, so the whole conversation is flattened here (btw history is kept
 * intact — only the transcript is ever budgeted).
 */
export const composeBtwPrompt = (input: {
  readonly systemPrompt: string;
  readonly history: ReadonlyArray<BtwMessageRow>;
  readonly newMessage: string;
}): string => {
  const historyBlock =
    input.history.length > 0
      ? input.history
          .map((message) => `${roleLabel(message.role)}: ${message.content}`)
          .join("\n\n")
      : "(no prior messages)";
  return [
    input.systemPrompt,
    "",
    "=== BTW CHAT SO FAR ===",
    historyBlock,
    "",
    "=== NEW USER MESSAGE ===",
    input.newMessage,
    "",
    "Reply as the assistant. Do not use any tools; answer directly from the transcript above.",
  ].join("\n");
};
