/**
 * Open issues for a named set of repos — the issue panel's read, shaped like
 * `openPrList` so the two forge reads share one repo vocabulary
 * (`selectPrProjects`, `repoAliases`) and one failure posture.
 *
 * Nothing degrades quietly: a repo no project answers to fails, a forge whose
 * provider cannot list issues fails by name, and a checkout that will not
 * resolve fails — a panel showing three issues instead of nine is
 * indistinguishable from three being the true answer.
 *
 * @module kanban/hermes/openIssueList
 */
import type { ForgeIssue, SourceControlProviderError } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import type { BoardProject } from "./boardApi.ts";
import { openPrLimit, selectPrProjects, type UnknownRepoError } from "./openPrList.ts";

/** An open issue plus where it came from — the panel spans repos. */
export type OpenIssueRow = Omit<ForgeIssue, "provider" | "state"> & {
  readonly projectId: string;
  /** The project's `owner/name`, or its remote URL when that is all there is. */
  readonly repo: string;
};

export interface OpenIssueQuery {
  /** One project by id. Mutually exclusive with `repos`. */
  readonly projectId?: string;
  /**
   * Repos to read, as `owner/name` or the bare name. Empty (or absent) is every
   * repo the board has a project for.
   */
  readonly repos?: ReadonlyArray<string>;
  /** Issues per repo. Default 20, max 50. */
  readonly limit?: number;
}

/** A forge whose provider has no issue read. Named, so it never reads as empty. */
export class IssuesUnsupportedError extends Data.TaggedError("IssuesUnsupportedError")<{
  readonly provider: string;
}> {
  override get message(): string {
    return `Listing issues is not supported for ${this.provider} yet.`;
  }
}

export interface OpenIssueDeps<E = never> {
  readonly projects: Effect.Effect<ReadonlyArray<BoardProject>, E>;
  readonly sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
}

/** Every open issue the query asks for, repo order preserved. */
export function listOpenIssues<E>(
  deps: OpenIssueDeps<E>,
  query: OpenIssueQuery,
): Effect.Effect<
  ReadonlyArray<OpenIssueRow>,
  E | UnknownRepoError | IssuesUnsupportedError | SourceControlProviderError
> {
  const limit = openPrLimit(query.limit);
  return Effect.gen(function* () {
    const projects = yield* deps.projects;
    const selected = yield* Effect.try({
      try: () => selectPrProjects(projects, query),
      catch: (cause) => cause as UnknownRepoError,
    });
    const rows: Array<OpenIssueRow> = [];
    for (const project of selected) {
      const cwd = project.workspaceRoot;
      // A project with no checkout has nothing to ask — empty when it has no
      // forge. One that does exist and will not resolve fails below.
      if (cwd === null || cwd.length === 0) continue;
      const provider = yield* deps.sourceControl.resolve({ cwd });
      if (provider.listIssues === undefined) {
        return yield* new IssuesUnsupportedError({ provider: provider.kind });
      }
      const issues = yield* provider.listIssues({ cwd, limit });
      for (const issue of issues) {
        if (issue.state !== "open") continue;
        rows.push({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          labels: issue.labels,
          projectId: project.id,
          repo: project.repo ?? cwd,
        });
      }
    }
    return rows;
  });
}
