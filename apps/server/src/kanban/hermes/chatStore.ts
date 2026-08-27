/**
 * Durable Hermes chat — `<baseDir>/hermes/chat.jsonl`.
 *
 * The conversation the model carries is cut at every decision boundary, which
 * is right for a prompt and useless for a reader: the history you want to
 * scroll is exactly the one eviction just dropped. This file is that history —
 * one line per turn, appended, never evicted, only trimmed. It is read by the
 * board's Hermes panel and by nothing the model sees.
 *
 * @module kanban/hermes/chatStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HermesChatEntry } from "@t3tools/contracts";

/** Board blocks are the bulk of a line; keep the file to a few MB at worst. */
const MAX_LINE_CHARS = 12_000;
const CHAT_LIMIT = 400;

const clip = (text: string): string =>
  text.length > MAX_LINE_CHARS / 2 ? `${text.slice(0, MAX_LINE_CHARS / 2)}…` : text;

let chatPath: string | null = null;
let seq = 0;
const feed: HermesChatEntry[] = [];

export function bindHermesChat(baseDir: string): string {
  const dir = NodePath.join(baseDir, "hermes");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    chatPath = NodePath.join(dir, "chat.jsonl");
  } catch {
    chatPath = null;
  }
  return chatPath ?? "";
}

/** Test seam and teardown: stop writing to a bound path, and forget the feed. */
export function unbindHermesChat(): void {
  chatPath = null;
  feed.length = 0;
  seq = 0;
}

/** Oldest first — the order a chat is read in. */
export function hermesChatEntries(limit = 80): ReadonlyArray<HermesChatEntry> {
  return feed.slice(-Math.max(1, limit));
}

/** Rehydrate the in-memory feed so a restart does not blank the panel. */
export function restoreHermesChat(): void {
  feed.length = 0;
  seq = 0;
  if (!chatPath) return;
  let raw: string;
  try {
    raw = NodeFS.readFileSync(chatPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      feed.push(JSON.parse(line) as HermesChatEntry);
    } catch {
      // A torn last line from a kill mid-write is not worth losing the file over.
    }
  }
  if (feed.length > CHAT_LIMIT) feed.splice(0, feed.length - CHAT_LIMIT);
  seq = feed.length;
}

/** Ids are assigned here so a caller cannot hand out two of the same. */
export function appendHermesChat(
  entries: ReadonlyArray<Omit<HermesChatEntry, "id">>,
): ReadonlyArray<HermesChatEntry> {
  const stamped = entries.map((entry) => {
    seq += 1;
    return { ...entry, id: `chat-${seq}` } satisfies HermesChatEntry;
  });
  feed.push(...stamped);
  if (feed.length > CHAT_LIMIT) feed.splice(0, feed.length - CHAT_LIMIT);
  if (chatPath && stamped.length > 0) {
    const lines = stamped.map((entry) => {
      const line = JSON.stringify(entry);
      return line.length > MAX_LINE_CHARS
        ? JSON.stringify({
            ...entry,
            summary: clip(entry.summary),
            text: `${entry.text.slice(0, MAX_LINE_CHARS / 2)}…`,
          })
        : line;
    });
    try {
      NodeFS.appendFileSync(chatPath, `${lines.join("\n")}\n`, "utf8");
      trim();
    } catch {
      // Losing a chat write must never break a tick.
    }
  }
  return stamped;
}

function trim(): void {
  if (!chatPath) return;
  try {
    const lines = NodeFS.readFileSync(chatPath, "utf8").split("\n").filter(Boolean);
    if (lines.length <= CHAT_LIMIT) return;
    NodeFS.writeFileSync(chatPath, `${lines.slice(-CHAT_LIMIT).join("\n")}\n`, "utf8");
  } catch {
    // Trimming is housekeeping; a failure must never break a tick.
  }
}
