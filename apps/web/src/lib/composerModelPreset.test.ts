import { DEFAULT_BOARD_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerPresetSelection, readComposerModelPreset } from "./composerModelPreset";

describe("composer model preset", () => {
  it("defaults to Auto Router", () => {
    expect(readComposerModelPreset(DEFAULT_BOARD_SETTINGS)).toBeNull();
    expect(composerPresetSelection(null)).toBeNull();
  });

  it("needs both halves to pin a model", () => {
    expect(
      readComposerModelPreset({ composerInstanceId: "claudeAgent", composerModel: null }),
    ).toBeNull();
    expect(readComposerModelPreset({ composerInstanceId: null, composerModel: "opus" })).toBeNull();
  });

  it("reads a pinned harness + model", () => {
    const preset = readComposerModelPreset({
      composerInstanceId: "claudeAgent",
      composerModel: "claude-opus-5",
    });
    expect(preset).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5" });
    expect(composerPresetSelection(preset)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
    });
  });
});
