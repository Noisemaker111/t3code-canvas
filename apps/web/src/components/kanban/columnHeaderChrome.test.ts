import { describe, expect, it } from "vite-plus/test";

/**
 * Column headers share the frame settings cog (SettingsIcon), not a mismatched
 * Settings2Icon. Centered titles live in PanelChrome when the title bar is up.
 * This trips the build if anyone swaps the icon or drops ColumnChromeSettings.
 */
describe("column header chrome matches the frame settings cog", () => {
  const boardSources = import.meta.glob("./KanbanBoard.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const frameSources = import.meta.glob("../canvas/panels/FrameSettingsMenu.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const chromeSources = import.meta.glob("../canvas/panels/PanelChrome.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const layerSources = import.meta.glob("../canvas/panels/PanelLayer.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const board = Object.values(boardSources)[0] ?? "";
  const frame = Object.values(frameSources)[0] ?? "";
  const chrome = Object.values(chromeSources)[0] ?? "";
  const layer = Object.values(layerSources)[0] ?? "";

  it("reads the sources", () => {
    expect(board.length).toBeGreaterThan(0);
    expect(frame.length).toBeGreaterThan(0);
    expect(chrome.length).toBeGreaterThan(0);
    expect(layer.length).toBeGreaterThan(0);
  });

  it("uses SettingsIcon for column rules, same as frame settings", () => {
    expect(frame).toContain("SettingsIcon");
    expect(board).toContain("SettingsIcon");
    expect(board).not.toContain("Settings2Icon");
  });

  it("exports ColumnChromeSettings for the panel title bar", () => {
    expect(board).toContain("export function ColumnChromeSettings");
    expect(layer).toContain("ColumnChromeSettings");
  });

  it("centers column titles in PanelChrome", () => {
    expect(chrome).toContain("centerLabel");
    expect(layer).toContain('centerLabel={entry.kind === "column"}');
  });
});
