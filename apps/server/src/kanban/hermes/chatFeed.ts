/**
 * A tick, rendered as chat. Pure: the store decides where it lands.
 *
 * Two lines per tick, because that is what a tick is — the board block Hermes
 * was sent, and what it did with it. Everything a reader needs first goes in
 * `summary`; the verbatim turn stays in `text` for when the summary is not
 * enough.
 *
 * @module kanban/hermes/chatFeed
 */
import type { HermesChatEntry } from "@t3tools/contracts";

import { BOARD_WRITE_METHODS, boardCallFailure, type BoardCallRecord } from "./boardApi.ts";

/** A board block can be tens of KB. The panel shows a turn, not a database. */
const MAX_TEXT_CHARS = 6_000;
const MAX_PROGRAM_CHARS = 6_000;

type ChatDraft = Omit<HermesChatEntry, "id">;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `## TITLE` … as a lookup. Both the snapshot and the delta are built this way. */
function sections(block: string): Map<string, ReadonlyArray<string>> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("## ")) {
      current = [];
      found.set(line.slice(3).trim(), current);
      continue;
    }
    current?.push(line);
  }
  return found;
}

function bullets(lines: ReadonlyArray<string> | undefined): number {
  return (lines ?? []).filter((line) => line.startsWith("- ")).length;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What this turn told Hermes, in one line. */
export function describeBoardTurn(block: string): string {
  const found = sections(block);
  const parts: string[] = [];
  const changes = found.get("BOARD CHANGES (since your last turn)");
  if (changes === undefined) parts.push("full board snapshot");
  else if (bullets(changes) > 0) parts.push(plural(bullets(changes), "board change"));

  const decisions = bullets(found.get("NEEDS A DECISION"));
  if (decisions > 0) parts.push(plural(decisions, "decision"));
  const reports = bullets(found.get("AGENT REPORTS"));
  if (reports > 0) parts.push(plural(reports, "agent report"));
  const messages = bullets(found.get("CANVAS MESSAGES"));
  if (messages > 0) parts.push(plural(messages, "message"));
  const questions = bullets(found.get("PENDING QUESTIONS"));
  if (questions > 0) parts.push(plural(questions, "pending question"));
  const failures = bullets(found.get("BOARD FAILURES"));
  if (failures > 0) parts.push(plural(failures, "failing call"));

  return parts.length === 0 ? "nothing changed" : parts.join(" · ");
}

function callLine(call: BoardCallRecord): string {
  const args = call.args === undefined ? "" : ` ${JSON.stringify(call.args).slice(0, 200)}`;
  if (call.refused === true) return `- ${call.method}${args} → refused`;
  if (call.skipped === true) return `- ${call.method}${args} → skipped`;
  const failure = boardCallFailure(call);
  return `- ${call.method}${args} → ${failure === null ? "ok" : `failed: ${failure.slice(0, 300)}`}`;
}

/** What Hermes did, in one line: its own note when it wrote one, else the count. */
export function describeHermesTurn(input: {
  readonly note: string | null;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly error: string | null;
}): string {
  if (input.error !== null) return `failed: ${input.error.slice(0, 200)}`;
  const note = input.note?.trim();
  if (note) return note.slice(0, 240);
  const landed = input.calls.filter(
    (call) =>
      BOARD_WRITE_METHODS.has(call.method) &&
      boardCallFailure(call) === null &&
      call.skipped !== true,
  ).length;
  const failed = input.calls.filter((call) => boardCallFailure(call) !== null).length;
  if (landed === 0 && failed === 0) return "read the board, changed nothing";
  return [
    plural(landed, "action"),
    ...(failed > 0 ? [`${plural(failed, "call")} failed`] : []),
  ].join(" · ");
}

/**
 * One tick as chat lines. A tick that neither read a board block nor ran a call
 * has nothing to say, and says nothing — an idle loop must not fill the panel.
 */
export function hermesChatTurns(input: {
  readonly at: string;
  readonly tickId: string;
  readonly tier: string | null;
  /** The board block sent this tick; null when no model was asked. */
  readonly delta: string | null;
  /** The model's own `note()`, when it left one. */
  readonly note: string | null;
  /** Answers the program wrote with `reply()`, in full. */
  readonly replies?: ReadonlyArray<string>;
  readonly program: string | null;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly logs: ReadonlyArray<string>;
  readonly error: string | null;
}): ReadonlyArray<ChatDraft> {
  const entries: ChatDraft[] = [];
  const replies = (input.replies ?? [])
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (input.delta !== null) {
    entries.push({
      at: input.at,
      kind: "board",
      summary: describeBoardTurn(input.delta),
      text: clip(input.delta, MAX_TEXT_CHARS),
      tickId: input.tickId,
    });
  }

  const ran = input.calls.filter((call) => call.skipped !== true);
  if (input.delta === null && ran.length === 0 && input.error === null && replies.length === 0) {
    return entries;
  }

  const body = [
    ...(ran.length === 0 ? ["(no board calls)"] : ran.map(callLine)),
    ...(input.logs.length === 0 ? [] : ["", ...input.logs.map((line) => `note: ${line}`)]),
  ].join("\n");
  entries.push({
    at: input.at,
    kind: "hermes",
    summary: describeHermesTurn({ note: input.note, calls: input.calls, error: input.error }),
    text: clip(body, MAX_TEXT_CHARS),
    tickId: input.tickId,
    ...(input.program === null ? {} : { program: clip(input.program, MAX_PROGRAM_CHARS) }),
    ...(input.tier === null ? {} : { tier: input.tier }),
    ...(input.error === null ? {} : { error: input.error.slice(0, 600) }),
  });
  // An answer is the line a reader came for, so it is the summary and it is not
  // clipped — the 240-char note clip is what made Hermes unreadable in the panel.
  for (const reply of replies) {
    entries.push({
      at: input.at,
      kind: "reply",
      summary: reply,
      text: "",
      tickId: input.tickId,
    });
  }
  return entries;
}

/**
 * A tick the rules settled on their own. It is worth a line only when it moved
 * something — "Hermes had nothing to do" is what the header already says.
 */
export function hermesRuleChatTurn(input: {
  readonly at: string;
  readonly tickId: string;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly logs: ReadonlyArray<string>;
  readonly actions: number;
}): ReadonlyArray<ChatDraft> {
  if (input.actions === 0 && input.logs.length === 0) return [];
  const ran = input.calls.filter((call) => call.skipped !== true);
  return [
    {
      at: input.at,
      kind: "note",
      summary: `${plural(input.actions, "rule action")} · no model needed`,
      text: clip(
        [
          ...ran.map(callLine),
          ...(ran.length > 0 && input.logs.length > 0 ? [""] : []),
          ...input.logs,
        ].join("\n"),
        MAX_TEXT_CHARS,
      ),
      tickId: input.tickId,
    },
  ];
}
