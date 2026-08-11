import { describe, expect, it } from "vite-plus/test";
import {
  computeMetricPodium,
  formatMs,
  formatUsd,
  formatUsdExact,
  groupCompareRows,
  isSemiCheapCatalogEntry,
  pickSemiCheapModelSlugs,
  rankScore,
  type ModelBenchTrialResult,
} from "./modelBench";

function trial(
  partial: Partial<ModelBenchTrialResult> & Pick<ModelBenchTrialResult, "role" | "model" | "ok">,
): ModelBenchTrialResult {
  return {
    instanceId: "opencode",
    label: partial.model,
    openRouterId: "x/y",
    ttftMs: 200,
    completionMs: 1500,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.001,
    costSource: "usage+list_price",
    tokensSource: "openrouter_usage",
    qualityScore: 80,
    outputPreview: "ok",
    ranAt: new Date().toISOString(),
    runId: "run-1",
    ...partial,
  };
}

describe("modelBench v2", () => {
  it("formats ms and usd without scientific notation", () => {
    expect(formatMs(850)).toBe("850ms");
    expect(formatMs(2400)).toBe("2.40s");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0.0234)).toBe("$0.02");
    expect(formatUsd(0.000012)).toBe("$0.000012");
    expect(formatUsd(1e-5)).toBe("$0.00001");
    expect(formatUsd(1e-5)).not.toMatch(/e/i);
    expect(formatUsdExact(0.000012)).toBe("$0.000012");
  });

  it("groups structure+hermes into one compare row", () => {
    const rows = groupCompareRows(
      [
        trial({ role: "structure", model: "openrouter/a", ok: true, qualityScore: 90 }),
        trial({ role: "hermes", model: "openrouter/a", ok: true, qualityScore: 70 }),
        trial({ role: "hermes", model: "openrouter/b", ok: false }),
      ],
      "run-1",
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.model === "openrouter/a");
    expect(a?.structure?.ok).toBe(true);
    expect(a?.hermes?.ok).toBe(true);
    expect(a!.combinedRank).toBeGreaterThan(0);
  });

  it("drops trials from retired roles in saved history", () => {
    const rows = groupCompareRows(
      [
        { ...trial({ role: "hermes", model: "openrouter/a", ok: true }), role: "legacy-role" },
      ] as unknown as ModelBenchTrialResult[],
      "run-1",
    );
    expect(rows).toHaveLength(0);
  });

  it("groups structure fixture trials", () => {
    const rows = groupCompareRows(
      [
        trial({
          role: "structure",
          model: "openrouter/gpt-4.1-mini",
          ok: true,
          intelligenceScore: 80,
        }),
      ],
      "run-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.structure?.ok).toBe(true);
    expect(rows[0]!.combinedRank).toBeGreaterThan(0);
  });

  it("picks current paid openrouter ids and excludes free/legacy", () => {
    const picked = pickSemiCheapModelSlugs({
      optionSlugs: [
        "openrouter/openai/gpt-5.4-mini",
        "openrouter/openai/gpt-4.1-mini",
        "openrouter/google/gemini-3.5-flash",
        "openrouter/google/gemini-2.5-flash",
        "openrouter/deepseek/deepseek-v4-flash",
        "openrouter/deepseek/deepseek-chat",
        "openrouter/anthropic/claude-haiku-4.5",
        "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        "codex/gpt-5",
      ],
      catalogEntries: [
        {
          id: "openai/gpt-5.4-mini",
          isFree: false,
          promptUsdPerMTok: 0.75,
          completionUsdPerMTok: 4.5,
        },
        {
          id: "google/gemini-3.5-flash",
          isFree: false,
          promptUsdPerMTok: 1.5,
          completionUsdPerMTok: 9,
        },
        {
          id: "deepseek/deepseek-chat",
          isFree: false,
          promptUsdPerMTok: 0.2,
          completionUsdPerMTok: 0.8,
        },
        {
          id: "meta-llama/llama-3.3-70b-instruct:free",
          isFree: true,
          promptUsdPerMTok: 0,
          completionUsdPerMTok: 0,
        },
      ],
      max: 10,
    });
    expect(picked).toContain("openrouter/openai/gpt-5.4-mini");
    expect(picked).toContain("openrouter/google/gemini-3.5-flash");
    expect(picked).toContain("openrouter/deepseek/deepseek-v4-flash");
    expect(picked).toContain("openrouter/anthropic/claude-haiku-4.5");
    expect(picked.some((s) => s.includes("gemini-2.5"))).toBe(false);
    expect(picked.some((s) => s.endsWith("deepseek-chat"))).toBe(false);
    expect(picked.some((s) => s.includes(":free"))).toBe(false);
    expect(
      isSemiCheapCatalogEntry({
        id: "deepseek/deepseek-chat",
        isFree: false,
        promptUsdPerMTok: 0.2,
        completionUsdPerMTok: 0.8,
      }),
    ).toBe(false);
    expect(
      isSemiCheapCatalogEntry({
        id: "google/gemini-2.5-flash",
        isFree: false,
        promptUsdPerMTok: 0.3,
        completionUsdPerMTok: 2.5,
      }),
    ).toBe(false);
  });

  it("ranks failures below successes", () => {
    const ok = trial({ role: "hermes", model: "m", ok: true });
    const bad = trial({ role: "hermes", model: "m", ok: false, qualityScore: 0 });
    expect(rankScore(ok)).toBeGreaterThan(rankScore(bad));
  });

  it("marks 1st and 2nd for lower-better metrics", () => {
    const rows = groupCompareRows(
      [
        trial({
          role: "structure",
          model: "fast",
          ok: true,
          ttftMs: 100,
          completionMs: 500,
          costUsd: 0.001,
          intelligenceScore: 50,
        }),
        trial({
          role: "structure",
          model: "mid",
          ok: true,
          ttftMs: 200,
          completionMs: 800,
          costUsd: 0.002,
          intelligenceScore: 90,
        }),
        trial({
          role: "structure",
          model: "slow",
          ok: true,
          ttftMs: 900,
          completionMs: 5000,
          costUsd: 0.01,
          intelligenceScore: 40,
        }),
      ],
      "run-1",
    );
    const ttft = computeMetricPodium(rows, "ttft");
    expect(ttft.get("opencode:fast")).toBe(1);
    expect(ttft.get("opencode:mid")).toBe(2);
    const intel = computeMetricPodium(rows, "intel");
    expect(intel.get("opencode:mid")).toBe(1);
  });

  it("weights intelligence above structure-only", () => {
    const smart = trial({
      role: "hermes",
      model: "smart",
      ok: true,
      intelligenceScore: 90,
      structureScore: 40,
      qualityScore: 40,
    });
    const pretty = trial({
      role: "hermes",
      model: "pretty",
      ok: true,
      intelligenceScore: 40,
      structureScore: 95,
      qualityScore: 95,
    });
    expect(rankScore(smart)).toBeGreaterThan(rankScore(pretty));
  });
});
