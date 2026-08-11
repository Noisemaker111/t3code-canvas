/**
 * Hermes tier 3 — plain HTTPS to OpenRouter. One request, no stream.
 *
 * @module kanban/hermes/openrouterBackend
 */
import type { HermesTokenUsage } from "@t3tools/contracts";

import { resolveProviderKey } from "../../usage/UsageService.ts";
import {
  HERMES_MODEL,
  HermesBackendError,
  type HermesBackend,
  type HermesCompletion,
  type HermesMessage,
  type HermesTierAvailability,
} from "./backend.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 120_000;
const KEY_CHECK_TIMEOUT_MS = 10_000;
/** How long a definitive key verdict (valid / rejected) is trusted. */
const KEY_CHECK_TTL_MS = 5 * 60_000;

/** Narrower than `typeof fetch` so a test double is just a function. */
export type HermesFetch = (url: string, init: RequestInit) => Promise<Response>;

export type OpenRouterBackendInput = {
  readonly fetchImpl?: HermesFetch;
  readonly resolveKey?: () => Promise<string | undefined>;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly keyCheckTtlMs?: number;
  readonly nowMs?: () => number;
};

function messageText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    return joined.length > 0 ? joined : null;
  }
  return null;
}

const numberAt = (source: unknown, key: string): number | null => {
  if (source === null || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const stringAt = (source: unknown, key: string): string | null => {
  if (source === null || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * What the generation actually cost, straight from the response. `cost` arrives
 * only because the request asks for `usage.include`; without it OpenRouter
 * returns token counts and no dollars.
 */
export function readUsage(payload: unknown): HermesTokenUsage | null {
  if (payload === null || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const inputTokens = numberAt(usage, "prompt_tokens");
  const outputTokens = numberAt(usage, "completion_tokens");
  if (inputTokens === null && outputTokens === null) return null;
  const cached = numberAt(
    (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details,
    "cached_tokens",
  );
  const reasoning = numberAt(
    (usage as { completion_tokens_details?: unknown }).completion_tokens_details,
    "reasoning_tokens",
  );
  const usd = numberAt(usage, "cost");
  const generationId = stringAt(payload, "id");
  const provider = stringAt(payload, "provider");
  return {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cached ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
    ...(usd === null ? {} : { usd }),
    ...(generationId === null ? {} : { generationId }),
    ...(provider === null ? {} : { provider }),
  };
}

/**
 * A turn with pictures becomes a content-part array; a plain one stays a string.
 * Sending parts unconditionally would work but changes every request's shape for
 * the one tick in a hundred that carries a screenshot.
 */
function toApiMessage(message: HermesMessage): {
  role: HermesMessage["role"];
  content: unknown;
} {
  if (!message.images || message.images.length === 0) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.data}` },
      })),
    ],
  };
}

export function makeOpenRouterHermesBackend(input: OpenRouterBackendInput = {}): HermesBackend {
  const model = input.model ?? HERMES_MODEL;
  const resolveKey = input.resolveKey ?? (() => resolveProviderKey("openrouter"));
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const keyCheckTtlMs = input.keyCheckTtlMs ?? KEY_CHECK_TTL_MS;
  const nowMs = input.nowMs ?? (() => Date.now());

  // "Key resolved" used to be the whole probe, so a revoked key read as a green
  // tier until a real tick paid to discover the 401. Ask OpenRouter's key
  // endpoint instead; only definitive verdicts are cached, so a transient
  // network failure never disables the tier or hides a later revocation.
  let keyVerdict: {
    readonly key: string;
    readonly atMs: number;
    readonly detail: string;
    readonly available: boolean;
  } | null = null;

  const available = async (): Promise<HermesTierAvailability> => {
    const key = await resolveKey().catch(() => undefined);
    if (!key) return { tier: "openrouter", available: false, detail: "no key" };
    if (keyVerdict && keyVerdict.key === key && nowMs() - keyVerdict.atMs < keyCheckTtlMs) {
      return { tier: "openrouter", available: keyVerdict.available, detail: keyVerdict.detail };
    }
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KEY_CHECK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(OPENROUTER_KEY_URL, {
        method: "GET",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.ok) {
        keyVerdict = { key, atMs: nowMs(), available: true, detail: "key valid (verified)" };
        return { tier: "openrouter", available: true, detail: keyVerdict.detail };
      }
      if (response.status === 401 || response.status === 403) {
        keyVerdict = {
          key,
          atMs: nowMs(),
          available: false,
          detail: `key rejected (HTTP ${response.status}) — replace it in Settings → Connections → API keys`,
        };
        return { tier: "openrouter", available: false, detail: keyVerdict.detail };
      }
      return {
        tier: "openrouter",
        available: true,
        detail: `key resolved (validity unchecked: HTTP ${response.status})`,
      };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return {
        tier: "openrouter",
        available: true,
        detail: `key resolved (validity unchecked: ${reason})`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const request = async (ask: {
    messages: ReadonlyArray<HermesMessage>;
    model?: string | undefined;
  }): Promise<HermesCompletion> => {
    const { messages, model: requested } = ask;
    const key = await resolveKey().catch(() => undefined);
    if (!key) {
      throw new HermesBackendError({
        tier: "openrouter",
        kind: "unavailable",
        message: "no OpenRouter key",
      });
    }
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(OPENROUTER_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://code.noisemakerjon.com",
          "X-Title": "T3J Hermes board brain",
        },
        body: JSON.stringify({
          model: (requested ?? "").trim() || model,
          messages: messages.map(toApiMessage),
          stream: false,
          // Without this the response carries token counts and no `cost`, and
          // the tick log can only guess what the brain spent.
          usage: { include: true },
        }),
      });
    } catch (cause) {
      throw new HermesBackendError({
        tier: "openrouter",
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : "OpenRouter request failed",
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HermesBackendError({
        tier: "openrouter",
        // 4xx that is not a rate limit means our request was wrong, not the
        // tier being down — but there is no next tier that would do better,
        // so both still end the chain here.
        kind: "unavailable",
        message: `OpenRouter ${response.status}: ${body.slice(0, 200)}`,
      });
    }

    const parsed = (await response.json().catch(() => null)) as unknown;
    const text = messageText(parsed);
    if (!text || !text.trim()) {
      throw new HermesBackendError({
        tier: "openrouter",
        kind: "bad-response",
        message: "OpenRouter returned no message content",
      });
    }
    const usage = readUsage(parsed);
    return { text, ...(usage ? { usage } : {}) };
  };

  const complete: HermesBackend["complete"] = ({ system, user, model: requested }) =>
    request({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      model: requested,
    });

  return {
    tier: "openrouter",
    modelPrefix: "openrouter/",
    available,
    complete,
    completeConversation: request,
  };
}
