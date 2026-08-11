import { describe, expect, it } from "@effect/vitest";

import {
  generateCanvasImage,
  MAX_IMAGE_BYTES,
  OpenAiImageError,
  removeCanvasImageBackground,
} from "./openaiImages.ts";
import { encodePngRgba } from "./pngAlpha.ts";

const PIXEL = Buffer.from([137, 80, 78, 71]).toString("base64");

function png(width: number, height: number, alphaAt: (x: number, y: number) => number): string {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const inside = x >= 8 && x < width - 8 && y >= 8 && y < height - 8;
      pixels[at] = inside ? 20 : 255;
      pixels[at + 1] = inside ? 30 : 255;
      pixels[at + 2] = inside ? 200 : 255;
      pixels[at + 3] = alphaAt(x, y);
    }
  }
  return Buffer.from(encodePngRgba({ width, height, pixels })).toString("base64");
}

/** A subject on a flat white field — opaque, but cuttable without the model. */
const OPAQUE_CUTTABLE = png(24, 24, () => 255);
const TRANSPARENT = png(24, 24, (x, y) => (x >= 8 && x < 16 && y >= 8 && y < 16 ? 255 : 0));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("generateCanvasImage", () => {
  it("fails without a key, and never calls fetch", async () => {
    let calls = 0;
    await expect(
      generateCanvasImage(
        {
          env: {},
          fetchImpl: async () => {
            calls += 1;
            return jsonResponse({});
          },
        },
        { prompt: "a duck" },
      ),
    ).rejects.toMatchObject({
      kind: "no-key",
      message: expect.stringContaining("OPENAI_API_KEY"),
    });
    expect(calls).toBe(0);
  });

  it("rejects an empty or oversized prompt before spending anything", async () => {
    const input = {
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: async () => jsonResponse({}),
    };
    await expect(generateCanvasImage(input, { prompt: "   " })).rejects.toMatchObject({
      kind: "bad-input",
    });
    await expect(generateCanvasImage(input, { prompt: "x".repeat(2001) })).rejects.toMatchObject({
      kind: "bad-input",
    });
  });

  it("sends the prompt with the bearer key and returns the first PNG", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await generateCanvasImage(
      {
        env: { OPENAI_API_KEY: "test-key" },
        fetchImpl: async (url, init) => {
          seen.push({ url, init });
          return jsonResponse({ data: [{ b64_json: PIXEL }] });
        },
      },
      { prompt: "a duck" },
    );
    expect(result).toEqual({
      mediaType: "image/png",
      data: PIXEL,
      transparency: "unknown",
    });
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.url).toBe("https://api.openai.com/v1/images/generations");
    expect((call?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      model: "gpt-image-1",
      prompt: "a duck",
      background: "auto",
      output_format: "png",
    });
  });

  it("asks for transparency in the format and quality that can carry it", async () => {
    const seen: Array<RequestInit> = [];
    await generateCanvasImage(
      {
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: async (_url, init) => {
          seen.push(init);
          return jsonResponse({ data: [{ b64_json: TRANSPARENT }] });
        },
      },
      { prompt: "a duck", background: "transparent" },
    );
    expect(seen).toHaveLength(1);
    const body = JSON.parse(String(seen[0]?.body));
    expect(body).toMatchObject({
      background: "transparent",
      output_format: "png",
      quality: "high",
    });
    expect(String(body.prompt)).toContain("fully transparent background");
  });

  it("retries once when a transparent request comes back opaque", async () => {
    let calls = 0;
    const result = await generateCanvasImage(
      {
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({
            data: [{ b64_json: calls === 1 ? OPAQUE_CUTTABLE : TRANSPARENT }],
          });
        },
      },
      { prompt: "a duck", background: "transparent" },
    );
    expect(calls).toBe(2);
    expect(result.transparency).toBe("transparent");
    expect(result.data).toBe(TRANSPARENT);
  });

  it("cuts the background out locally when both attempts come back opaque", async () => {
    const result = await generateCanvasImage(
      {
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: async () => jsonResponse({ data: [{ b64_json: OPAQUE_CUTTABLE }] }),
      },
      { prompt: "a duck", background: "transparent" },
    );
    expect(result.transparency).toBe("transparent");
    expect(result.data).not.toBe(OPAQUE_CUTTABLE);
  });

  it("does not spend a retry when the caller did not ask for transparency", async () => {
    let calls = 0;
    await generateCanvasImage(
      {
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({ data: [{ b64_json: OPAQUE_CUTTABLE }] });
        },
      },
      { prompt: "a duck", background: "opaque" },
    );
    expect(calls).toBe(1);
  });

  it("surfaces upstream failures with status and body, not a fallback image", async () => {
    await expect(
      generateCanvasImage(
        {
          env: { OPENAI_API_KEY: "k" },
          fetchImpl: async () => new Response("insufficient quota", { status: 429 }),
        },
        { prompt: "a duck" },
      ),
    ).rejects.toMatchObject({
      kind: "upstream",
      message: expect.stringContaining("429"),
    });
  });

  it("treats a 200 with no image data as an error", async () => {
    await expect(
      generateCanvasImage(
        {
          env: { OPENAI_API_KEY: "k" },
          fetchImpl: async () => jsonResponse({ data: [] }),
        },
        { prompt: "a duck" },
      ),
    ).rejects.toBeInstanceOf(OpenAiImageError);
  });
});

describe("removeCanvasImageBackground", () => {
  it("posts multipart to the edits endpoint and returns the PNG", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await removeCanvasImageBackground(
      {
        env: { OPENAI_API_KEY: "test-key" },
        fetchImpl: async (url, init) => {
          seen.push({ url, init });
          return jsonResponse({ data: [{ b64_json: TRANSPARENT }] });
        },
      },
      { image: { mediaType: "image/jpeg", data: PIXEL } },
    );
    expect(result).toEqual({
      mediaType: "image/png",
      data: TRANSPARENT,
      transparency: "transparent",
    });
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/images/edits");
    const form = seen[0]?.init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("output_format")).toBe("png");
    expect(form.get("quality")).toBe("high");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("cuts the background out locally rather than returning an opaque cut-out", async () => {
    const result = await removeCanvasImageBackground(
      {
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: async () => jsonResponse({ data: [{ b64_json: OPAQUE_CUTTABLE }] }),
      },
      { image: { mediaType: "image/png", data: OPAQUE_CUTTABLE } },
    );
    expect(result.transparency).toBe("transparent");
  });

  it("fails loudly when the result stays opaque and cannot be cut", async () => {
    const noisy = Buffer.from(
      encodePngRgba({
        width: 24,
        height: 24,
        pixels: Uint8Array.from({ length: 24 * 24 * 4 }, (_value, index) =>
          index % 4 === 3 ? 255 : (index * 37) % 256,
        ),
      }),
    ).toString("base64");
    await expect(
      removeCanvasImageBackground(
        {
          env: { OPENAI_API_KEY: "k" },
          fetchImpl: async () => jsonResponse({ data: [{ b64_json: noisy }] }),
        },
        { image: { mediaType: "image/png", data: noisy } },
      ),
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("rejects an empty or oversized image before spending anything", async () => {
    const input = {
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: async () => jsonResponse({}),
    };
    await expect(
      removeCanvasImageBackground(input, {
        image: { mediaType: "image/png", data: "" },
      }),
    ).rejects.toMatchObject({ kind: "bad-input" });
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
    await expect(
      removeCanvasImageBackground(input, {
        image: { mediaType: "image/png", data: oversized },
      }),
    ).rejects.toMatchObject({ kind: "bad-input" });
  });
});
