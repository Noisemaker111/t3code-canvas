import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";

import {
  buildProviderFavoriteModelsPatch,
  buildProviderModelPreferencesPatch,
  deriveProviderModelsForDisplay,
  getModelCapabilityLabels,
  modelMatchesSearchQuery,
} from "./modelsPage.logic";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      { slug: "server-model", name: "Server Model", isCustom: false, capabilities: null },
      { slug: "removed-custom", name: "Removed Custom", isCustom: true, capabilities: null },
      { slug: "kept-custom", name: "Kept Custom", isCustom: true, capabilities: null },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("getModelCapabilityLabels", () => {
  it("collects fast mode, thinking, and reasoning labels from option descriptors", () => {
    const model: ServerProviderModel = {
      slug: "m",
      name: "M",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", label: "Fast mode", type: "boolean" },
          { id: "thinking", label: "Thinking", type: "boolean" },
          { id: "reasoningEffort", label: "Reasoning effort", type: "select", options: [] },
        ],
      },
    };

    expect(getModelCapabilityLabels(model)).toEqual(["Fast mode", "Thinking", "Reasoning"]);
  });

  it("returns no labels for a model without matching descriptors", () => {
    const model: ServerProviderModel = {
      slug: "m",
      name: "M",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    };

    expect(getModelCapabilityLabels(model)).toEqual([]);
  });
});

describe("modelMatchesSearchQuery", () => {
  const model: ServerProviderModel = {
    slug: "gpt-6-ultra",
    name: "GPT-6 Ultra",
    isCustom: false,
    capabilities: null,
  };

  it("matches on slug or name, case-insensitively", () => {
    expect(modelMatchesSearchQuery(model, "ultra")).toBe(true);
    expect(modelMatchesSearchQuery(model, "GPT-6")).toBe(true);
    expect(modelMatchesSearchQuery(model, "claude")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(modelMatchesSearchQuery(model, "  ")).toBe(true);
  });
});

describe("buildProviderModelPreferencesPatch", () => {
  const instanceId = "codex" as ProviderInstanceId;

  it("dedupes and drops blank slugs, then writes the entry", () => {
    const patch = buildProviderModelPreferencesPatch({ providerModelPreferences: {} }, instanceId, {
      hiddenModels: ["a", "a", " ", "b"],
      modelOrder: ["b", "a"],
    });

    expect(patch.providerModelPreferences?.[instanceId]).toEqual({
      hiddenModels: ["a", "b"],
      modelOrder: ["b", "a"],
    });
  });

  it("removes the entry entirely once both lists are empty", () => {
    const patch = buildProviderModelPreferencesPatch(
      { providerModelPreferences: { [instanceId]: { hiddenModels: ["a"], modelOrder: [] } } },
      instanceId,
      { hiddenModels: [], modelOrder: [] },
    );

    expect(patch.providerModelPreferences).toEqual({});
  });
});

describe("buildProviderFavoriteModelsPatch", () => {
  const instanceId = "codex" as ProviderInstanceId;
  const otherInstanceId = "claudeAgent" as ProviderInstanceId;

  it("replaces this instance's favorites while preserving other instances'", () => {
    const patch = buildProviderFavoriteModelsPatch(
      {
        favorites: [
          { provider: instanceId, model: "old" },
          { provider: otherInstanceId, model: "kept" },
        ],
      },
      instanceId,
      ["new-a", "new-b"],
    );

    expect(patch.favorites).toEqual([
      { provider: otherInstanceId, model: "kept" },
      { provider: instanceId, model: "new-a" },
      { provider: instanceId, model: "new-b" },
    ]);
  });
});
