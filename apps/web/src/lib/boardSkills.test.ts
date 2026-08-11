import { describe, expect, it } from "vite-plus/test";

import { mergeCoreBoardSkillIds, resolveBoardSkillPipeline, runSkillPipeline } from "./boardSkills";

describe("browser board skills", () => {
  it("keeps optional transforms but retires the old model-router", () => {
    expect(mergeCoreBoardSkillIds(["research", "model-router", "structure"])).toEqual([
      "research",
      "structure",
    ]);
  });

  it("only resolves explicitly selected prompt transforms", () => {
    const skills = resolveBoardSkillPipeline({
      alwaysOnSkillIds: ["model-router", "research"],
      skillCommands: {
        "model-router": { prompt: "legacy route" },
        structure: { prompt: "structure" },
        research: { prompt: "research" },
      },
    });
    expect(skills.map((skill) => skill.id)).toEqual(["research"]);
  });

  it("never manufactures a Size header after a transform", async () => {
    const result = await runSkillPipeline({
      source: "Fix tenant isolation.",
      skills: [{ id: "research", prompt: "Improve the brief." }],
      assist: async () => ({ text: "Mission\nFix tenant isolation safely." }),
    });
    expect(result.text).toBe("Mission\nFix tenant isolation safely.");
    expect(result.text).not.toMatch(/# Size:/);
  });
});
