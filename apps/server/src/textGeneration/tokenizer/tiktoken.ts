/**
 * tiktoken - Minimal, encode-only port of the js-tiktoken BPE encoder.
 *
 * Adapted from js-tiktoken@1.0.21 (MIT, https://github.com/dqbd/tiktoken). The
 * original depends on the `base64-js` package; this port decodes with Node's
 * built-in `Buffer` instead so no npm dependency is required (this deployment
 * cannot add dependencies — see cl100kBaseRanks.ts). Decoding is omitted because
 * we only need token counts.
 *
 * @module tiktoken
 */

export interface TiktokenBPE {
  readonly pat_str: string;
  readonly special_tokens: Record<string, number>;
  readonly bpe_ranks: string;
}

interface BytePart {
  start: number;
  end: number;
}

const MAX_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Port of upstream tiktoken's `_byte_pair_merge` (openai/tiktoken, Rust).
 * Pair ranks are computed once up front and patched only around each merge —
 * the naive js-tiktoken variant re-slices every adjacent pair on every
 * iteration, which goes quadratic-with-allocations on long unbroken words.
 */
function bytePairMerge(piece: Uint8Array, ranks: Map<string, number>): BytePart[] {
  // parts[i].rank is the rank of merging parts[i] with parts[i+1]; the last
  // two entries are sentinels so every real pair has a right neighbor.
  const parts: Array<{ start: number; rank: number }> = [];
  let minRank = MAX_RANK;
  let minIndex = -1;
  for (let index = 0; index < piece.length - 1; index += 1) {
    const rank = ranks.get(`${piece[index]},${piece[index + 1]}`) ?? MAX_RANK;
    if (rank < minRank) {
      minRank = rank;
      minIndex = index;
    }
    parts.push({ start: index, rank });
  }
  parts.push({ start: piece.length - 1, rank: MAX_RANK });
  parts.push({ start: piece.length, rank: MAX_RANK });

  const rankOf = (index: number): number => {
    if (index + 3 >= parts.length) {
      return MAX_RANK;
    }
    const slice = piece.slice(parts[index]!.start, parts[index + 3]!.start);
    return ranks.get(slice.join(",")) ?? MAX_RANK;
  };

  while (minRank !== MAX_RANK) {
    const index = minIndex;
    if (index > 0) {
      parts[index - 1]!.rank = rankOf(index - 1);
    }
    parts[index]!.rank = rankOf(index);
    parts.splice(index + 1, 1);

    minRank = MAX_RANK;
    minIndex = -1;
    for (let scan = 0; scan < parts.length - 1; scan += 1) {
      const rank = parts[scan]!.rank;
      if (rank < minRank) {
        minRank = rank;
        minIndex = scan;
      }
    }
  }

  const merged: BytePart[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    merged.push({ start: parts[index]!.start, end: parts[index + 1]!.start });
  }
  return merged;
}

function bytePairEncode(piece: Uint8Array, ranks: Map<string, number>): number[] {
  if (piece.length === 1) {
    const rank = ranks.get(piece.join(","));
    return rank == null ? [] : [rank];
  }
  return bytePairMerge(piece, ranks)
    .map((part) => ranks.get(piece.slice(part.start, part.end).join(",")))
    .filter((rank): rank is number => rank != null);
}

function escapeRegex(str: string): string {
  return str.replace(/[\\^$*+?.()|[\]{}]/gu, "\\$&");
}

/** Encode-only tiktoken. Construct once and reuse — the constructor is O(vocab). */
export class Tiktoken {
  private readonly specialTokens: Record<string, number>;
  private readonly patStr: string;
  private readonly textEncoder = new TextEncoder();
  private readonly rankMap = new Map<string, number>();

  constructor(ranks: TiktokenBPE) {
    this.patStr = ranks.pat_str;
    const uncompressed = ranks.bpe_ranks
      .split("\n")
      .filter(Boolean)
      .reduce<Record<string, number>>((memo, line) => {
        const [, offsetStr, ...tokens] = line.split(" ");
        const offset = Number.parseInt(offsetStr!, 10);
        tokens.forEach((token, index) => {
          memo[token] = offset + index;
        });
        return memo;
      }, {});

    for (const [token, rank] of Object.entries(uncompressed)) {
      const bytes = Uint8Array.from(Buffer.from(token, "base64"));
      this.rankMap.set(bytes.join(","), rank);
    }

    this.specialTokens = { ...ranks.special_tokens };
  }

  private static specialTokenRegex(tokens: string[]): RegExp {
    return new RegExp(tokens.map((token) => escapeRegex(token)).join("|"), "gu");
  }

  /**
   * Encode `text` to token ids. Special tokens are treated as ordinary text by
   * default (allowedSpecial/disallowedSpecial both empty), so arbitrary tool
   * output never throws.
   */
  encode(text: string, allowedSpecial: string[] = [], disallowedSpecial: string[] = []): number[] {
    const regexes = new RegExp(this.patStr, "ug");
    const specialRegex = Tiktoken.specialTokenRegex(Object.keys(this.specialTokens));
    const ret: number[] = [];

    const allowedSpecialSet = new Set(allowedSpecial);
    const disallowedSpecialSet = new Set(disallowedSpecial);
    if (disallowedSpecialSet.size > 0) {
      const disallowedSpecialRegex = Tiktoken.specialTokenRegex([...disallowedSpecialSet]);
      const specialMatch = text.match(disallowedSpecialRegex);
      if (specialMatch != null) {
        throw new Error(
          `The text contains a special token that is not allowed: ${specialMatch[0]}`,
        );
      }
    }

    let start = 0;
    while (true) {
      let nextSpecial: RegExpExecArray | null = null;
      let startFind = start;
      while (true) {
        specialRegex.lastIndex = startFind;
        nextSpecial = specialRegex.exec(text);
        if (nextSpecial == null || allowedSpecialSet.has(nextSpecial[0])) {
          break;
        }
        startFind = nextSpecial.index + 1;
      }
      const end = nextSpecial?.index ?? text.length;
      for (const match of text.substring(start, end).matchAll(regexes)) {
        const piece = this.textEncoder.encode(match[0]);
        const token = this.rankMap.get(piece.join(","));
        if (token != null) {
          ret.push(token);
          continue;
        }
        ret.push(...bytePairEncode(piece, this.rankMap));
      }
      if (nextSpecial == null) {
        break;
      }
      ret.push(this.specialTokens[nextSpecial[0]]!);
      start = nextSpecial.index + nextSpecial[0].length;
    }

    return ret;
  }
}
