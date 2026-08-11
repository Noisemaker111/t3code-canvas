import { describe, expect, it } from "@effect/vitest";

import {
  CODEX_MODEL_LUNA,
  CODEX_MODEL_SOL,
  defaultCodexCheapModel,
  defaultCodexModel,
  isAllowedCodexBaseModel,
  resolveCodexBaseModel,
} from "./codexModelPolicy.ts";

describe("resolveCodexBaseModel", () => {
  it("keeps sol and luna", () => {
    expect(resolveCodexBaseModel("gpt-5.6-sol")).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("gpt-5.6-luna")).toBe(CODEX_MODEL_LUNA);
  });

  it("rewrites retired 5.4 / 5.5 pins", () => {
    expect(resolveCodexBaseModel("gpt-5.4")).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("gpt-5.4-mini")).toBe(CODEX_MODEL_LUNA);
    expect(resolveCodexBaseModel("gpt-5.5")).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("gpt-5")).toBe(CODEX_MODEL_SOL);
  });

  it("rewrites invented or legacy codex suffixes", () => {
    expect(resolveCodexBaseModel("gpt-5.6-codex")).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("gpt-5-codex")).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("gpt-5.3-codex")).toBe(CODEX_MODEL_SOL);
  });

  it("strips openai/ prefix", () => {
    expect(resolveCodexBaseModel("openai/gpt-5.4-mini")).toBe(CODEX_MODEL_LUNA);
  });

  it("prefers available catalog intersection", () => {
    expect(resolveCodexBaseModel("gpt-5.4", ["gpt-5.6-luna"])).toBe(CODEX_MODEL_LUNA);
    expect(resolveCodexBaseModel("gpt-5.6-luna", ["gpt-5.6-sol", "gpt-5.6-luna"])).toBe(
      CODEX_MODEL_LUNA,
    );
  });

  it("defaults empty to sol", () => {
    expect(resolveCodexBaseModel(null)).toBe(CODEX_MODEL_SOL);
    expect(resolveCodexBaseModel("")).toBe(CODEX_MODEL_SOL);
  });
});

describe("isAllowedCodexBaseModel / defaults", () => {
  it("only allows sol and luna", () => {
    expect(isAllowedCodexBaseModel("gpt-5.6-sol")).toBe(true);
    expect(isAllowedCodexBaseModel("gpt-5.4")).toBe(false);
    expect(defaultCodexModel()).toBe(CODEX_MODEL_SOL);
    expect(defaultCodexCheapModel()).toBe(CODEX_MODEL_LUNA);
  });
});
