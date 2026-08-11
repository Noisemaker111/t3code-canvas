import { describe, expect, it } from "vite-plus/test";

/**
 * API keys have ONE entry surface. This trips the build if anyone reintroduces
 * a second one: only `usageCredentials.ts` may talk to `/api/usage/credentials`,
 * and only the API keys section may write a key.
 */
describe("API key entry stays one system", () => {
  const sources = Object.entries(
    import.meta.glob("./*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));

  const basenamesContaining = (needle: string) =>
    sources
      .filter(([, source]) => source.includes(needle))
      .map(([path]) => path.split("/").at(-1))
      .toSorted();

  it("routes every credential call through the shared store", () => {
    expect(basenamesContaining("/api/usage/credentials")).toEqual(["usageCredentials.ts"]);
  });

  it("writes keys from the API keys section only", () => {
    expect(basenamesContaining("saveUsageCredential")).toEqual([
      "ApiKeysSettings.tsx",
      "usageCredentials.ts",
    ]);
  });

  it("covers every family the server accepts a pasted key for", () => {
    const panel = sources.find(([path]) => path.endsWith("ApiKeysSettings.tsx"))?.[1] ?? "";
    for (const family of ["openrouter", "grok", "cursor"]) {
      expect(panel).toContain(`family: "${family}"`);
    }
  });
});
