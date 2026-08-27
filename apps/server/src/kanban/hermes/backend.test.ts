import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  HermesBackendError,
  hermesTransportClaims,
  resolveHermesTransport,
  runHermesBackend,
  tierModelId,
  toAcpModelId,
  type HermesAttempt,
  type HermesBackend,
  type HermesTier,
} from "./backend.ts";

const fakeBackend = (
  tier: HermesTier,
  behavior:
    | { kind: "ok"; text: string }
    | { kind: "unavailable"; detail: string }
    | { kind: "throws"; error: HermesBackendError },
): HermesBackend & { calls: number } => {
  const backend = {
    tier,
    calls: 0,
    available: async () =>
      behavior.kind === "unavailable"
        ? { tier, available: false, detail: behavior.detail }
        : { tier, available: true, detail: "ok" },
    complete: async () => {
      backend.calls += 1;
      if (behavior.kind === "throws") throw behavior.error;
      if (behavior.kind === "ok") return { text: behavior.text };
      throw new Error("unreachable");
    },
  };
  return backend;
};

describe("runHermesBackend", () => {
  it("serves from the chosen provider", async () => {
    const cursor = fakeBackend("cursor", { kind: "ok", text: "program" });
    const openrouter = fakeBackend("openrouter", { kind: "ok", text: "other" });

    const result = await runHermesBackend({
      backends: [cursor, openrouter],
      provider: "cursor",
      system: "s",
      user: "u",
    });

    expect(result.tier).toBe("cursor");
    expect(result.text).toBe("program");
    expect(openrouter.calls).toBe(0);
  });

  it("fails the tick when the chosen provider is unavailable — no fallback", async () => {
    const cursor = fakeBackend("cursor", { kind: "unavailable", detail: "missing binary" });
    const openrouter = fakeBackend("openrouter", { kind: "ok", text: "program" });

    const result = await runHermesBackend({
      backends: [cursor, openrouter],
      provider: "cursor",
      system: "s",
      user: "u",
    });

    expect(result.tier).toBeNull();
    expect(result.text).toBeNull();
    expect(openrouter.calls).toBe(0);
    expect(result.error?.message).toBe("missing binary");
    expect(result.attempts.map((attempt: HermesAttempt) => attempt.outcome)).toEqual([
      "unavailable",
    ]);
  });

  it("fails on a timeout or 5xx thrown as unavailable", async () => {
    const cursor = fakeBackend("cursor", {
      kind: "throws",
      error: new HermesBackendError({ tier: "cursor", kind: "unavailable", message: "timed out" }),
    });
    const openrouter = fakeBackend("openrouter", { kind: "ok", text: "program" });

    const result = await runHermesBackend({
      backends: [cursor, openrouter],
      provider: "cursor",
      system: "s",
      user: "u",
    });

    expect(result.tier).toBeNull();
    expect(result.error?.message).toBe("timed out");
    expect(openrouter.calls).toBe(0);
  });

  it("keeps a bad answer on the provider that gave it", async () => {
    const cursor = fakeBackend("cursor", {
      kind: "throws",
      error: new HermesBackendError({ tier: "cursor", kind: "bad-response", message: "empty" }),
    });

    const result = await runHermesBackend({
      backends: [cursor],
      provider: "cursor",
      system: "s",
      user: "u",
    });

    expect(result.tier).toBe("cursor");
    expect(result.text).toBeNull();
    expect(result.error?.kind).toBe("bad-response");
  });

  it("says so when the chosen provider has no backend wired up", async () => {
    const result = await runHermesBackend({
      backends: [fakeBackend("cursor", { kind: "ok", text: "program" })],
      provider: "openrouter",
      system: "s",
      user: "u",
    });

    expect(result.tier).toBeNull();
    expect(result.error?.message).toContain("no openrouter backend");
    expect(result.attempts.map((attempt: HermesAttempt) => attempt.tier)).toEqual(["openrouter"]);
  });
});

describe("tierModelId", () => {
  it("uses each CLI's native model family and keeps OpenRouter's full slug", () => {
    expect(tierModelId("openrouter", "x-ai/grok-4.5")).toBe("x-ai/grok-4.5");
    expect(tierModelId("cursor", "gpt-5.6-luna")).toBe("composer-2.5");
    expect(tierModelId("xai", "gpt-5.6-luna")).toBe("grok-4.5");
  });

  it("keeps Codex on the two allowed brain models", () => {
    expect(tierModelId("codex", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(tierModelId("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("falls back to the default model when unset", () => {
    expect(tierModelId("openrouter", "  ")).toBe("x-ai/grok-4.5");
    expect(toAcpModelId(null)).toBe("grok-4.5");
  });
});

describe("resolveHermesTransport", () => {
  const transports = hermesTransportClaims([
    { tier: "cursor", driver: ProviderDriverKind.make("cursor") },
    { tier: "xai", driver: ProviderDriverKind.make("grok") },
    { tier: "codex", driver: ProviderDriverKind.make("codex") },
    { tier: "openrouter", modelPrefix: "openrouter/" },
  ]);

  it("routes an openrouter model slug to the HTTPS transport, prefix stripped", () => {
    expect(
      resolveHermesTransport({
        transports,
        selection: { instanceId: "opencode", model: "openrouter/openai/gpt-5.6-luna" },
      }),
    ).toEqual({ tier: "openrouter", model: "openai/gpt-5.6-luna", reason: null });
  });

  it("routes the cursor, grok and codex drivers to their tiers", () => {
    expect(
      resolveHermesTransport({ transports, selection: { instanceId: "cursor", model: "grok-4.5" } })
        .tier,
    ).toBe("cursor");
    expect(
      resolveHermesTransport({ transports, selection: { instanceId: "grok", model: "grok-4.5" } })
        .tier,
    ).toBe("xai");
    expect(
      resolveHermesTransport({
        transports,
        selection: { instanceId: "codex", model: "gpt-5.6-codex" },
      }).tier,
    ).toBe("codex");
  });

  it("reads the driver of a renamed instance from the settings map", () => {
    expect(
      resolveHermesTransport({
        transports,
        selection: { instanceId: "codex_work", model: "gpt-5.6-codex" },
        drivers: { codex_work: "codex" },
      }).tier,
    ).toBe("codex");
  });

  it("resolves to no transport for an instance Hermes cannot drive", () => {
    const resolved = resolveHermesTransport({
      transports,
      selection: { instanceId: "claude", model: "claude-opus-4.5" },
    });

    expect(resolved.tier).toBeNull();
    expect(resolved.reason).toContain("not a transport Hermes can run");
  });

  it("fails with a reason when nothing is picked — there is no chain head", () => {
    const resolved = resolveHermesTransport({ transports });

    expect(resolved.tier).toBeNull();
    expect(resolved.reason).toContain("no provider instance is picked");
    expect(resolved.model).toBe("x-ai/grok-4.5");
  });

  it("routes a driver it has never heard of, purely from what the backends claim", () => {
    const resolved = resolveHermesTransport({
      transports: hermesTransportClaims([
        { tier: "codex", driver: ProviderDriverKind.make("someFork") },
      ]),
      selection: { instanceId: "fork_local", model: "m" },
      drivers: { fork_local: "someFork" },
    });

    expect(resolved).toEqual({ tier: "codex", model: "m", reason: null });
  });
});

// Vite serves `?raw`; the specifier is indirect because the server package has
// no ambient declaration for it.
const rawBackendModule = "./backend.ts?raw";
const backendSource = ((await import(rawBackendModule)) as { readonly default: string }).default;

/**
 * Transport resolution is data, not a literal: the tripwire is that no
 * driver-name → tier table can come back into this module.
 */
describe("no hardcoded transport map", () => {
  it("names no driver kind in the resolver", () => {
    for (const driver of ["cursor", "grok", "codex", "claudeAgent", "opencode"]) {
      expect(backendSource, `backend.ts must not name the ${driver} driver`).not.toContain(
        `"${driver}"`,
      );
    }
  });

  it("declares no tier-valued record", () => {
    expect(backendSource).not.toMatch(/Record<\s*string\s*,\s*HermesTier\s*>/);
  });
});
