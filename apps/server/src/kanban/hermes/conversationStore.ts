/**
 * Durable Hermes conversation — `<baseDir>/hermes/conversation.jsonl`.
 *
 * First line is the meta record (system prompt version, journal, digest), each
 * later line one turn. Rewritten whole per tick — the history is capped, so
 * the file stays small and a torn write can never interleave two ticks.
 *
 * @module kanban/hermes/conversationStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  HermesCliSessionRecord,
  HermesConversationState,
  HermesConversationTurn,
  HermesEvictionReason,
} from "./conversation.ts";
import type { HermesJournalEntry } from "./journal.ts";

/**
 * v1 stored a model-written prose memory; v2 cut on a counter. Neither is
 * migrated — a turn without its cards has no boundary to be cut at. v3 is
 * readable as v4 without its CLI session: the history is intact, and a missing
 * session is the one this code already handles, so v3 turns are kept.
 */
const META_VERSION = 4;
const READABLE_META_VERSIONS = new Set([3, META_VERSION]);

type MetaLine = {
  readonly kind: "meta";
  readonly v: typeof META_VERSION;
  readonly systemPromptVersion: string;
  readonly journal: ReadonlyArray<HermesJournalEntry>;
  readonly lastEvictionAt: string | null;
  readonly lastEvictionReason: HermesEvictionReason | null;
  readonly startedAt: string | null;
  readonly boardDigest: Record<string, string>;
  readonly resnapshot: boolean;
  readonly lastInputTokens: number | null;
  readonly cliSession: HermesCliSessionRecord | null;
};

function readCliSession(value: unknown): HermesCliSessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<HermesCliSessionRecord>;
  if (
    typeof row.tier !== "string" ||
    typeof row.model !== "string" ||
    typeof row.id !== "string" ||
    row.id.length === 0
  ) {
    return null;
  }
  return { tier: row.tier, model: row.model, id: row.id };
}

type TurnLine = {
  readonly kind: "turn";
  readonly role: "user" | "assistant";
  readonly turnKind: HermesConversationTurn["kind"];
  readonly content: string;
  readonly at: string;
  readonly cards: ReadonlyArray<string>;
};

const EVICTION_REASONS = new Set(["settled", "resolved", "ceiling"]);

let conversationPath: string | null = null;

export function hermesConversationPath(): string | null {
  return conversationPath;
}

export function bindHermesConversation(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    conversationPath = NodePath.join(dir, "conversation.jsonl");
  } catch {
    conversationPath = null;
  }
  return conversationPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path. */
export function unbindHermesConversation(): void {
  conversationPath = null;
}

export type HermesConversationReadResult =
  | { readonly state: HermesConversationState }
  | { readonly corrupt: true; readonly journal: ReadonlyArray<HermesJournalEntry> }
  | null;

/**
 * Restore from disk. A corrupt file surfaces as `corrupt` with whatever journal
 * the meta line still holds, so the caller reseeds instead of failing a tick.
 */
export function readHermesConversation(): HermesConversationReadResult {
  if (!conversationPath) return null;
  let raw: string;
  try {
    raw = NodeFS.readFileSync(conversationPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  let meta: MetaLine | null = null;
  try {
    const parsed = JSON.parse(lines[0] ?? "") as Partial<MetaLine>;
    if (
      parsed.kind === "meta" &&
      READABLE_META_VERSIONS.has(Number(parsed.v)) &&
      typeof parsed.systemPromptVersion === "string"
    ) {
      meta = {
        kind: "meta",
        v: META_VERSION,
        systemPromptVersion: parsed.systemPromptVersion,
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
        lastEvictionAt: typeof parsed.lastEvictionAt === "string" ? parsed.lastEvictionAt : null,
        lastEvictionReason: EVICTION_REASONS.has(String(parsed.lastEvictionReason))
          ? (parsed.lastEvictionReason as HermesEvictionReason)
          : null,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
        boardDigest:
          parsed.boardDigest !== null && typeof parsed.boardDigest === "object"
            ? (parsed.boardDigest as Record<string, string>)
            : {},
        resnapshot: parsed.resnapshot === true,
        lastInputTokens: typeof parsed.lastInputTokens === "number" ? parsed.lastInputTokens : null,
        cliSession: readCliSession(parsed.cliSession),
      };
    }
  } catch {
    meta = null;
  }
  if (!meta) return { corrupt: true, journal: [] };

  const turns: HermesConversationTurn[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as Partial<TurnLine>;
      if (
        parsed.kind !== "turn" ||
        (parsed.role !== "user" && parsed.role !== "assistant") ||
        typeof parsed.content !== "string" ||
        typeof parsed.at !== "string"
      ) {
        return { corrupt: true, journal: meta.journal };
      }
      turns.push({
        role: parsed.role,
        kind: parsed.turnKind ?? "delta",
        content: parsed.content,
        at: parsed.at,
        cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      });
    } catch {
      return { corrupt: true, journal: meta.journal };
    }
  }

  return {
    state: {
      systemPromptVersion: meta.systemPromptVersion,
      turns,
      journal: meta.journal,
      lastEvictionAt: meta.lastEvictionAt,
      lastEvictionReason: meta.lastEvictionReason,
      startedAt: meta.startedAt,
      boardDigest: meta.boardDigest,
      resnapshot: meta.resnapshot,
      lastInputTokens: meta.lastInputTokens,
      cliSession: meta.cliSession,
    },
  };
}

export function writeHermesConversation(state: HermesConversationState): void {
  if (!conversationPath) return;
  const meta: MetaLine = {
    kind: "meta",
    v: META_VERSION,
    systemPromptVersion: state.systemPromptVersion,
    journal: state.journal,
    lastEvictionAt: state.lastEvictionAt,
    lastEvictionReason: state.lastEvictionReason,
    startedAt: state.startedAt,
    boardDigest: state.boardDigest,
    resnapshot: state.resnapshot,
    lastInputTokens: state.lastInputTokens,
    cliSession: state.cliSession,
  };
  const lines = [
    JSON.stringify(meta),
    ...state.turns.map((turn) =>
      JSON.stringify({
        kind: "turn",
        role: turn.role,
        turnKind: turn.kind,
        content: turn.content,
        at: turn.at,
        cards: turn.cards,
      } satisfies TurnLine),
    ),
  ];
  try {
    NodeFS.writeFileSync(conversationPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Losing a conversation write must never break a tick.
  }
}

export function deleteHermesConversation(): void {
  if (!conversationPath) return;
  try {
    NodeFS.rmSync(conversationPath, { force: true });
  } catch {
    // Already gone is fine.
  }
}
