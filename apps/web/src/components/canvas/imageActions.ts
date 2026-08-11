/**
 * Canvas image tools — the browser half of `/api/canvas/image/*`.
 * Pure payload plumbing lives here so it can be tested without an editor.
 *
 * @module components/canvas/imageActions
 */

export type CanvasImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/** What the returned bytes carry — `unknown` when the server could not read them. */
export type CanvasImageTransparency = "transparent" | "opaque" | "unknown";

/** Base64 without a data-URL prefix, same wire shape as the server. */
export type CanvasImagePayload = {
  readonly mediaType: CanvasImageMediaType;
  readonly data: string;
  readonly transparency?: CanvasImageTransparency;
};

export type ImageActionFetch = (url: string, init?: RequestInit) => Promise<Response>;

function isMediaType(value: string): value is CanvasImageMediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

export function parseDataUrl(src: string): CanvasImagePayload | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(src);
  if (!match) return null;
  const mediaType = match[1] ?? "";
  const data = match[2] ?? "";
  return isMediaType(mediaType) && data.length > 0 ? { mediaType, data } : null;
}

export function toDataUrl(payload: CanvasImagePayload): string {
  return `data:${payload.mediaType};base64,${payload.data}`;
}

async function requestImage(
  url: string,
  body: unknown,
  fetchImpl: ImageActionFetch,
): Promise<CanvasImagePayload> {
  const response = await fetchImpl(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => null);
  const record =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const image =
    record.image !== null && typeof record.image === "object"
      ? (record.image as Record<string, unknown>)
      : {};
  const mediaType = typeof image.mediaType === "string" ? image.mediaType : "";
  const data = typeof image.data === "string" ? image.data : "";
  if (!isMediaType(mediaType) || data.length === 0) {
    throw new Error("server returned no image");
  }
  return { mediaType, data, transparency: asTransparency(image.transparency) };
}

function asTransparency(value: unknown): CanvasImageTransparency {
  return value === "transparent" || value === "opaque" ? value : "unknown";
}

export function requestGeneratedImage(
  prompt: string,
  options: { readonly transparent?: boolean } = {},
  fetchImpl: ImageActionFetch = fetch,
): Promise<CanvasImagePayload> {
  return requestImage(
    "/api/canvas/image/generate",
    { prompt, background: options.transparent === false ? "auto" : "transparent" },
    fetchImpl,
  );
}

export function requestBackgroundRemoval(
  image: CanvasImagePayload,
  fetchImpl: ImageActionFetch = fetch,
): Promise<CanvasImagePayload> {
  return requestImage("/api/canvas/image/remove-background", { image }, fetchImpl);
}
