import { describe, expect, it } from "vite-plus/test";
import { formatRoutedModelLabel, modelMatchesSearch, subProviderRoutePrefix } from "./modelLabels";

describe("modelLabels", () => {
  it("slugifies sub-providers for route prefixes", () => {
    expect(subProviderRoutePrefix("OpenRouter")).toBe("openrouter");
    expect(subProviderRoutePrefix("OpenCode Zen")).toBe("opencode-zen");
    expect(subProviderRoutePrefix(undefined)).toBeNull();
  });

  it("formats openrouter/style labels", () => {
    expect(
      formatRoutedModelLabel({
        slug: "aion-2.0",
        name: "Aion-2.0",
        subProvider: "OpenRouter",
      }),
    ).toBe("openrouter/Aion-2.0");
    expect(
      formatRoutedModelLabel({
        slug: "openrouter/aion-2.0",
        name: "Aion-2.0",
        subProvider: "OpenRouter",
      }),
    ).toBe("openrouter/aion-2.0");
  });

  it("matches search across prefix and name", () => {
    const option = {
      slug: "aion-2.0",
      name: "Aion-2.0",
      subProvider: "OpenRouter",
    };
    expect(modelMatchesSearch(option, "openrouter")).toBe(true);
    expect(modelMatchesSearch(option, "aion")).toBe(true);
    expect(modelMatchesSearch(option, "claude")).toBe(false);
  });
});
