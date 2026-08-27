import { describe, expect, it } from "vite-plus/test";

/**
 * Tripwire for the one thing that made zooming expensive: a panel body that
 * lives at a different place in the element tree depending on its tier gets
 * unmounted and rebuilt on every crossing — transcripts, terminals and diff
 * workers with it.
 *
 * The body must be built in exactly one place and hidden with a class, so this
 * fails the build if a second `PANEL_BODIES[kind]?.(...)` call comes back.
 */
const source = Object.values(
  import.meta.glob("./PanelContent.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>,
)[0]!;

describe("PanelContent keeps one slot for the body", () => {
  it("builds the body exactly once", () => {
    const calls = source.match(/PANEL_BODIES\[kind\]\??\.?\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("hides the body with a class rather than unmounting it", () => {
    expect(source).toContain('"contents" : "hidden"');
  });
});
