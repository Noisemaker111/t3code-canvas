import { describe, expect, it } from "@effect/vitest";

import { HermesBackendError } from "./backend.ts";
import { makeOpenRouterHermesBackend } from "./openrouterBackend.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("makeOpenRouterHermesBackend", () => {
  it("reports unavailable with no key, and never calls fetch", async () => {
    let calls = 0;
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });

    expect(await backend.available()).toMatchObject({ available: false, detail: "no key" });
    await expect(backend.complete({ system: "s", user: "u" })).rejects.toThrow(/no OpenRouter key/);
    expect(calls).toBe(0);
  });

  it("verifies the key against the key endpoint instead of trusting its presence", async () => {
    const urls: string[] = [];
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async (url, init) => {
        urls.push(url);
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
        return jsonResponse({ data: { label: "t3j" } });
      },
    });

    const availability = await backend.available();
    expect(availability).toMatchObject({ available: true, detail: "key valid (verified)" });
    expect(urls).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  it("reports a revoked key as unavailable with the action to take", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "revoked-key",
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });

    const availability = await backend.available();
    expect(availability.available).toBe(false);
    expect(availability.detail).toContain("key rejected (HTTP 401)");
    expect(availability.detail).toContain("Settings → Connections → API keys");
  });

  it("keeps the tier available when the key check itself cannot run", async () => {
    const failing = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(await failing.available()).toMatchObject({ available: true });
    expect((await failing.available()).detail).toContain("validity unchecked");

    const serverError = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () => new Response("oops", { status: 500 }),
    });
    expect(await serverError.available()).toMatchObject({ available: true });
  });

  it("caches a definitive verdict and re-probes after the TTL or a key change", async () => {
    let calls = 0;
    let clock = 0;
    let key = "key-one";
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => key,
      keyCheckTtlMs: 1_000,
      nowMs: () => clock,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ data: {} });
      },
    });

    await backend.available();
    await backend.available();
    expect(calls).toBe(1);

    clock = 1_500;
    await backend.available();
    expect(calls).toBe(2);

    key = "key-two";
    await backend.available();
    expect(calls).toBe(3);
  });

  it("sends grok-4.5 with system and user, and returns the message content", async () => {
    let body: Record<string, unknown> = {};
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "```js\nboard.list()\n```" } }] });
      },
    });

    const completion = await backend.complete({ system: "sys", user: "usr" });

    expect(completion.text).toContain("board.list()");
    expect(body.model).toBe("x-ai/grok-4.5");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    expect(body.stream).toBe(false);
    expect(body.usage).toEqual({ include: true });
  });

  it("records what the generation cost, so a tick is not free by omission", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () =>
        jsonResponse({
          id: "gen-abc",
          provider: "xAI",
          choices: [{ message: { content: "```js\nboard.list()\n```" } }],
          usage: {
            prompt_tokens: 8_140,
            completion_tokens: 260,
            prompt_tokens_details: { cached_tokens: 7_900 },
            completion_tokens_details: { reasoning_tokens: 120 },
            cost: 0.0031,
          },
        }),
    });

    const completion = await backend.complete({ system: "s", user: "u" });

    expect(completion.usage).toEqual({
      inputTokens: 8_140,
      cachedInputTokens: 7_900,
      outputTokens: 260,
      reasoningTokens: 120,
      usd: 0.0031,
      generationId: "gen-abc",
      provider: "xAI",
    });
  });

  it("leaves usage absent when the response carries none, rather than guessing", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: "```js\nboard.list()\n```" } }] }),
    });

    expect((await backend.complete({ system: "s", user: "u" })).usage).toBeUndefined();
  });

  it("treats a 5xx as unavailable so the chain can fall through", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () => new Response("upstream down", { status: 503 }),
    });

    await expect(backend.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("treats an empty completion as a bad response, not unavailability", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "" } }] }),
    });

    const error = await backend
      .complete({ system: "s", user: "u" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HermesBackendError);
    expect((error as HermesBackendError).kind).toBe("bad-response");
  });

  it("joins array content parts", async () => {
    const backend = makeOpenRouterHermesBackend({
      resolveKey: async () => "test-key",
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }),
    });

    expect((await backend.complete({ system: "s", user: "u" })).text).toBe("ab");
  });
});
