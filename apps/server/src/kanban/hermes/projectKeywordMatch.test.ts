import { describe, expect, it } from "vite-plus/test";

import {
  extractPromptKeywords,
  keywordMatchEvidence,
  rankProjectsByPromptKeywords,
} from "./projectKeywordMatch.ts";

describe("extractPromptKeywords", () => {
  it("drops stop words and short noise", () => {
    expect(extractPromptKeywords("Fix the kanban board merge loop please")).toEqual(
      expect.arrayContaining(["kanban", "board", "merge", "loop"]),
    );
    expect(extractPromptKeywords("Fix the kanban board merge loop please")).not.toContain("the");
  });
});

describe("rankProjectsByPromptKeywords", () => {
  const projects = [
    {
      id: "p-vps",
      name: "vps-code",
      slug: "vps-code",
      workspaceRoot: "/root/projects/vps-code",
      repo: "Noisemaker111/vps-code",
    },
    {
      id: "p-jg",
      name: "jgengine",
      slug: "jgengine",
      workspaceRoot: "/root/projects/jgengine",
      repo: null,
    },
    {
      id: "p-gui",
      name: "AgentGui",
      slug: "agentgui",
      workspaceRoot: "/root/projects/AgentGui",
      repo: null,
    },
  ];

  it("picks the only project that owns an obvious token", () => {
    const hits = rankProjectsByPromptKeywords({
      title: "Kanban board camera restore",
      body: "When I close a station the kanban camera jumps.",
      projects,
    });
    // vps-code path/name may not contain kanban — only if we add a kanban-named project.
    // Prefer: if only jgengine matches nothing, hits empty is fine.
    const withKanban = [
      ...projects,
      {
        id: "p-board",
        name: "board-kanban",
        slug: "board-kanban",
        workspaceRoot: "/tmp/kanban-lab",
        repo: null,
      },
    ];
    const ranked = rankProjectsByPromptKeywords({
      title: "Kanban board camera restore",
      body: "When I close a station the kanban camera jumps.",
      projects: withKanban,
    });
    expect(ranked[0]?.projectId).toBe("p-board");
    expect(ranked[0]?.matched).toContain("kanban");
    expect(keywordMatchEvidence(ranked[0])).toContain("keyword hits:");
  });

  it("matches vps-code when the prompt names the product", () => {
    const hits = rankProjectsByPromptKeywords({
      title: "Fix hermes in vps-code",
      body: "Ship a fix for the Hermes brain on the vps-code box.",
      projects,
    });
    expect(hits[0]?.projectId).toBe("p-vps");
  });

  it("returns empty when nothing matches", () => {
    expect(
      rankProjectsByPromptKeywords({
        title: "xyzzy plugh",
        body: "no project tokens here at all",
        projects,
      }),
    ).toEqual([]);
  });
});
