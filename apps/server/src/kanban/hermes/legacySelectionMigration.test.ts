import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { hermesTransportClaims } from "./backend.ts";
import { hermesLegacySelectionPatch } from "./legacySelectionMigration.ts";

const transports = hermesTransportClaims([
  { tier: "cursor", driver: ProviderDriverKind.make("cursor") },
  { tier: "xai", driver: ProviderDriverKind.make("grok") },
  { tier: "codex", driver: ProviderDriverKind.make("codex") },
  { tier: "openrouter", modelPrefix: "openrouter/" },
]);

const patch = (input: {
  instanceId?: string | null;
  model?: string;
  order?: ReadonlyArray<"cursor" | "xai" | "codex" | "openrouter">;
  disabled?: ReadonlyArray<"cursor" | "xai" | "codex" | "openrouter">;
}) =>
  hermesLegacySelectionPatch({
    instanceId: input.instanceId ?? null,
    model: input.model ?? "x-ai/grok-4.5",
    order: input.order ?? ["cursor", "xai", "openrouter"],
    disabled: input.disabled ?? [],
    transports,
  });

describe("hermesLegacySelectionPatch", () => {
  // The head of the shipped tier list is not a choice anybody made, and it is
  // not the provider the default model belongs to.
  it("ships the default model's own instance when the chain is untouched", () => {
    expect(patch({})).toEqual({ hermesBrainInstanceId: "grok" });
    expect(patch({ order: ["cursor", "xai", "codex", "openrouter"] })).toEqual({
      hermesBrainInstanceId: "grok",
    });
  });

  it("writes the driver behind the chain head when the owner reordered it", () => {
    expect(patch({ order: ["openrouter", "cursor", "xai"] })).toEqual({
      hermesBrainInstanceId: "openrouter",
      hermesBrainModel: "openrouter/x-ai/grok-4.5",
    });
    expect(patch({ disabled: ["cursor"] })).toEqual({ hermesBrainInstanceId: "grok" });
    expect(patch({ order: ["codex", "cursor"], disabled: [] })).toEqual({
      hermesBrainInstanceId: "codex",
    });
  });

  it("prefixes the model when the head transport is claimed by slug", () => {
    expect(patch({ order: ["openrouter", "cursor"] })).toEqual({
      hermesBrainInstanceId: "openrouter",
      hermesBrainModel: "openrouter/x-ai/grok-4.5",
    });
    expect(patch({ order: ["openrouter"], model: "openrouter/x-ai/grok-4.5" })).toEqual({
      hermesBrainInstanceId: "openrouter",
    });
  });

  it("leaves a board that already picked an instance alone", () => {
    expect(patch({ instanceId: "codex" })).toBeNull();
    expect(patch({ instanceId: "  " })).not.toBeNull();
  });

  it("migrates nothing when no wired-up transport claims the chain head", () => {
    expect(
      hermesLegacySelectionPatch({
        instanceId: null,
        model: "x-ai/grok-4.5",
        order: ["cursor"],
        disabled: [],
        transports: hermesTransportClaims([{ tier: "openrouter", modelPrefix: "openrouter/" }]),
      }),
    ).toBeNull();
  });
});
