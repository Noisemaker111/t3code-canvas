import { describe, expect, it } from "@effect/vitest";

import {
  parseDataUrl,
  requestBackgroundRemoval,
  requestGeneratedImage,
  toDataUrl,
} from "./imageActions";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("parseDataUrl / toDataUrl", () => {
  it("round-trips the three canvas media types", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/webp"] as const) {
      const payload = { mediaType, data: "aGk=" };
      expect(parseDataUrl(toDataUrl(payload))).toEqual(payload);
    }
  });

  it("rejects non-base64 data URLs, foreign media types, and plain URLs", () => {
    expect(parseDataUrl("data:image/svg+xml;base64,aGk=")).toBeNull();
    expect(parseDataUrl("data:image/png;utf8,hello")).toBeNull();
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
  });
});

describe("requestGeneratedImage", () => {
  it("asks for a transparent background by default and reports what came back", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await requestGeneratedImage("a duck", {}, async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({
        image: { mediaType: "image/png", data: "aGk=", transparency: "transparent" },
      });
    });
    expect(result).toEqual({
      mediaType: "image/png",
      data: "aGk=",
      transparency: "transparent",
    });
    expect(seen[0]?.url).toBe("/api/canvas/image/generate");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      prompt: "a duck",
      background: "transparent",
    });
  });

  it("leaves the background alone when transparency is turned off", async () => {
    const seen: Array<RequestInit | undefined> = [];
    await requestGeneratedImage("a duck", { transparent: false }, async (_url, init) => {
      seen.push(init);
      return jsonResponse({ image: { mediaType: "image/png", data: "aGk=" } });
    });
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ background: "auto" });
  });

  it("reads an unlabelled result as unknown, never as transparent", async () => {
    const result = await requestGeneratedImage("a duck", {}, async () =>
      jsonResponse({ image: { mediaType: "image/png", data: "aGk=" } }),
    );
    expect(result.transparency).toBe("unknown");
  });

  it("surfaces the server's error message instead of a fallback", async () => {
    await expect(
      requestGeneratedImage("a duck", {}, async () =>
        jsonResponse({ error: "OPENAI_API_KEY is not set" }, 409),
      ),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("treats a 200 without an image as an error", async () => {
    await expect(requestGeneratedImage("a duck", {}, async () => jsonResponse({}))).rejects.toThrow(
      /no image/,
    );
  });
});

describe("requestBackgroundRemoval", () => {
  it("posts the source image to the remove-background route", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    await requestBackgroundRemoval({ mediaType: "image/jpeg", data: "aGk=" }, async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ image: { mediaType: "image/png", data: "aGk=" } });
    });
    expect(seen[0]?.url).toBe("/api/canvas/image/remove-background");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      image: { mediaType: "image/jpeg", data: "aGk=" },
    });
  });
});
