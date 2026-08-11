import { describe, expect, it } from "@effect/vitest";

import type { BoardProject } from "./boardApi.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { makeProgramApi } from "./programApi.ts";
import {
  dropNestedWorkspaceAncestors,
  projectSlug,
  projectSlugs,
  resolveProjectId,
} from "./projectRouting.ts";
import { buildHermesSnapshotBlock, projectsBlock, type HermesSnapshot } from "./prompt.ts";
import type { RulePolicy } from "./rulePass.ts";

const policy: RulePolicy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: false,
  autoMergeWhenGreen: false,
  maxChecks: 2,
  maxSyncs: 2,
  prCheckGraceMs: 60_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  review: { enabled: false, prompt: "" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

const projects: ReadonlyArray<BoardProject> = [
  {
    id: "01948c6d-0000-7000-8000-000000000001",
    name: "vps code",
    workspaceRoot: "/root/projects/vps-code",
    repo: "Noisemaker111/vps-code",
  },
  {
    id: "01948c6d-0000-7000-8000-000000000002",
    name: "jg engine",
    workspaceRoot: "/root/projects/jgengine",
    repo: null,
  },
];

const snapshot = (partial: Partial<HermesSnapshot> = {}): HermesSnapshot => ({
  cards: [],
  projects,
  models: [],
  pendingInputs: [],
  policy: {},
  reports: [],
  threads: [],
  ...partial,
});

describe("projectSlug", () => {
  it("prefers the repo name, then the checkout basename", () => {
    expect(projectSlug(projects[0] as BoardProject)).toBe("vps-code");
    expect(projectSlug(projects[1] as BoardProject)).toBe("jgengine");
  });

  it("keeps two checkouts of one repo apart", () => {
    const slugs = projectSlugs([
      { id: "a", name: "one", workspaceRoot: "/root/one", repo: "own/dup" },
      { id: "b", name: "two", workspaceRoot: "/root/two", repo: "own/dup" },
    ]);
    expect([...slugs.values()]).toEqual(["dup", "dup-2"]);
  });
});

describe("projectsBlock", () => {
  it("leads with the slug and carries repo, root and id", () => {
    const lines = projectsBlock(snapshot()).split("\n");
    expect(lines[0]).toBe(
      "- vps-code repo=Noisemaker111/vps-code root=/root/projects/vps-code id=01948c6d-0000-7000-8000-000000000001",
    );
    expect(lines[1]).toBe(
      "- jgengine repo=- root=/root/projects/jgengine id=01948c6d-0000-7000-8000-000000000002",
    );
    expect(buildHermesSnapshotBlock(snapshot())).toContain("## PROJECTS\n\n- vps-code");
  });
});

describe("dropNestedWorkspaceAncestors", () => {
  const project = (id: string, workspaceRoot: string | null): BoardProject => ({
    id,
    name: id,
    workspaceRoot,
    repo: null,
  });
  const hit = (projectId: string) => ({ projectId });
  const kept = (
    hits: ReadonlyArray<{ projectId: string }>,
    all: ReadonlyArray<BoardProject>,
  ): ReadonlyArray<string> =>
    dropNestedWorkspaceAncestors(hits, all).map((entry) => entry.projectId);

  it("keeps the deeper checkout when one root holds the other", () => {
    const all = [project("parent", "/root/projects"), project("child", "/root/projects/vps-code")];
    expect(kept([hit("parent"), hit("child")], all)).toEqual(["child"]);
  });

  it("keeps only the deepest through three levels", () => {
    const all = [
      project("top", "/root"),
      project("mid", "/root/projects"),
      project("leaf", "/root/projects/vps-code"),
    ];
    expect(kept([hit("top"), hit("mid"), hit("leaf")], all)).toEqual(["leaf"]);
  });

  it("leaves genuine siblings ambiguous", () => {
    const all = [project("a", "/root/one"), project("b", "/root/two")];
    expect(kept([hit("a"), hit("b")], all)).toEqual(["a", "b"]);
  });

  it("resolves the live four-project layout to one project", () => {
    const all = [
      project("projects", "/root/projects"),
      project("jgengine", "/root/projects/jgengine"),
      project("agentgui", "/root/projects/AgentGui"),
      project("vps-code", "/root/projects/vps-code"),
    ];
    expect(kept([hit("projects"), hit("vps-code")], all)).toEqual(["vps-code"]);
    expect(kept([hit("projects"), hit("jgengine"), hit("agentgui"), hit("vps-code")], all)).toEqual(
      ["jgengine", "agentgui", "vps-code"],
    );
  });

  it("does not treat a shared name prefix as containment", () => {
    const all = [project("a", "/root/projects"), project("b", "/root/projects-other")];
    expect(kept([hit("a"), hit("b")], all)).toEqual(["a", "b"]);
  });

  it("nests nothing on equal, missing or relative roots", () => {
    const same = [project("a", "/root/projects/"), project("b", "/root/projects")];
    expect(kept([hit("a"), hit("b")], same)).toEqual(["a", "b"]);

    const missing = [project("a", null), project("b", "/root/projects/vps-code")];
    expect(kept([hit("a"), hit("b")], missing)).toEqual(["a", "b"]);

    const mixed = [project("a", "root/projects"), project("b", "/root/projects/vps-code")];
    expect(kept([hit("a"), hit("b")], mixed)).toEqual(["a", "b"]);
  });
});

describe("resolveProjectId", () => {
  it("takes a slug, a repo, a root or an id", () => {
    const id = projects[0]?.id;
    expect(resolveProjectId(projects, "vps-code")).toBe(id);
    expect(resolveProjectId(projects, "Noisemaker111/vps-code")).toBe(id);
    expect(resolveProjectId(projects, "/root/projects/vps-code")).toBe(id);
    expect(resolveProjectId(projects, id as string)).toBe(id);
  });

  it("refuses an ambiguous non-slug alias", () => {
    const duplicates: ReadonlyArray<BoardProject> = [
      { id: "b", name: "duplicate", workspaceRoot: "/two", repo: "owner/dup" },
      { id: "a", name: "duplicate", workspaceRoot: "/one", repo: "owner/dup" },
    ];
    expect([...projectSlugs(duplicates).entries()]).toEqual([
      ["a", "dup"],
      ["b", "dup-2"],
    ]);
    expect(resolveProjectId(duplicates, "duplicate")).toBeNull();
    expect(resolveProjectId(duplicates, "dup-2")).toBe("b");
  });

  it("refuses a plausible id nothing on the board has", () => {
    expect(resolveProjectId(projects, "01948c6d-0000-7000-8000-00000000ffff")).toBeNull();
    expect(resolveProjectId(projects, "")).toBeNull();
  });
});

describe("projectId validation at write time", () => {
  it("routes a card by slug and stores the id", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-1", body: "route me" })],
      projects: [...projects],
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    const result = await program.structureCard({ id: "card-1", projectId: "vps-code" });

    expect(result.ok).toBe(true);
    expect(state.cards[0]?.projectId).toBe(projects[0]?.id);
  });

  it("refuses a bogus projectId instead of launching it", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-1", body: "route me" })],
      projects: [...projects],
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    const result = await program.structureCard({
      id: "card-1",
      projectId: "01948c6d-0000-7000-8000-00000000ffff",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no project");
    expect(state.cards[0]?.projectId).toBeNull();
    expect(state.cards[0]?.prepStatus).toBe("untouched");
  });

  it("throws on a bogus projectId through updateCard and createCard", async () => {
    const { api } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "card-1" })],
      projects: [...projects],
    });
    const program = makeProgramApi({ api, policy, onNote: () => {} });

    await expect(program.updateCard({ id: "card-1", projectId: "nope" })).rejects.toThrow(
      /no project 'nope'/,
    );
    await expect(program.createCard({ title: "t", body: "b", projectId: "nope" })).rejects.toThrow(
      /no project 'nope'/,
    );
  });
});
