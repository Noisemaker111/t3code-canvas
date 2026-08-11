/**
 * PNG alpha, without a decoder dependency. Enough of the spec to answer the one
 * question the canvas image tools care about — "is this actually transparent?" —
 * and to cut a flat background out ourselves when the model hands back an
 * opaque picture.
 *
 * Scope: 8-bit, non-interlaced PNG (what `gpt-image-1` returns). Anything else
 * reads as `unknown` and is left untouched rather than mangled.
 *
 * @module canvas/pngAlpha
 */

import * as NodeZlib from "node:zlib";

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export type PngHeader = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
};

export type PngImage = {
  readonly width: number;
  readonly height: number;
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
  readonly pixels: Uint8Array;
};

/** `unknown` means "we could not read it" — never "it is opaque". */
export type PngAlphaState = "transparent" | "opaque" | "unknown";

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

type Chunk = { readonly type: string; readonly data: Uint8Array };

function* chunks(bytes: Uint8Array): Generator<Chunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return;
    yield { type, data: bytes.subarray(start, end) };
    if (type === "IEND") return;
    offset = end + 4;
  }
}

/** IHDR fields, or null when the bytes are not a PNG. */
export function describePng(bytes: Uint8Array): PngHeader | null {
  if (!hasSignature(bytes)) return null;
  for (const chunk of chunks(bytes)) {
    if (chunk.type !== "IHDR") continue;
    if (chunk.data.length < 13) return null;
    const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    return {
      width: view.getUint32(0),
      height: view.getUint32(4),
      bitDepth: chunk.data[8] ?? 0,
      colorType: chunk.data[9] ?? 0,
      interlace: chunk.data[12] ?? 0,
    };
  }
  return null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[line + x] ?? 0;
      const left = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prior + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[prior + x - bpp] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      out[row + x] = restored & 0xff;
    }
  }
  return out;
}

function palette(bytes: Uint8Array): { rgb: Uint8Array; alpha: Uint8Array } | null {
  let rgb: Uint8Array | null = null;
  let alpha: Uint8Array | null = null;
  for (const chunk of chunks(bytes)) {
    if (chunk.type === "PLTE") rgb = chunk.data;
    if (chunk.type === "tRNS") alpha = chunk.data;
  }
  if (!rgb) return null;
  const count = Math.floor(rgb.length / 3);
  const alphas = new Uint8Array(count).fill(255);
  if (alpha) alphas.set(alpha.subarray(0, Math.min(alpha.length, count)));
  return { rgb, alpha: alphas };
}

/** Decode to straight RGBA, or null when the PNG is outside the supported subset. */
export function decodePngRgba(bytes: Uint8Array): PngImage | null {
  const header = describePng(bytes);
  if (!header) return null;
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8 || interlace !== 0 || width <= 0 || height <= 0) return null;
  const channels = CHANNELS[colorType];
  if (channels === undefined) return null;

  const parts: Array<Uint8Array> = [];
  for (const chunk of chunks(bytes)) if (chunk.type === "IDAT") parts.push(chunk.data);
  if (parts.length === 0) return null;

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      NodeZlib.inflateSync(Buffer.concat(parts.map((part) => Buffer.from(part)))),
    );
  } catch {
    return null;
  }
  const flat = unfilter(raw, width, height, channels);
  if (!flat) return null;

  const table = colorType === 3 ? palette(bytes) : null;
  if (colorType === 3 && !table) return null;

  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    switch (colorType) {
      case 0: {
        const grey = flat[source] ?? 0;
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] = 255;
        break;
      }
      case 2: {
        pixels[target] = flat[source] ?? 0;
        pixels[target + 1] = flat[source + 1] ?? 0;
        pixels[target + 2] = flat[source + 2] ?? 0;
        pixels[target + 3] = 255;
        break;
      }
      case 3: {
        const entry = flat[source] ?? 0;
        pixels[target] = table?.rgb[entry * 3] ?? 0;
        pixels[target + 1] = table?.rgb[entry * 3 + 1] ?? 0;
        pixels[target + 2] = table?.rgb[entry * 3 + 2] ?? 0;
        pixels[target + 3] = table?.alpha[entry] ?? 255;
        break;
      }
      case 4: {
        const grey = flat[source] ?? 0;
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] = flat[source + 1] ?? 255;
        break;
      }
      default: {
        pixels[target] = flat[source] ?? 0;
        pixels[target + 1] = flat[source + 1] ?? 0;
        pixels[target + 2] = flat[source + 2] ?? 0;
        pixels[target + 3] = flat[source + 3] ?? 255;
      }
    }
  }
  return { width, height, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

/** Re-encode straight RGBA as a colour-type-6 PNG — the alpha survives by construction. */
export function encodePngRgba(image: PngImage): Uint8Array {
  const { width, height, pixels } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const idat = new Uint8Array(NodeZlib.deflateSync(Buffer.from(raw), { level: 9 }));
  const parts = [
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Does this PNG carry any pixel that is not fully opaque? */
export function pngAlphaState(bytes: Uint8Array): PngAlphaState {
  const header = describePng(bytes);
  if (!header) return "unknown";
  // Greyscale and truecolour without tRNS cannot hold alpha at all.
  if (header.colorType === 0 || header.colorType === 2) {
    for (const part of chunks(bytes)) if (part.type === "tRNS") return "transparent";
    return "opaque";
  }
  const image = decodePngRgba(bytes);
  if (!image) return "unknown";
  for (let index = 3; index < image.pixels.length; index += 4) {
    if ((image.pixels[index] ?? 255) < 255) return "transparent";
  }
  return "opaque";
}

export type CutOutOptions = {
  /** Per-channel colour distance still counted as background. */
  readonly tolerance?: number;
  /** Fraction of the border that must match the key colour before we cut. */
  readonly borderAgreement?: number;
};

const DEFAULT_TOLERANCE = 24;
const DEFAULT_BORDER_AGREEMENT = 0.85;

function distance(pixels: Uint8Array, index: number, key: ReadonlyArray<number>): number {
  const dr = (pixels[index] ?? 0) - (key[0] ?? 0);
  const dg = (pixels[index + 1] ?? 0) - (key[1] ?? 0);
  const db = (pixels[index + 2] ?? 0) - (key[2] ?? 0);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Cut a flat, border-connected background out to alpha 0, with a feathered edge.
 * Returns null when the border is not one flat colour — a wrong cut is worse
 * than no cut, so we decline rather than guess.
 */
export function cutOutFlatBackground(
  bytes: Uint8Array,
  options: CutOutOptions = {},
): Uint8Array | null {
  const image = decodePngRgba(bytes);
  if (!image) return null;
  const { width, height, pixels } = image;
  if (width < 2 || height < 2) return null;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const agreement = options.borderAgreement ?? DEFAULT_BORDER_AGREEMENT;

  const border: Array<number> = [];
  for (let x = 0; x < width; x += 1) {
    border.push(x, (height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    border.push(y * width, y * width + width - 1);
  }

  // Key colour = the most common quantised border colour.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (const pixel of border) {
    const at = pixel * 4;
    const r = pixels[at] ?? 0;
    const g = pixels[at + 1] ?? 0;
    const b = pixels[at + 2] ?? 0;
    const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const seen = buckets.get(bucket) ?? { count: 0, r: 0, g: 0, b: 0 };
    buckets.set(bucket, {
      count: seen.count + 1,
      r: seen.r + r,
      g: seen.g + g,
      b: seen.b + b,
    });
  }
  let best = { count: 0, r: 0, g: 0, b: 0 };
  for (const bucket of buckets.values()) if (bucket.count > best.count) best = bucket;
  if (best.count === 0) return null;
  const key = [best.r / best.count, best.g / best.count, best.b / best.count] as const;

  const matching = border.filter((pixel) => distance(pixels, pixel * 4, key) <= tolerance).length;
  if (matching / border.length < agreement) return null;

  const out = new Uint8Array(pixels);
  const state = new Uint8Array(width * height);
  const stack = border.filter((pixel) => distance(pixels, pixel * 4, key) <= tolerance);
  for (const pixel of stack) state[pixel] = 1;
  while (stack.length > 0) {
    const pixel = stack.pop() ?? 0;
    out[pixel * 4 + 3] = 0;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const neighbours = [
      x > 0 ? pixel - 1 : -1,
      x < width - 1 ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y < height - 1 ? pixel + width : -1,
    ];
    for (const next of neighbours) {
      if (next < 0 || state[next] === 1) continue;
      if (distance(pixels, next * 4, key) > tolerance) continue;
      state[next] = 1;
      stack.push(next);
    }
  }

  // Feather: kept pixels touching a hole fade out across one tolerance band, so
  // the cut has no hard staircase and no halo of leftover background colour.
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (state[pixel] === 1) continue;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const touchesHole =
      (x > 0 && state[pixel - 1] === 1) ||
      (x < width - 1 && state[pixel + 1] === 1) ||
      (y > 0 && state[pixel - width] === 1) ||
      (y < height - 1 && state[pixel + width] === 1);
    if (!touchesHole) continue;
    const over = distance(pixels, pixel * 4, key) - tolerance;
    if (over >= tolerance) continue;
    const alpha = Math.round((over / tolerance) * (out[pixel * 4 + 3] ?? 255));
    out[pixel * 4 + 3] = Math.max(0, Math.min(255, alpha));
  }

  return encodePngRgba({ width, height, pixels: out });
}
