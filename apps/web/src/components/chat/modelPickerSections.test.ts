import { describe, expect, it } from "vite-plus/test";
import {
  buildModelPickerSectionedRows,
  modelPickerListShowsSections,
  modelPickerSectionLabel,
} from "./modelPickerSections";

describe("modelPickerSectionLabel", () => {
  it("uses subProvider alone for a single-instance list", () => {
    expect(
      modelPickerSectionLabel(
        {
          instanceId: "opencode",
          instanceDisplayName: "OpenCode",
          slug: "gpt",
          subProvider: "OpenRouter",
        },
        { multiInstance: false },
      ),
    ).toBe("OpenRouter");
  });

  it("prefixes instance name when multiple instances are mixed", () => {
    expect(
      modelPickerSectionLabel(
        {
          instanceId: "opencode",
          instanceDisplayName: "OpenCode",
          slug: "gpt",
          subProvider: "OpenRouter",
        },
        { multiInstance: true },
      ),
    ).toBe("OpenCode · OpenRouter");
  });

  it("falls back to instance display name without subProvider", () => {
    expect(
      modelPickerSectionLabel(
        { instanceId: "codex", instanceDisplayName: "Codex", slug: "gpt-5" },
        { multiInstance: true },
      ),
    ).toBe("Codex");
  });
});

describe("buildModelPickerSectionedRows", () => {
  it("keeps a plain single-provider catalog flat", () => {
    const rows = buildModelPickerSectionedRows([
      { instanceId: "codex", instanceDisplayName: "Codex", slug: "a" },
      { instanceId: "codex", instanceDisplayName: "Codex", slug: "b" },
    ]);
    expect(modelPickerListShowsSections(rows)).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "model")).toBe(true);
  });

  it("sections OpenCode models by upstream router", () => {
    const rows = buildModelPickerSectionedRows([
      {
        instanceId: "opencode",
        instanceDisplayName: "OpenCode",
        slug: "or-1",
        subProvider: "OpenRouter",
      },
      {
        instanceId: "opencode",
        instanceDisplayName: "OpenCode",
        slug: "or-2",
        subProvider: "OpenRouter",
      },
      {
        instanceId: "opencode",
        instanceDisplayName: "OpenCode",
        slug: "anth-1",
        subProvider: "Anthropic",
      },
    ]);
    expect(rows.map((row) => (row.kind === "section" ? row.label : row.model.slug))).toEqual([
      "OpenRouter",
      "or-1",
      "or-2",
      "Anthropic",
      "anth-1",
    ]);
    const models = rows.filter((row) => row.kind === "model");
    expect(models.map((row) => (row.kind === "model" ? row.comboboxIndex : -1))).toEqual([0, 1, 2]);
  });

  it("sections favorites/search across instances by harness and router", () => {
    const rows = buildModelPickerSectionedRows([
      { instanceId: "claudeAgent", instanceDisplayName: "Claude", slug: "sonnet" },
      {
        instanceId: "opencode",
        instanceDisplayName: "OpenCode",
        slug: "free",
        subProvider: "OpenCode Zen",
      },
      { instanceId: "codex", instanceDisplayName: "Codex", slug: "gpt-5" },
    ]);
    expect(rows.map((row) => (row.kind === "section" ? `§${row.label}` : row.model.slug))).toEqual([
      "§Claude",
      "sonnet",
      "§OpenCode · OpenCode Zen",
      "free",
      "§Codex",
      "gpt-5",
    ]);
  });
});
