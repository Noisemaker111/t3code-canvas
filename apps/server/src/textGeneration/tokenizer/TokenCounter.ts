/**
 * TokenCounter - Real BPE token counting for tool call input/output.
 *
 * The model harnesses report token usage per turn, but never per individual
 * tool call. To show and log a token readout for a tool call — e.g. a bash
 * command plus its output — we count locally with a genuine cl100k_base BPE
 * tokenizer (a close proxy for modern model token counts). This runs once on
 * the server at ingestion time, so it never touches the agent or the UI thread.
 *
 * The encoder is initialized lazily on first use and reused thereafter.
 *
 * @module TokenCounter
 */
import cl100kBaseRanks from "./cl100kBaseRanks.ts";
import { Tiktoken } from "./tiktoken.ts";

// Bound the work on pathological inputs (huge command output). Counting is
// linear, so this caps per-call cost; the tail of very large output is ignored.
const MAX_TOKENIZED_CHARS = 200_000;

// The BPE merge's min-scan is quadratic per pre-tokenizer word, so one
// unbroken multi-kilobyte "word" (e.g. 200k repeated characters) would still
// crawl. Encode in bounded chunks, split at whitespace when one is nearby; a
// chunk boundary costs at most one token of accuracy and real words never hit
// the bound.
const MAX_ENCODE_CHUNK_CHARS = 5_000;
const CHUNK_WHITESPACE_LOOKBACK = 200;

function* boundedChunks(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_ENCODE_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const lookbackFloor = Math.max(start + 1, end - CHUNK_WHITESPACE_LOOKBACK);
      for (let cursor = end - 1; cursor >= lookbackFloor; cursor -= 1) {
        if (/\s/.test(text[cursor]!)) {
          end = cursor + 1;
          break;
        }
      }
    }
    yield text.slice(start, end);
    start = end;
  }
}

let encoder: Tiktoken | null = null;
let initFailed = false;

function getEncoder(): Tiktoken | null {
  if (encoder != null) {
    return encoder;
  }
  if (initFailed) {
    return null;
  }
  try {
    encoder = new Tiktoken(cl100kBaseRanks);
    return encoder;
  } catch {
    initFailed = true;
    return null;
  }
}

/**
 * Count the tokens in `text`. Returns 0 for empty input. Never throws — on any
 * failure it falls back to a coarse character-based estimate so callers can
 * treat the result as best-effort.
 */
export function countTokens(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  const bounded = text.length > MAX_TOKENIZED_CHARS ? text.slice(0, MAX_TOKENIZED_CHARS) : text;
  const enc = getEncoder();
  if (enc == null) {
    return Math.ceil(bounded.length / 4);
  }
  try {
    let total = 0;
    for (const chunk of boundedChunks(bounded)) {
      total += enc.encode(chunk).length;
    }
    return total;
  } catch {
    return Math.ceil(bounded.length / 4);
  }
}
