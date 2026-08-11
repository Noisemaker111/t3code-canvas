import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { BoardProject } from "./boardApi.ts";
import { IssuesUnsupportedError, listOpenIssues } from "./openIssueList.ts";

const projects: ReadonlyArray<BoardProject> = [
  { id: "p1", name: "vps-code", workspaceRoot: "/root/vps-code", repo: "Noisemaker111/vps-code" },
  { id: "p2", name: "t3code", workspaceRoot: "/root/t3code", repo: "pingdotgg/t3code" },
  { id: "p3", name: "scratch", workspaceRoot: "/root/scratch", repo: null },
];

const issue = (number: number, state: "open" | "closed" = "open") => ({
  provider: "github" as const,
  number,
  title: `issue ${number}`,
  url: `https://forge/issues/${number}`,
  state,
  labels: ["bug"],
});

function fakeSourceControl(byCwd: Record<string, ReadonlyArray<unknown>>) {
  return {
    resolve: ({ cwd }: { cwd: string }) =>
      Effect.succeed({
        kind: "github",
        listIssues: () => Effect.succeed(byCwd[cwd] ?? []),
      }),
  } as never;
}

describe("listOpenIssues", () => {
  it.effect("stamps every row with the project and repo it came from", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenIssues(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({
            "/root/vps-code": [issue(1), issue(2)],
            "/root/t3code": [issue(9)],
          }),
        },
        { repos: ["vps-code", "t3code"] },
      );
      expect(rows.map((row) => [row.number, row.projectId, row.repo])).toEqual([
        [1, "p1", "Noisemaker111/vps-code"],
        [2, "p1", "Noisemaker111/vps-code"],
        [9, "p2", "pingdotgg/t3code"],
      ]);
      expect(rows[0]?.labels).toEqual(["bug"]);
    }),
  );

  it.effect("drops what the forge reports as no longer open", () =>
    Effect.gen(function* () {
      const rows = yield* listOpenIssues(
        {
          projects: Effect.succeed(projects),
          sourceControl: fakeSourceControl({
            "/root/vps-code": [issue(1, "closed"), issue(3)],
          }),
        },
        { repos: ["vps-code"] },
      );
      expect(rows.map((row) => row.number)).toEqual([3]);
    }),
  );

  it.effect("fails on an unknown repo instead of answering with the ones it found", () =>
    Effect.gen(function* () {
      const result = yield* listOpenIssues(
        { projects: Effect.succeed(projects), sourceControl: fakeSourceControl({}) },
        { repos: ["vps-code", "ghost/repo"] },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("fails by name on a forge whose provider cannot list issues", () =>
    Effect.gen(function* () {
      const sourceControl = {
        resolve: () => Effect.succeed({ kind: "gitlab" }),
      } as never;
      const result = yield* listOpenIssues(
        { projects: Effect.succeed(projects), sourceControl },
        { repos: ["vps-code"] },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(IssuesUnsupportedError);
        expect(String(result.failure)).toContain("gitlab");
      }
    }),
  );
});
