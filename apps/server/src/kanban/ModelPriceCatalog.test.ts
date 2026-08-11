import { describe, expect, it } from "@effect/vitest";

import { modelCatalogSnapshotPath, parseModelsDevSnapshot } from "./ModelPriceCatalog.ts";

const snapshot = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        cost: { input: 5, output: 25 },
        limit: { context: 200_000, output: 64_000 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5 },
        limit: { context: 200_000 },
      },
    },
  },
  broken: { models: { ghost: null } },
  alsoBroken: { id: "alsoBroken" },
};

describe("ModelPriceCatalog", () => {
  it("indexes models by provider-qualified id and bare slug", () => {
    const byId = parseModelsDevSnapshot(snapshot);
    expect(byId.get("anthropic/claude-opus-4-5")?.promptUsdPerMTok).toBe(5);
    expect(byId.get("claude-opus-4-5")?.completionUsdPerMTok).toBe(25);
    expect(byId.get("anthropic/claude-opus-4-5")?.contextLength).toBe(200_000);
  });

  it("falls back to the model id when no name is given", () => {
    expect(parseModelsDevSnapshot(snapshot).get("claude-haiku-4-5")?.name).toBe("claude-haiku-4-5");
  });

  it("skips malformed entries instead of guessing a price", () => {
    const byId = parseModelsDevSnapshot(snapshot);
    expect(byId.has("ghost")).toBe(false);
    expect(byId.has("broken/ghost")).toBe(false);
  });

  it("returns an empty map for junk input", () => {
    expect(parseModelsDevSnapshot(null).size).toBe(0);
    expect(parseModelsDevSnapshot("<html>404</html>").size).toBe(0);
    expect(parseModelsDevSnapshot([1, 2, 3]).size).toBe(0);
  });

  it("reads the snapshot path from the environment", () => {
    expect(modelCatalogSnapshotPath({})).toBe("/opt/t3j/models-dev.json");
    expect(modelCatalogSnapshotPath({ T3CODE_MODEL_CATALOG_FILE: "/tmp/x.json" })).toBe(
      "/tmp/x.json",
    );
  });
});
