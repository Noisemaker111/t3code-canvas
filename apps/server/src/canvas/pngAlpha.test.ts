import { describe, expect, it } from "@effect/vitest";

import {
  cutOutFlatBackground,
  decodePngRgba,
  describePng,
  encodePngRgba,
  pngAlphaState,
} from "./pngAlpha.ts";

type Paint = (x: number, y: number) => readonly [number, number, number, number];

function png(width: number, height: number, paint: Paint): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const at = (y * width + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = a;
    }
  }
  return encodePngRgba({ width, height, pixels });
}

/** White field, dark square in the middle — the shape every cut-out has to keep. */
const subjectOnWhite = (size = 24) =>
  png(size, size, (x, y) => {
    const inside = x >= 8 && x < size - 8 && y >= 8 && y < size - 8;
    return inside ? [20, 30, 200, 255] : [255, 255, 255, 255];
  });

function alphaAt(bytes: Uint8Array, x: number, y: number): number {
  const image = decodePngRgba(bytes);
  if (!image) throw new Error("not decodable");
  return image.pixels[(y * image.width + x) * 4 + 3] ?? 255;
}

describe("describePng", () => {
  it("reads IHDR, and rejects anything that is not a PNG", () => {
    expect(describePng(png(3, 2, () => [0, 0, 0, 255]))).toMatchObject({
      width: 3,
      height: 2,
      bitDepth: 8,
      colorType: 6,
      interlace: 0,
    });
    expect(describePng(Uint8Array.from([137, 80, 78, 71]))).toBeNull();
    expect(describePng(Buffer.from("not an image"))).toBeNull();
  });
});

describe("encodePngRgba / decodePngRgba", () => {
  it("round-trips pixels, alpha included", () => {
    const bytes = png(4, 3, (x, y) => [x * 10, y * 20, 7, x === y ? 0 : 128]);
    const decoded = decodePngRgba(bytes);
    expect(decoded).toMatchObject({ width: 4, height: 3 });
    expect(decoded?.pixels.slice(0, 4)).toEqual(Uint8Array.from([0, 0, 7, 0]));
    expect(decoded?.pixels.slice(4, 8)).toEqual(Uint8Array.from([10, 0, 7, 128]));
  });
});

describe("pngAlphaState", () => {
  it("tells a transparent PNG from an opaque one", () => {
    expect(pngAlphaState(png(2, 2, () => [1, 2, 3, 255]))).toBe("opaque");
    expect(pngAlphaState(png(2, 2, (x) => [1, 2, 3, x === 0 ? 0 : 255]))).toBe("transparent");
  });

  it("says unknown — never opaque — when the bytes are unreadable", () => {
    expect(pngAlphaState(Uint8Array.from([137, 80, 78, 71]))).toBe("unknown");
    expect(pngAlphaState(Buffer.from("nope"))).toBe("unknown");
  });
});

describe("cutOutFlatBackground", () => {
  it("cuts a flat border-connected background out and keeps the subject", () => {
    const cut = cutOutFlatBackground(subjectOnWhite());
    expect(cut).not.toBeNull();
    if (!cut) return;
    expect(pngAlphaState(cut)).toBe("transparent");
    expect(alphaAt(cut, 0, 0)).toBe(0);
    expect(alphaAt(cut, 12, 12)).toBe(255);
  });

  it("leaves colour holes that the background does not reach", () => {
    // A white pocket inside the subject is not border-connected, so it stays.
    const bytes = png(24, 24, (x, y) => {
      if (x >= 6 && x < 18 && y >= 6 && y < 18) {
        const pocket = x >= 10 && x < 14 && y >= 10 && y < 14;
        return pocket ? [255, 255, 255, 255] : [20, 30, 200, 255];
      }
      return [255, 255, 255, 255];
    });
    const cut = cutOutFlatBackground(bytes);
    expect(cut).not.toBeNull();
    if (!cut) return;
    expect(alphaAt(cut, 11, 11)).toBe(255);
    expect(alphaAt(cut, 1, 1)).toBe(0);
  });

  it("declines rather than guessing when the border is not one flat colour", () => {
    const noisy = png(24, 24, (x, y) => [(x * 37) % 256, (y * 53) % 256, (x * y) % 256, 255]);
    expect(cutOutFlatBackground(noisy)).toBeNull();
  });

  it("declines on bytes it cannot decode", () => {
    expect(cutOutFlatBackground(Buffer.from("nope"))).toBeNull();
  });
});
