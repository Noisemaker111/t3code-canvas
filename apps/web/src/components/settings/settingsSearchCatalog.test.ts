import { describe, expect, it } from "vite-plus/test";

import { highlightQuerySegments, searchSettingsCatalog } from "./settingsSearchCatalog";

describe("searchSettingsCatalog", () => {
  it("matches titles and descriptions", () => {
    const hits = searchSettingsCatalog("theme");
    expect(hits.some((hit) => hit.id === "general.theme")).toBe(true);
  });

  it("matches connection provider keywords", () => {
    const hits = searchSettingsCatalog("claude login");
    expect(hits.some((hit) => hit.path === "/settings/connections")).toBe(true);
  });

  it("returns empty for blank query", () => {
    expect(searchSettingsCatalog("   ")).toEqual([]);
  });
});

describe("highlightQuerySegments", () => {
  it("marks matching substrings", () => {
    expect(highlightQuerySegments("Default model", "model")).toEqual([
      { text: "Default ", match: false },
      { text: "model", match: true },
    ]);
  });

  it("returns plain text when nothing matches", () => {
    expect(highlightQuerySegments("Hello", "xyz")).toEqual([{ text: "Hello", match: false }]);
  });
});
