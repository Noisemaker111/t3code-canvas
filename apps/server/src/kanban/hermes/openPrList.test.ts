import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BoardProject } from "./boardApi.ts";
import {
  listOpenPrs,
  openPrLimit,
  repoAliases,
  selectPrProjects,
  UnknownRepoError,
} from "./openPrList.ts";

const projects: ReadonlyArray<BoardProject> = [
  { id: "p1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: "Noisemaker111/vps-code" },
  { id: "p2", name: "t3code", workspaceRoot: "/root/t3code", repo: "pingdotgg/t3code" },
  { id: "p3", name: "scratch", workspaceRoot: "/root/scratch", repo: null },
];

describe("selectPrProjects", () => {
  it("reads every repo the board has when no repo is named", () => {
    expect(selectPrProjects(projects, {}).map((project) => project.id)).toEqual(["p1", "p2"]);
  });

  it("matches a repo by slug or by bare name, once each", () => {
    expect(
      selectPrProjects(projects, { repos: ["pingdotgg/t3code", "t3code", "VPS-CODE"] }).map(
        (project) => project.id,
      ),
    ).toEqual(["p2", "p1"]);
  });

  it("refuses a repo nothing on the board answers to", () => {
    expect(() => selectPrProjects(projects, { repos: ["t3code", "someone/else"] })).toThrow(
      UnknownRepoError,
    );
  });

  it("keeps the one-project query exact", () => {
    expect(selectPrProjects(projects, { projectId: "p2" }).map((project) => project.id)).toEqual([
      "p2",
    ]);
    expect(selectPrProjects(projects, { projectId: "nope" })).toEqual([]);
  });

  it("ignores blank entries rather than failing on them", () => {
    expect(selectPrProjects(projects, { repos: ["  ", ""] }).map((project) => project.id)).toEqual([
      "p1",
      "p2",
    ]);
  });
});

describe("repoAliases", () => {
  it("answers to the slug and the name", () => {
    expect(repoAliases("Owner/Repo")).toEqual(["owner/repo", "repo"]);
    expect(repoAliases("repo")).toEqual(["repo"]);
  });
});

describe("openPrLimit", () => {
  it("clamps to the forge-friendly band", () => {
    expect(openPrLimit(undefined)).toBe(20);
    expect(openPrLimit(0)).toBe(1);
    expect(openPrLimit(500)).toBe(50);
  });
});

const changeRequest = (number: number, cwd: string, updatedAt?: string) => ({
  provider: "github" as const,
  number,
  title: `pr ${number}`,
  url: `https://forge/${cwd}/${number}`,
  headRefName: `head-${number}`,
  baseRefName: "main",
  state: "open" as const,
  updatedAt: updatedAt === undefined ? Option.none() : Option.some(DateTime.makeUnsafe(updatedAt)),
});

function fakeSourceControl(
  byCwd: Record<string, ReadonlyArray<unknown>>,
  getChecks?: (reference: string) => Effect.Effect<{
    readonly state: "passing" | "failing" | "pending" | "unknown";
    readonly failing: ReadonlyArray<{ readonly name: string; readonly url: string | null }>;
    readonly counts: {
      readonly total: number;
      readonly passing: number;
      readonly failing: number;
      readonly pending: number;
    };
  }>,
) {
  return {
    resolve: ({ cwd }: { cwd: string }) =>
      Effect.succeed({
        kind: "github",
        listChangeRequests: () => Effect.succeed(byCwd[cwd] ?? []),
        ...(getChecks
          ? {
              getChangeRequestChecks: ({ reference }: { reference: string }) =>
                getChecks(reference),
            }
          : {}),
      }),
  } as never;
}

describe("listOpenPrs", () => {
  it.effect("stamps every row with the project and repo it came from", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenPrs(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({
            "/root/vps-code": [changeRequest(1, "vps"), changeRequest(2, "vps")],
            "/root/t3code": [changeRequest(9, "t3")],
          }),
        },
        { repos: ["vps-code", "t3code"] },
      );
      expect(rows.map((row) => [row.number, row.projectId, row.repo])).toEqual([
        [1, "p1", "Noisemaker111/vps-code"],
        [2, "p1", "Noisemaker111/vps-code"],
        [9, "p2", "pingdotgg/t3code"],
      ]);
    }),
  );

  it.effect("drops what the forge reports as no longer open", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenPrs(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({
            "/root/vps-code": [
              { ...changeRequest(1, "vps"), state: "merged" },
              changeRequest(3, "vps"),
            ],
          }),
        },
        { projectId: "p1" },
      );
      expect(rows.map((row) => row.number)).toEqual([3]);
    }),
  );

  it.effect("attaches the forge's real CI verdict to project PR metadata", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenPrs(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({ "/root/vps-code": [changeRequest(249, "vps")] }, () =>
            Effect.succeed({
              state: "failing",
              failing: [{ name: "server/web typecheck gate", url: "https://forge/run/1" }],
              counts: { total: 6, passing: 5, failing: 1, pending: 0 },
            }),
          ),
        },
        { projectId: "p1" },
      );

      expect(rows[0]?.projectId).toBe("p1");
      expect(rows[0]?.checks.state).toBe("failing");
      expect(rows[0]?.checks.failing[0]?.name).toBe("server/web typecheck gate");
    }),
  );

  it.effect("carries the forge's own last-activity stamp, or null when it gave none", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenPrs(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({
            "/root/vps-code": [
              changeRequest(1, "vps", "2026-08-03T00:00:00Z"),
              changeRequest(2, "vps"),
            ],
          }),
        },
        { projectId: "p1" },
      );

      const first = rows[0]?.updatedAt ?? null;
      expect(first === null ? null : DateTime.formatIso(first)).toBe("2026-08-03T00:00:00.000Z");
      expect(rows[1]?.updatedAt).toBeNull();
    }),
  );

  it.effect("fails on an unknown repo instead of answering with the ones it found", () =>
    Effect.gen(function* () {
      const result = yield* listOpenPrs(
        { projects: Effect.succeed(projects), sourceControl: fakeSourceControl({}) },
        { repos: ["vps-code", "ghost/repo"] },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
});
