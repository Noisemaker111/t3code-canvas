/**
 * Canvas image tools â€” plain HTTPS to the OpenAI Images API (`gpt-image-1`).
 * One request per action, no stream: generate a picture from a prompt, or
 * re-render a canvas image with its background removed.
 *
 * Transparency is the point of both, so it is asked for explicitly, checked in
 * the returned bytes, and repaired locally when the model ignores it.
 *
 * @module canvas/openaiImages
 */

import { cutOutFlatBackground, type PngAlphaState, pngAlphaState } from "./pngAlpha.ts";

const GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const EDITS_URL = "https://api.openai.com/v1/images/edits";
const IMAGE_MODEL = "gpt-image-1";
const REQUEST_TIMEOUT_MS = 180_000;

/** Longer than the model needs, short enough to catch a pasted transcript. */
export const MAX_PROMPT_LENGTH = 2_000;
/** Matches CANVAS_MESSAGE_MAX_IMAGE_BYTES â€” the canvas's own cap on one image. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** `background: transparent` only holds in a format with an alpha channel. */
const TRANSPARENT_OUTPUT_FORMAT = "png";
/** gpt-image-1 drops alpha on `low` quality; transparency needs `high`. */
const TRANSPARENT_QUALITY = "high";

const TRANSPARENT_PROMPT_SUFFIX =
  " Isolate the subject on a fully transparent background: no backdrop, no ground plane, " +
  "no drop shadow, no checkerboard, no white or coloured fill behind the subject. " +
  "Alpha must be 0 everywhere the subject is not.";

const REMOVE_BACKGROUND_PROMPT =
  "Remove the background completely. Keep the subject pixel-identical where possible, " +
  "and output a PNG with a fully transparent background." +
  TRANSPARENT_PROMPT_SUFFIX;

const RETRY_PROMPT_PREFIX =
  "The previous attempt came back with an opaque background, which is wrong. ";

export type CanvasImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type CanvasImageBackground = "transparent" | "opaque" | "auto";

/** Base64 without a data-URL prefix, same wire shape as `CanvasImage`. */
export type CanvasImagePayload = {
  readonly mediaType: CanvasImageMediaType;
  readonly data: string;
  /** What the bytes actually carry â€” `unknown` when we could not read them. */
  readonly transparency?: PngAlphaState;
};

export type OpenAiImageErrorKind = "no-key" | "bad-input" | "upstream" | "bad-response";

export class OpenAiImageError extends Error {
  readonly kind: OpenAiImageErrorKind;

  constructor(input: { kind: OpenAiImageErrorKind; message: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "OpenAiImageError";
    this.kind = input.kind;
  }
}

/** Narrower than `typeof fetch` so a test double is just a function. */
export type ImagesFetch = (url: string, init: RequestInit) => Promise<Response>;

export type OpenAiImagesInput = {
  readonly fetchImpl?: ImagesFetch;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  /** One paid retry when a transparent request comes back opaque. Default on. */
  readonly retryOnOpaque?: boolean;
};

export function isCanvasImageMediaType(value: unknown): value is CanvasImageMediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

export function isCanvasImageBackground(value: unknown): value is CanvasImageBackground {
  return value === "transparent" || value === "opaque" || value === "auto";
}

function resolveKey(env: Record<string, string | undefined>): string {
  // Prefer an explicit Images API key. Codex ChatGPT login is a separate
  // harness auth and does not populate this env â€” operators must set the key
  // (or use Connections secrets merged into the server env) for canvas tools.
  const key = env.OPENAI_API_KEY?.trim() || env.T3CODE_OPENAI_API_KEY?.trim();
  if (!key) {
    throw new OpenAiImageError({
      kind: "no-key",
      message:
        "OPENAI_API_KEY is not set — add it under Settings → Connections or /etc/t3j.env. " +
        "Codex ChatGPT Plus login alone does not enable canvas image generate/remove-background. " +
        "xAI and OpenRouter keys do not serve canvas images.",
    });
  }
  return key;
}

function firstImage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const b64 = (data[0] as { b64_json?: unknown }).b64_json;
  return typeof b64 === "string" && b64.length > 0 ? b64 : null;
}

async function requestImage(
  input: OpenAiImagesInput,
  key: string,
  url: string,
  body: string | FormData,
  headers: Record<string, string>,
): Promise<CanvasImagePayload> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, ...headers },
      body,
    });
  } catch (cause) {
    throw new OpenAiImageError({
      kind: "upstream",
      message: cause instanceof Error ? cause.message : "OpenAI request failed",
      cause,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable body)");
    throw new OpenAiImageError({
      kind: "upstream",
      message: `OpenAI ${response.status}: ${text.slice(0, 300)}`,
    });
  }

  const parsed = (await response.json().catch(() => null)) as unknown;
  const b64 = firstImage(parsed);
  if (!b64) {
    throw new OpenAiImageError({
      kind: "bad-response",
      message: "OpenAI returned no image data",
    });
  }
  // We always ask for output_format=png, so the bytes are a PNG.
  return { mediaType: "image/png", data: b64, transparency: describe(b64) };
}

function describe(b64: string): PngAlphaState {
  try {
    return pngAlphaState(Buffer.from(b64, "base64"));
  } catch {
    return "unknown";
  }
}

/** Model ignored `background: transparent` â†’ cut the flat backdrop out ourselves. */
function repairLocally(payload: CanvasImagePayload): CanvasImagePayload | null {
  let cut: Uint8Array | null = null;
  try {
    cut = cutOutFlatBackground(Buffer.from(payload.data, "base64"));
  } catch {
    return null;
  }
  if (!cut) return null;
  return {
    mediaType: "image/png",
    data: Buffer.from(cut).toString("base64"),
    transparency: "transparent",
  };
}

/**
 * Ask, check the alpha, and only then hand the bytes back: one paid retry with a
 * blunter prompt, then a local cut-out, so a transparent request stays transparent.
 */
async function withTransparency(
  input: OpenAiImagesInput,
  attempt: (retry: boolean) => Promise<CanvasImagePayload>,
): Promise<CanvasImagePayload> {
  const first = await attempt(false);
  if (first.transparency !== "opaque") return first;

  const second = input.retryOnOpaque === false ? first : await attempt(true);
  if (second.transparency !== "opaque") return second;

  return repairLocally(second) ?? second;
}

/** Text prompt â†’ one PNG; `background: "transparent"` is enforced, not hoped for. */
export async function generateCanvasImage(
  input: OpenAiImagesInput,
  ask: { readonly prompt: string; readonly background?: CanvasImageBackground },
): Promise<CanvasImagePayload> {
  const prompt = ask.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw new OpenAiImageError({
      kind: "bad-input",
      message: `prompt must be 1â€“${MAX_PROMPT_LENGTH} characters`,
    });
  }
  const background = ask.background ?? "auto";
  const key = resolveKey(input.env ?? process.env);
  const send = (retry: boolean) =>
    requestImage(
      input,
      key,
      GENERATIONS_URL,
      JSON.stringify({
        model: IMAGE_MODEL,
        prompt:
          background === "transparent"
            ? `${retry ? RETRY_PROMPT_PREFIX : ""}${prompt}${TRANSPARENT_PROMPT_SUFFIX}`
            : prompt,
        n: 1,
        size: "auto",
        background,
        output_format: TRANSPARENT_OUTPUT_FORMAT,
        ...(background === "transparent" ? { quality: TRANSPARENT_QUALITY } : {}),
      }),
      { "Content-Type": "application/json" },
    );

  return background === "transparent" ? withTransparency(input, send) : send(false);
}

/** Existing canvas image â†’ the same subject on a transparent PNG. */
export async function removeCanvasImageBackground(
  input: OpenAiImagesInput,
  ask: { readonly image: CanvasImagePayload },
): Promise<CanvasImagePayload> {
  const bytes = Buffer.from(ask.image.data, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new OpenAiImageError({
      kind: "bad-input",
      message: `image must decode to 1â€“${MAX_IMAGE_BYTES} bytes`,
    });
  }
  const key = resolveKey(input.env ?? process.env);
  const send = (retry: boolean) => {
    const form = new FormData();
    form.append("model", IMAGE_MODEL);
    form.append(
      "prompt",
      retry ? RETRY_PROMPT_PREFIX + REMOVE_BACKGROUND_PROMPT : REMOVE_BACKGROUND_PROMPT,
    );
    form.append("background", "transparent");
    form.append("output_format", TRANSPARENT_OUTPUT_FORMAT);
    form.append("quality", TRANSPARENT_QUALITY);
    form.append("size", "auto");
    form.append(
      "image",
      new Blob([new Uint8Array(bytes)], { type: ask.image.mediaType }),
      `canvas.${ask.image.mediaType.slice("image/".length)}`,
    );
    // No Content-Type header: fetch writes the multipart boundary itself.
    return requestImage(input, key, EDITS_URL, form, {});
  };

  const result = await withTransparency(input, send);
  if (result.transparency === "opaque") {
    throw new OpenAiImageError({
      kind: "bad-response",
      message:
        "the cut-out came back with an opaque background twice, and the backdrop is too busy to cut locally",
    });
  }
  return result;
}
