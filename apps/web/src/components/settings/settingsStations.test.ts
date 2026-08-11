import { describe, expect, it } from "vite-plus/test";

import {
  resolveSettingsSection,
  settingsSectionForPath,
  settingsStationForPath,
} from "./settingsStations";

describe("settingsStations", () => {
  it("maps legacy paths to panel sections", () => {
    expect(settingsSectionForPath("/settings/board")).toBe("board");
    expect(settingsSectionForPath("/settings/skill-commands")).toBe("board");
    expect(settingsSectionForPath("/settings/archived")).toBe("board");
    expect(settingsSectionForPath("/settings/performance")).toBe("system");
    expect(settingsSectionForPath("/settings/providers")).toBe("connections");
    expect(settingsSectionForPath("/settings/source-control")).toBe("connections");
    expect(settingsSectionForPath("/settings/updates")).toBe("connections");
    expect(settingsSectionForPath("/settings")).toBeNull();
    expect(settingsSectionForPath("/settings/nope")).toBeNull();
  });

  it("resolves pre-merge station ids onto the section that absorbed them", () => {
    expect(resolveSettingsSection("vps")).toBe("system");
    expect(resolveSettingsSection("diagnostics")).toBe("system");
    expect(resolveSettingsSection("skills")).toBe("board");
    expect(resolveSettingsSection("friction")).toBe("hermes");
    expect(resolveSettingsSection("keybindings")).toBe("general");
    expect(resolveSettingsSection("providers")).toBe("connections");
    expect(resolveSettingsSection("hermes")).toBe("hermes");
    expect(resolveSettingsSection("nope")).toBeNull();
  });

  it("falls back to the bare settings station", () => {
    expect(settingsStationForPath("/settings/hermes")).toBe("settings:hermes");
    expect(settingsStationForPath("/settings")).toBe("settings");
    expect(settingsStationForPath("/settings/unknown")).toBe("settings");
  });
});

/**
 * The canvas `SettingsPanel` is the ONE settings surface. This trips the build
 * if anyone reintroduces a second one: a `/settings/*` route may only redirect
 * into the panel, never render a shell of its own.
 */
describe("settings routes stay redirect-only", () => {
  const routeSources = import.meta.glob("../../routes/settings*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("has exactly the two redirect routes", () => {
    const names = Object.keys(routeSources)
      .map((key) => key.split("/").at(-1))
      .toSorted();
    expect(names).toEqual(["settings.$.tsx", "settings.tsx"]);
  });

  it("every settings route redirects and renders nothing", () => {
    for (const [name, source] of Object.entries(routeSources)) {
      expect(source, `${name} must redirect into the canvas settings station`).toContain(
        "throw redirect(",
      );
      expect(source, `${name} must not render a settings shell`).toContain("component: () => null");
    }
  });
});
