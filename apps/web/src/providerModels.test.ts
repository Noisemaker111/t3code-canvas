import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

import { guardDefaultModelSelection } from "./providerModels";

const provider = (input: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-10T00:00:00.000Z",
    models: [{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...input,
  }) as ServerProvider;

describe("guardDefaultModelSelection", () => {
  it("falls back from unauthenticated Claude to usable Codex Luna", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    };
    const guarded = guardDefaultModelSelection(selection, [
      provider({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "warning",
        auth: { status: "unauthenticated" },
      }),
      provider({}),
    ]);
    expect(guarded).toEqual({ instanceId: "codex", model: "gpt-5.6-luna" });
  });

  it("does not change an authenticated Claude default", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    };
    expect(
      guardDefaultModelSelection(selection, [
        provider({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          auth: { status: "authenticated" },
        }),
        provider({}),
      ]),
    ).toEqual(selection);
  });
});
