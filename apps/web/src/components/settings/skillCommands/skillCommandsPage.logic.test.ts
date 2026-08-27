import { describe, expect, it } from "vite-plus/test";

import {
  buildSkillCommandsPatch,
  buildSkillLlmMessage,
  isReservedSkillCommandName,
  MAX_SKILL_COMMAND_ID_LENGTH,
  normalizeSkillCommandId,
  parseSkillMarkdown,
  parseSkillsShRef,
  skillsShSkillMdUrls,
  STARTER_GLOBAL_SKILLS,
  CORE_BOARD_SKILL_IDS,
  isCoreBoardSkillId,
  mergeCoreBoardSkillIds,
} from "./skillCommandsPage.logic";

describe("normalizeSkillCommandId", () => {
  it("trims and lowercases a valid name", () => {
    expect(normalizeSkillCommandId("  Handoff  ")).toBe("handoff");
  });

  it("rejects names that don't start with a letter", () => {
    expect(normalizeSkillCommandId("1handoff")).toBeNull();
  });

  it("rejects names with disallowed characters", () => {
    expect(normalizeSkillCommandId("hand off")).toBeNull();
    expect(normalizeSkillCommandId("hand/off")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(normalizeSkillCommandId("   ")).toBeNull();
  });

  it("rejects names over the max length", () => {
    expect(normalizeSkillCommandId("a".repeat(MAX_SKILL_COMMAND_ID_LENGTH + 1))).toBeNull();
    expect(normalizeSkillCommandId("a".repeat(MAX_SKILL_COMMAND_ID_LENGTH))).toBe(
      "a".repeat(MAX_SKILL_COMMAND_ID_LENGTH),
    );
  });
});

describe("isReservedSkillCommandName", () => {
  it("blocks names claimed by built-in composer commands", () => {
    expect(isReservedSkillCommandName("plan")).toBe(true);
    expect(isReservedSkillCommandName("Model")).toBe(true);
    expect(isReservedSkillCommandName("default")).toBe(true);
    expect(isReservedSkillCommandName("btw")).toBe(true);
  });

  it("allows other names", () => {
    expect(isReservedSkillCommandName("handoff")).toBe(false);
  });
});

describe("buildSkillCommandsPatch", () => {
  it("replaces the whole map", () => {
    const next = { handoff: { prompt: "Summarize where we left off." } } as never;
    expect(buildSkillCommandsPatch(next)).toEqual({ skillCommands: next });
  });
});

describe("buildSkillLlmMessage", () => {
  it("always appends INPUT (no template substitution)", () => {
    expect(buildSkillLlmMessage("Rewrite into a mission.", "fix the login squish")).toBe(
      "Rewrite into a mission.\n\n---\nINPUT:\n\nfix the login squish",
    );
  });

  it("strips legacy {{prompt}} tokens and still appends INPUT", () => {
    expect(buildSkillLlmMessage("Do: {{prompt}} carefully", "ship it")).toBe(
      "Do:  carefully\n\n---\nINPUT:\n\nship it",
    );
  });

  it("starter skills never require {{prompt}}", () => {
    for (const skill of STARTER_GLOBAL_SKILLS) {
      expect(skill.prompt).not.toContain("{{prompt}}");
      expect(skill.prompt.length).toBeGreaterThan(40);
    }
  });

  it("keeps routing off the skill list and drops retired ids", () => {
    expect([...CORE_BOARD_SKILL_IDS]).toEqual([]);
    expect(isCoreBoardSkillId("structure")).toBe(false);
    expect(isCoreBoardSkillId("implement")).toBe(false);
    expect(mergeCoreBoardSkillIds(["research", "model-router"])).toEqual(["research"]);
  });
});

describe("parseSkillsShRef", () => {
  it("parses owner/repo/skill", () => {
    expect(parseSkillsShRef("mattpocock/skills/research")).toEqual({
      owner: "mattpocock",
      repo: "skills",
      skill: "research",
    });
  });

  it("parses owner/repo@skill CLI form", () => {
    expect(parseSkillsShRef("mattpocock/skills@research")).toEqual({
      owner: "mattpocock",
      repo: "skills",
      skill: "research",
    });
  });

  it("parses skills.sh URLs", () => {
    expect(parseSkillsShRef("https://skills.sh/mattpocock/skills/research")).toEqual({
      owner: "mattpocock",
      repo: "skills",
      skill: "research",
    });
  });

  it("parses npx skills add with --skill", () => {
    expect(
      parseSkillsShRef("npx skills add https://github.com/mattpocock/skills --skill research"),
    ).toEqual({
      owner: "mattpocock",
      repo: "skills",
      skill: "research",
    });
  });

  it("returns null for natural language so search can run", () => {
    expect(parseSkillsShRef("improve claude.md")).toBeNull();
    expect(parseSkillsShRef("research prompt structure")).toBeNull();
  });
});

describe("skillsShSkillMdUrls", () => {
  it("includes common SKILL.md locations", () => {
    const urls = skillsShSkillMdUrls({
      owner: "mattpocock",
      repo: "skills",
      skill: "research",
    });
    expect(urls.some((url) => url.includes("/skills/research/SKILL.md"))).toBe(true);
    expect(urls.some((url) => url.includes("/.agents/skills/research/SKILL.md"))).toBe(true);
  });
});

describe("parseSkillMarkdown", () => {
  it("strips frontmatter and uses name when present", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: research\ndescription: x\n---\n\nBody text here.",
      "fallback",
    );
    expect(parsed.id).toBe("research");
    expect(parsed.prompt).toBe("Body text here.");
  });

  it("falls back to the skill id from the path", () => {
    const parsed = parseSkillMarkdown("Just a body", "my-skill");
    expect(parsed.id).toBe("my-skill");
    expect(parsed.prompt).toBe("Just a body");
  });
});
