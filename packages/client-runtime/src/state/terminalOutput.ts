/**
 * Where a terminal's output goes: a plain per-session mailbox, outside the
 * reactive state that everything else in the app rides on.
 *
 * Output is a byte stream, not state. Routing every chunk through the atom that
 * also holds the session's status re-rendered the whole terminal surface — and
 * the React tree under it — for each one, and handed the viewport a fresh
 * half-megabyte string to diff against the last one just to recover the bytes
 * that had already arrived. Nothing derives anything from a chunk: exactly one
 * emulator writes it. So the stream drops chunks here and the surface takes
 * them ({@link subscribeTerminalOutput}), with the retained buffer kept for the
 * one thing it is actually for — replaying scrollback into a surface that
 * mounts late ({@link retainedTerminalOutput}).
 *
 * @module state/terminalOutput
 */

export interface TerminalOutputRef {
  readonly threadId: string;
  readonly terminalId: string;
}

export function terminalOutputKey(ref: TerminalOutputRef): string {
  return `${ref.threadId} ${ref.terminalId}`;
}

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;

/**
 * When the retained buffer overflows the cap we trim it back down to this
 * fraction rather than to the exact cap. Dropping a chunk at a time (instead of
 * trimming on every subsequent chunk) keeps the vast majority of output events
 * a pure append: no re-encode, and no re-trim.
 */
const TRIM_RETAIN_RATIO = 0.9;
const LINE_FEED = 0x0a;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Retained {
  buffer: string;
  bytes: number;
}

/**
 * A chunk to append, or `null` for "the retained buffer was replaced, re-read
 * it" — attach, restart and clear, which a surface must not treat as an append.
 */
type OutputListener = (chunk: string | null) => void;

const retained = new Map<string, Retained>();
const listeners = new Map<string, Set<OutputListener>>();

/**
 * Keep the most recent `retainBytes` bytes of a UTF-8 buffer, advancing the cut
 * forward to the next line so a trim never leaves a partial character or a
 * partial escape sequence behind.
 *
 * The line boundary is what makes the retained head replayable. A cut landing
 * inside `ESC [ 3 8 ; 5 ; 1 2 m` leaves `8;5;12m` to be printed as text, and a
 * cut inside an OSC or DCS string leaves a parser that swallows real output
 * until it finds a terminator — both of which show up as garbled scrollback,
 * because a surface that mounts later replays this buffer from the front. No
 * escape sequence contains a line feed, so cutting at one cannot land inside a
 * sequence.
 */
export function trimTerminalBuffer(buffer: string, retainBytes: number): Retained {
  if (retainBytes <= 0) return { buffer: "", bytes: 0 };

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= retainBytes) return { buffer, bytes: encoded.byteLength };

  const cut = encoded.byteLength - retainBytes;
  const nextLine = encoded.indexOf(LINE_FEED, cut);
  // A buffer with no line feed left to cut at (one enormous line) keeps the
  // code-point boundary it had: dropping to empty would lose more than it fixes.
  let start = nextLine === -1 ? cut : nextLine + 1;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    start += 1;
  }

  const kept = encoded.subarray(start);
  return { buffer: textDecoder.decode(kept), bytes: kept.byteLength };
}

function retain(key: string): Retained {
  const current = retained.get(key);
  if (current !== undefined) return current;
  const fresh: Retained = { buffer: "", bytes: 0 };
  retained.set(key, fresh);
  return fresh;
}

/** Append a chunk to the retained scrollback and hand it to every surface. */
export function publishTerminalOutput(
  key: string,
  chunk: string,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): void {
  if (chunk.length === 0) return;
  const current = retain(key);
  const combinedBytes = current.bytes + textEncoder.encode(chunk).byteLength;
  const combined = `${current.buffer}${chunk}`;
  if (combinedBytes <= maxBufferBytes) {
    current.buffer = combined;
    current.bytes = combinedBytes;
  } else {
    const trimmed = trimTerminalBuffer(
      combined,
      Math.max(1, Math.floor(maxBufferBytes * TRIM_RETAIN_RATIO)),
    );
    current.buffer = trimmed.buffer;
    current.bytes = trimmed.bytes;
  }

  const subscribers = listeners.get(key);
  if (subscribers === undefined) return;
  for (const listener of subscribers) listener(chunk);
}

/**
 * Replace the retained scrollback outright — a snapshot on attach, a restart, a
 * clear. Surfaces are told to re-read rather than handed the replacement as a
 * chunk: appending it would duplicate the scrollback they already show.
 */
export function resetTerminalOutput(
  key: string,
  buffer: string,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): void {
  const trimmed = trimTerminalBuffer(buffer, maxBufferBytes);
  retained.set(key, { buffer: trimmed.buffer, bytes: trimmed.bytes });
  const subscribers = listeners.get(key);
  if (subscribers === undefined) return;
  for (const listener of subscribers) listener(null);
}

/** The scrollback so far, so a surface that mounts late shows history. */
export function retainedTerminalOutput(key: string): string {
  return retained.get(key)?.buffer ?? "";
}

export function subscribeTerminalOutput(key: string, listener: OutputListener): () => void {
  const subscribers = listeners.get(key) ?? new Set<OutputListener>();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size > 0) return;
    listeners.delete(key);
  };
}

/**
 * Drop a closed session's scrollback. The attach stream calls this when the
 * subscription ends; a retained half-megabyte per terminal would otherwise sit
 * there for the life of the page.
 */
export function forgetTerminalOutput(key: string): void {
  retained.delete(key);
}
