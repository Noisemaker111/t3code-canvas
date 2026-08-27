import { describe, expect, it } from "@effect/vitest";

import { BOARD_VERB_NAMES, buildBoardApiSurface, buildMcpApiSurface } from "./apiSurface.ts";
import { BOARD_METHODS } from "./executor.ts";
import { makeProgramApi } from "./programApi.ts";
import { buildHermesSystemPrompt } from "./prompt.ts";
import { makeFakeBoardApi } from "./fakeBoardApi.ts";

const policy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "review it" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

describe("buildBoardApiSurface", () => {
  it("declares every method the executor actually binds, and nothing it does not", () => {
    const surface = buildBoardApiSurface();
    const { api } = makeFakeBoardApi();
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    expect([...BOARD_VERB_NAMES].sort()).toEqual(Object.keys(program).sort());
    // The gap that made readCanvas/drawOnCanvas throw at runtime: the prompt
    // advertised them and the prelude never bound them.
    expect([...BOARD_METHODS].sort()).toEqual(Object.keys(program).sort());
    for (const method of Object.keys(program)) {
      expect(surface, `missing ${method}`).toContain(`${method}(`);
    }
  });

  it("keeps the mechanical calls the rules own off the model's surface", () => {
    const surface = buildBoardApiSurface();

    for (const gone of [
      "heartbeat(",
      "openPr(",
      "mergePr(",
      "syncPrBranch(",
      "restorePrWorktree(",
      "list()",
    ]) {
      expect(surface, `${gone} should be gone`).not.toContain(gone);
    }
  });

  it("stays small enough to send on every tick", () => {
    // A verb costs about 600 characters of prompt on every tick, forever, so
    // this ceiling is meant to be argued with before it is raised. It went up
    // once for searchProjects and once for askHelper, each of which fit under
    // the old number alone — two branches adding a verb is exactly the case
    // this test cannot catch until they land together. It went up a third time
    // for reply(), which is what makes the panel answer a question at all,
    // and a fourth for closePr(), the verb that made "close a PR" durably
    // completable instead of an archive-only no-op the forge never saw. askUser
    // is the deliberate fifth increase: it turns unresolved intent into a
    // durable clarification instead of an unrouted status line.
    expect(buildBoardApiSurface().length).toBeLessThan(10_000);
  });
});

describe("buildHermesSystemPrompt", () => {
  it("asks for one program and seals the sandbox in the same breath", () => {
    const prompt = buildHermesSystemPrompt();

    expect(prompt).toContain("ONE JavaScript program");
    expect(prompt).toContain("No require, no import, no fetch, no process");
    expect(prompt).toContain("declare const board");
  });

  it("stops re-teaching the merge dance the runtime now owns", () => {
    const prompt = buildHermesSystemPrompt();

    expect(prompt).not.toContain("syncPrBranch once and retry");
    expect(prompt).toContain("NEEDS A DECISION");
    expect(prompt).toContain("askUser once");
    expect(prompt).toContain("Never a helper to guess intent");
    expect(prompt).toContain("completes that card's decision now");
  });
});

describe("searchProjects", () => {
  it("answers which project owns a path, so routing is a lookup", async () => {
    const { api } = makeFakeBoardApi({
      projects: [
        { id: "proj-jg", name: "jgengine", workspaceRoot: "/root/jgengine", repo: "own/jgengine" },
        { id: "proj-vps", name: "vps-code", workspaceRoot: "/root/vps-code", repo: "own/vps-code" },
      ],
      projectFiles: {
        "proj-jg": ["src/renderer.cpp"],
        "proj-vps": ["deploy/apply.sh", "docs/HERMES.md"],
      },
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    const found = await program.searchProjects({ query: "deploy/apply.sh" });

    expect(found.projects.map((hit) => hit.projectId)).toEqual(["proj-vps"]);
    expect(found.projects[0]?.hits).toBe(1);
    expect(found.ambiguous).toBe(false);
  });

  it("routes past a project rooted at the parent of the others", async () => {
    const { api } = makeFakeBoardApi({
      projects: [
        { id: "proj-all", name: "projects", workspaceRoot: "/root/projects", repo: null },
        {
          id: "proj-jg",
          name: "jgengine",
          workspaceRoot: "/root/projects/jgengine",
          repo: "own/jgengine",
        },
        {
          id: "proj-gui",
          name: "AgentGui",
          workspaceRoot: "/root/projects/AgentGui",
          repo: "own/AgentGui",
        },
        {
          id: "proj-vps",
          name: "vps-code",
          workspaceRoot: "/root/projects/vps-code",
          repo: "own/vps-code",
        },
      ],
      projectFiles: {
        "proj-all": ["vps-code/deploy/apply.sh", "jgengine/src/renderer.cpp"],
        "proj-jg": ["src/renderer.cpp"],
        "proj-gui": ["src/app.tsx"],
        "proj-vps": ["deploy/apply.sh"],
      },
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    const found = await program.searchProjects({ query: "deploy/apply.sh" });

    expect(found.projects.map((hit) => hit.projectId)).toEqual(["proj-vps"]);
    expect(found.ambiguous).toBe(false);
  });

  it("flags a path two checkouts both have, so nothing is guessed", async () => {
    const { api } = makeFakeBoardApi({
      projects: [
        { id: "proj-a", name: "one", workspaceRoot: "/root/one", repo: "own/one" },
        { id: "proj-b", name: "two", workspaceRoot: "/root/two", repo: "own/two" },
      ],
      projectFiles: {
        "proj-a": ["src/index.ts"],
        "proj-b": ["src/index.ts"],
      },
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    const found = await program.searchProjects({ query: "src/index.ts" });

    expect(found.ambiguous).toBe(true);
    expect(found.projects).toHaveLength(2);
  });
});

describe("buildMcpApiSurface", () => {
  const toolset = {
    servers: [
      {
        name: "docs",
        tools: [
          {
            name: "search",
            description: "Search   the docs\nby query",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "number" },
                mode: { enum: ["fast", "thorough"] },
                filters: { type: "array", items: { type: "string" } },
              },
              required: ["query"],
            },
          },
          { name: "fetch-page", description: "", inputSchema: { type: "object" } },
        ],
      },
    ],
    unavailable: [],
  };

  it("generates the tool signatures from the advertised JSON schemas", () => {
    const surface = buildMcpApiSurface(toolset);

    expect(surface).toContain("declare const mcp: {");
    expect(surface).toContain("docs: {");
    expect(surface).toContain(
      'search(input: { query: string; limit?: number; mode?: "fast" | "thorough"; filters?: string[] }): Promise<unknown>;',
    );
    expect(surface).toContain("/** Search the docs by query */");
    expect(surface).toContain('"fetch-page"(input: Record<string, unknown>): Promise<unknown>;');
  });

  it("keeps MCP tools out of the board namespace", () => {
    const surface = buildMcpApiSurface(toolset);

    expect(surface).not.toContain("board");
    expect(buildBoardApiSurface()).not.toContain("mcp.");
  });

  it("names a server that would not connect instead of dropping it", () => {
    const surface = buildMcpApiSurface({
      servers: [],
      unavailable: [{ name: "docs", reason: "ECONNREFUSED" }],
    });

    expect(surface).toContain("UNAVAILABLE: mcp.docs did not connect — ECONNREFUSED");
    expect(surface).not.toContain("declare const mcp");
  });

  it("is empty when nothing is configured", () => {
    expect(buildMcpApiSurface({ servers: [], unavailable: [] })).toBe("");
  });
});
